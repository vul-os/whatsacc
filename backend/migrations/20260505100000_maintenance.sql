-- 20260505100000_maintenance.sql
-- Maintenance tracking for access points: cumulative meters, service events
-- log, and a derived next-due timestamp.
--
-- Each access_logs insert advances the per-access-point meter using the gate
-- movement constant from location_settings (meters per op). Service events
-- snapshot the meter at service time and set a threshold for the next.

CREATE TABLE access_point_meters (
    access_point_id uuid PRIMARY KEY REFERENCES access_points(id) ON DELETE CASCADE,
    movement_m numeric(14,2) NOT NULL DEFAULT 0,
    total_opens int NOT NULL DEFAULT 0,
    total_closes int NOT NULL DEFAULT 0,
    last_op_at timestamptz NULL,
    last_serviced_at timestamptz NULL,
    last_service_movement_m numeric(14,2) NULL,
    next_due_movement_m numeric(14,2) NULL,
    next_due_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE access_point_meters IS 'Live cumulative wear meters per access point. Updated by trigger on access_logs.';

CREATE TABLE maintenance_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    access_point_id uuid NOT NULL REFERENCES access_points(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('inspection','service','repair','replacement')),
    performed_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    performed_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    technician_name text NULL,
    notes text NULL,
    parts jsonb NOT NULL DEFAULT '[]'::jsonb,
    cost_zar_cents bigint NULL,
    -- Snapshot of the wear meter at the moment of service. Lets us compute
    -- the *next* due date based on historical pace.
    movement_m_at_event numeric(14,2) NULL,
    -- Threshold for the next service, expressed both as a movement target
    -- and a calendar fallback. The earlier of the two wins.
    next_due_movement_m numeric(14,2) NULL,
    next_due_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE maintenance_events IS 'Append-only log of inspections / services / repairs / replacements per access point.';
CREATE INDEX maintenance_events_access_point_id_performed_at_idx
    ON maintenance_events (access_point_id, performed_at DESC);
CREATE INDEX maintenance_events_kind_idx ON maintenance_events (kind);

-- Bootstrap one meters row per existing access_point.
INSERT INTO access_point_meters (access_point_id)
SELECT id FROM access_points
ON CONFLICT (access_point_id) DO NOTHING;

-- Auto-create the meters row for new access points.
CREATE OR REPLACE FUNCTION app.access_points_init_meters()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO access_point_meters (access_point_id)
    VALUES (NEW.id)
    ON CONFLICT (access_point_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS access_points_init_meters_trg ON access_points;
CREATE TRIGGER access_points_init_meters_trg
AFTER INSERT ON access_points
FOR EACH ROW EXECUTE FUNCTION app.access_points_init_meters();

-- Advance the meter for every successful open/close. Pulls movement constant
-- from location_settings, falling back to a default if none is configured.
CREATE OR REPLACE FUNCTION app.access_logs_advance_meter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    move_per_op numeric(8,2);
BEGIN
    IF NEW.access_point_id IS NULL OR NOT NEW.success THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(ls.gate_movement_m_per_op, 3.5)
      INTO move_per_op
      FROM access_points ap
      LEFT JOIN location_settings ls ON ls.location_id = ap.location_id
      WHERE ap.id = NEW.access_point_id;

    IF move_per_op IS NULL THEN
        move_per_op := 3.5;
    END IF;

    INSERT INTO access_point_meters (access_point_id, movement_m, total_opens, total_closes, last_op_at)
    VALUES (
        NEW.access_point_id,
        move_per_op,
        CASE WHEN NEW.command = 'open' THEN 1 ELSE 0 END,
        CASE WHEN NEW.command = 'close' THEN 1 ELSE 0 END,
        NEW.ts
    )
    ON CONFLICT (access_point_id) DO UPDATE SET
        movement_m   = access_point_meters.movement_m + EXCLUDED.movement_m,
        total_opens  = access_point_meters.total_opens + EXCLUDED.total_opens,
        total_closes = access_point_meters.total_closes + EXCLUDED.total_closes,
        last_op_at   = GREATEST(access_point_meters.last_op_at, EXCLUDED.last_op_at),
        updated_at   = now();

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS access_logs_advance_meter_trg ON access_logs;
CREATE TRIGGER access_logs_advance_meter_trg
AFTER INSERT ON access_logs
FOR EACH ROW EXECUTE FUNCTION app.access_logs_advance_meter();

-- After a maintenance event, snapshot the current meter into the access point
-- meters row and adopt the event's next-due thresholds.
CREATE OR REPLACE FUNCTION app.maintenance_events_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    current_movement numeric(14,2);
BEGIN
    SELECT movement_m INTO current_movement
      FROM access_point_meters
      WHERE access_point_id = NEW.access_point_id;

    IF current_movement IS NULL THEN
        INSERT INTO access_point_meters (access_point_id) VALUES (NEW.access_point_id);
        current_movement := 0;
    END IF;

    -- If the caller didn't snapshot a meter reading, use the live one.
    IF NEW.movement_m_at_event IS NULL THEN
        UPDATE maintenance_events
            SET movement_m_at_event = current_movement
            WHERE id = NEW.id;
        NEW.movement_m_at_event := current_movement;
    END IF;

    -- 'service' / 'repair' / 'replacement' reset the wear baseline; pure
    -- inspections do not.
    IF NEW.kind IN ('service','repair','replacement') THEN
        UPDATE access_point_meters SET
            last_serviced_at        = NEW.performed_at,
            last_service_movement_m = NEW.movement_m_at_event,
            next_due_movement_m     = NEW.next_due_movement_m,
            next_due_at             = NEW.next_due_at,
            updated_at              = now()
        WHERE access_point_id = NEW.access_point_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS maintenance_events_after_insert_trg ON maintenance_events;
CREATE TRIGGER maintenance_events_after_insert_trg
AFTER INSERT ON maintenance_events
FOR EACH ROW EXECUTE FUNCTION app.maintenance_events_after_insert();

-- RLS: meters readable by any account member, writable only by the trigger
-- (i.e. nobody — system-managed). Maintenance events: members read, admins write.
ALTER TABLE access_point_meters ENABLE ROW LEVEL SECURITY;
CREATE POLICY access_point_meters_member ON access_point_meters
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM access_points ap
            JOIN locations l ON l.id = ap.location_id
            WHERE ap.id = access_point_meters.access_point_id
              AND app.is_account_member(l.account_id)
        )
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );

ALTER TABLE maintenance_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY maintenance_events_select ON maintenance_events
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM access_points ap
            JOIN locations l ON l.id = ap.location_id
            WHERE ap.id = maintenance_events.access_point_id
              AND app.is_account_member(l.account_id)
        )
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY maintenance_events_write ON maintenance_events
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM access_points ap
            JOIN locations l ON l.id = ap.location_id
            WHERE ap.id = maintenance_events.access_point_id
              AND app.is_account_admin(l.account_id)
        )
    );
CREATE POLICY maintenance_events_update ON maintenance_events
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM access_points ap
            JOIN locations l ON l.id = ap.location_id
            WHERE ap.id = maintenance_events.access_point_id
              AND app.is_account_admin(l.account_id)
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM access_points ap
            JOIN locations l ON l.id = ap.location_id
            WHERE ap.id = maintenance_events.access_point_id
              AND app.is_account_admin(l.account_id)
        )
    );
