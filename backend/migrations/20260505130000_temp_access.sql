-- 20260505130000_temp_access.sql
-- Temporary access grants. A WhatsApp number can be authorised to operate one
-- or more access points for a defined time window, with an optional cap on
-- the number of uses. Membership of a registered user is NOT required — the
-- grant is keyed on the phone number itself.

CREATE TABLE temporary_access_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    granted_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
    visitor_name text NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    max_uses int NULL CHECK (max_uses IS NULL OR max_uses >= 1),
    uses_count int NOT NULL DEFAULT 0,
    -- User-controlled state. Derived states (pending / expired / exhausted)
    -- are computed at read time from starts_at / ends_at / uses_count.
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    revoked_at timestamptz NULL,
    revoked_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    notes text NULL,
    last_used_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    CHECK (ends_at > starts_at)
);
COMMENT ON TABLE temporary_access_grants
    IS 'Time-bounded access for a WhatsApp phone number to one or more access points.';
CREATE INDEX temporary_access_grants_account_id_idx
    ON temporary_access_grants (account_id);
CREATE INDEX temporary_access_grants_phone_idx
    ON temporary_access_grants (phone_e164);
CREATE INDEX temporary_access_grants_active_window_idx
    ON temporary_access_grants (status, starts_at, ends_at);

CREATE TABLE temporary_access_grant_access_points (
    grant_id uuid NOT NULL REFERENCES temporary_access_grants(id) ON DELETE CASCADE,
    access_point_id uuid NOT NULL REFERENCES access_points(id) ON DELETE CASCADE,
    PRIMARY KEY (grant_id, access_point_id)
);
COMMENT ON TABLE temporary_access_grant_access_points
    IS 'Many-to-many: a grant covers one or more access points.';
CREATE INDEX temporary_access_grant_access_points_ap_idx
    ON temporary_access_grant_access_points (access_point_id);

-- Atomic consume: returns the grant id on success, NULL otherwise.
-- Locks the row for update and increments uses_count + last_used_at if the
-- grant is currently usable for the supplied access point. Used by the
-- WhatsApp inbound flow so the cap can't be raced past.
CREATE OR REPLACE FUNCTION app.try_consume_grant(
    in_phone text,
    in_access_point_id uuid,
    in_ts timestamptz DEFAULT timezone('utc', now())
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    target_grant uuid;
BEGIN
    SELECT g.id INTO target_grant
    FROM temporary_access_grants g
    JOIN temporary_access_grant_access_points t
      ON t.grant_id = g.id AND t.access_point_id = in_access_point_id
    WHERE g.phone_e164 = in_phone
      AND g.status = 'active'
      AND g.starts_at <= in_ts
      AND g.ends_at > in_ts
      AND (g.max_uses IS NULL OR g.uses_count < g.max_uses)
    ORDER BY g.ends_at ASC
    LIMIT 1
    FOR UPDATE OF g;

    IF target_grant IS NULL THEN
        RETURN NULL;
    END IF;

    UPDATE temporary_access_grants
    SET uses_count = uses_count + 1,
        last_used_at = in_ts,
        updated_at = now()
    WHERE id = target_grant;

    RETURN target_grant;
END;
$$;

-- RLS: account members read; admins write/revoke. Anon (system, e.g. WA
-- engine) is allowed via current_user_id IS NULL paths.
ALTER TABLE temporary_access_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY temporary_access_grants_select ON temporary_access_grants
    FOR SELECT
    USING (
        app.is_account_member(account_id)
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY temporary_access_grants_insert ON temporary_access_grants
    FOR INSERT
    WITH CHECK (
        app.is_account_admin(account_id)
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY temporary_access_grants_update ON temporary_access_grants
    FOR UPDATE
    USING (
        app.is_account_admin(account_id)
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    )
    WITH CHECK (
        app.is_account_admin(account_id)
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY temporary_access_grants_delete ON temporary_access_grants
    FOR DELETE
    USING (
        app.is_account_admin(account_id)
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );

ALTER TABLE temporary_access_grant_access_points ENABLE ROW LEVEL SECURITY;
CREATE POLICY temporary_access_grant_access_points_select
    ON temporary_access_grant_access_points
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM temporary_access_grants g
            WHERE g.id = grant_id
              AND (
                app.is_account_member(g.account_id)
                OR app.current_user_id() IS NULL
                OR app.is_platform_admin()
              )
        )
    );
CREATE POLICY temporary_access_grant_access_points_write
    ON temporary_access_grant_access_points
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM temporary_access_grants g
            WHERE g.id = grant_id
              AND (
                app.is_account_admin(g.account_id)
                OR app.current_user_id() IS NULL
                OR app.is_platform_admin()
              )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM temporary_access_grants g
            WHERE g.id = grant_id
              AND (
                app.is_account_admin(g.account_id)
                OR app.current_user_id() IS NULL
                OR app.is_platform_admin()
              )
        )
    );
