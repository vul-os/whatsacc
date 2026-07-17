-- 20260505010000_rate_limits.sql
-- Abuse-protection rate limits + admin-configured usage quotas.
--
-- Strictly NON-MONETARY: whatsacc has no billing. These are physical-access
-- abuse guards (cooldowns / hourly caps) plus optional per-location policy
-- caps that admins configure ("the cleaner can open 4x per day").
--
--   1. rate_limit_counters — fixed-window counters keyed (scope, subject,
--      window_start). INTERNAL table: RLS is enabled + forced with NO
--      policies, so no request role (whatsacc_app) can touch rows directly.
--      All access goes through the SECURITY DEFINER app.rate_limit_*
--      functions owned by whatsacc_internal (BYPASSRLS), mirroring the
--      baseline's meters / try_consume_grant machinery.
--   2. location_settings gains two nullable quota columns. NULL = unlimited.

-- ============================================================================
-- Counters
-- ============================================================================

CREATE TABLE rate_limit_counters (
    -- Namespace of the counter, e.g. 'opens_1h', 'acct_opens_1h',
    -- 'opens_1d', 'loc_opens_1d', 'chat_1m', 'open_cd'.
    scope text NOT NULL,
    -- Composite subject key, e.g. 'user:<uuid>', 'phone:+27821234567',
    -- 'acct:<uuid>', 'loc:<uuid>', 'user:<uuid>|ap:<uuid>'.
    subject text NOT NULL,
    -- Fixed-window start (UTC epoch-aligned). The cooldown scope uses the
    -- sentinel to_timestamp(0) and tracks the last event in updated_at.
    window_start timestamptz NOT NULL,
    count int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, subject, window_start)
);
COMMENT ON TABLE rate_limit_counters
    IS 'Internal fixed-window abuse counters. No RLS policies on purpose — access only via app.rate_limit_* SECURITY DEFINER functions.';

-- Internal-only: enable + force RLS and define NO policies. Every request
-- role (including the table owner, minus BYPASSRLS roles) is default-denied.
ALTER TABLE rate_limit_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_counters FORCE ROW LEVEL SECURITY;

-- Table privileges still required for whatsacc_internal (BYPASSRLS) which
-- owns the accessor functions. Default privileges from the baseline should
-- already cover this; explicit grants keep it robust.
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_counters TO whatsacc_internal;
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_counters TO whatsacc_app;

-- ============================================================================
-- Location quotas (admin policy, off by default)
-- ============================================================================

ALTER TABLE location_settings
    ADD COLUMN max_opens_per_member_per_day int NULL
        CHECK (max_opens_per_member_per_day IS NULL OR max_opens_per_member_per_day >= 1),
    ADD COLUMN max_opens_per_location_per_day int NULL
        CHECK (max_opens_per_location_per_day IS NULL OR max_opens_per_location_per_day >= 1);

COMMENT ON COLUMN location_settings.max_opens_per_member_per_day
    IS 'Optional policy cap: successful opens per member (or visitor phone) per UTC day at this location. NULL = unlimited. Account owners/admins are exempt.';
COMMENT ON COLUMN location_settings.max_opens_per_location_per_day
    IS 'Optional policy cap: total successful opens per UTC day across the whole location. NULL = unlimited. Account owners/admins are exempt.';

-- ============================================================================
-- Accessor functions (SECURITY DEFINER, owned by whatsacc_internal)
-- ============================================================================

-- Atomic upsert-increment. Returns the post-increment count for the window.
-- When a NEW window row is created, opportunistically prunes a bounded batch
-- of stale windows (older than 2 days) for the same scope — the epoch
-- sentinel rows used by cooldown tracking are preserved.
CREATE OR REPLACE FUNCTION app.rate_limit_bump(
    in_scope text,
    in_subject text,
    in_window_start timestamptz,
    in_amount int DEFAULT 1
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    new_count int;
    inserted boolean;
BEGIN
    INSERT INTO rate_limit_counters (scope, subject, window_start, count)
    VALUES (in_scope, in_subject, in_window_start, in_amount)
    ON CONFLICT (scope, subject, window_start) DO UPDATE
        SET count = rate_limit_counters.count + in_amount,
            updated_at = now()
    RETURNING count, (xmax = 0) INTO new_count, inserted;

    IF inserted THEN
        DELETE FROM rate_limit_counters
        WHERE ctid IN (
            SELECT ctid FROM rate_limit_counters
            WHERE scope = in_scope
              AND window_start < now() - interval '2 days'
              AND window_start > to_timestamp(0)  -- keep cooldown sentinels
            LIMIT 50
        );
    END IF;

    RETURN new_count;
END;
$$;

-- Read the current count for a window (0 when no row exists).
CREATE OR REPLACE FUNCTION app.rate_limit_get(
    in_scope text,
    in_subject text,
    in_window_start timestamptz
)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((
        SELECT count FROM rate_limit_counters
        WHERE scope = in_scope AND subject = in_subject AND window_start = in_window_start
    ), 0);
$$;

-- Read the last-event time for a cooldown subject (sentinel window row's
-- updated_at). NULL when the subject has never been bumped.
CREATE OR REPLACE FUNCTION app.rate_limit_last(
    in_scope text,
    in_subject text
)
RETURNS timestamptz
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT updated_at FROM rate_limit_counters
    WHERE scope = in_scope AND subject = in_subject AND window_start = to_timestamp(0);
$$;

-- Hand ownership to the BYPASSRLS internal role (baseline pattern) so the
-- functions can cross the policy-less FORCEd RLS on rate_limit_counters.
ALTER FUNCTION app.rate_limit_bump(text, text, timestamptz, int) OWNER TO whatsacc_internal;
ALTER FUNCTION app.rate_limit_get(text, text, timestamptz)       OWNER TO whatsacc_internal;
ALTER FUNCTION app.rate_limit_last(text, text)                   OWNER TO whatsacc_internal;

GRANT EXECUTE ON FUNCTION app.rate_limit_bump(text, text, timestamptz, int) TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.rate_limit_get(text, text, timestamptz)       TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.rate_limit_last(text, text)                   TO PUBLIC;
