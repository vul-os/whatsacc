-- 20260505030000_rate_limit_hardening.sql
-- Hardening of the rate-limit counter machinery (adversarial review
-- 2026-07-17). New migration on purpose: 20260505010000 may already be
-- applied elsewhere, so history is never edited.
--
--   1. PRIVILEGES: app.rate_limit_bump/get/last were EXECUTE-granted to
--      PUBLIC. They are SECURITY DEFINER owned by lintel_internal
--      (BYPASSRLS), so ANY database role could forge or read arbitrary
--      counters. REVOKE from PUBLIC and grant only the roles that actually
--      run them: lintel_app — the request-path role (withRLS does
--      SET LOCAL ROLE lintel_app before any application query, for both
--      authenticated and anon/webhook contexts) — plus lintel_internal
--      for internal callers.
--   2. SCOPE ALLOWLIST: the functions are recreated to accept only the
--      scopes the application actually uses (src/lib/rate-limit.ts):
--      'open_cd', 'opens_1h', 'opens_1d', 'acct_opens_1h', 'loc_opens_1d',
--      'chat_1m'. Any other scope raises. Even a future code path that
--      passes user input into the scope argument cannot create or read
--      counters outside the known namespaces.
--   3. ATOMIC CONSUME: new app.rate_limit_try_bump() increments ONLY if the
--      post-increment count stays within the cap, in a single statement
--      (ON CONFLICT DO UPDATE ... WHERE count < cap). Closes the concurrent
--      check-then-increment overshoot: N simultaneous opens can never land
--      the counter past the cap, and a denied attempt consumes nothing.
--   4. ATOMIC COOLDOWN: new app.rate_limit_claim_cooldown() claims the
--      cooldown sentinel with UPDATE ... WHERE updated_at <= now() -
--      cooldown, so two simultaneous opens cannot both pass the cooldown.
--      Its insert path also opportunistically prunes stale sentinel rows
--      (window_start = epoch), which the regular window prune deliberately
--      skips and which otherwise grow unboundedly (one per subject × AP).

-- ============================================================================
-- 1+2. Recreate bump/get/last with the scope allowlist
-- ============================================================================

-- Atomic upsert-increment. Returns the post-increment count for the window.
-- Negative amounts are allowed (the app hands back consumed counters when a
-- later limit denies the same attempt). When a NEW window row is created,
-- opportunistically prunes a bounded batch of stale windows (older than
-- 2 days) for the same scope — epoch sentinel rows are preserved (they are
-- pruned by app.rate_limit_claim_cooldown instead).
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
    IF in_scope NOT IN ('open_cd', 'opens_1h', 'opens_1d', 'acct_opens_1h', 'loc_opens_1d', 'chat_1m') THEN
        RAISE EXCEPTION 'rate_limit_unknown_scope: %', in_scope;
    END IF;

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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF in_scope NOT IN ('open_cd', 'opens_1h', 'opens_1d', 'acct_opens_1h', 'loc_opens_1d', 'chat_1m') THEN
        RAISE EXCEPTION 'rate_limit_unknown_scope: %', in_scope;
    END IF;

    RETURN COALESCE((
        SELECT count FROM rate_limit_counters
        WHERE scope = in_scope AND subject = in_subject AND window_start = in_window_start
    ), 0);
END;
$$;

-- Read the last-event time for a cooldown subject (sentinel window row's
-- updated_at). NULL when the subject has never been bumped.
CREATE OR REPLACE FUNCTION app.rate_limit_last(
    in_scope text,
    in_subject text
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF in_scope NOT IN ('open_cd', 'opens_1h', 'opens_1d', 'acct_opens_1h', 'loc_opens_1d', 'chat_1m') THEN
        RAISE EXCEPTION 'rate_limit_unknown_scope: %', in_scope;
    END IF;

    RETURN (
        SELECT updated_at FROM rate_limit_counters
        WHERE scope = in_scope AND subject = in_subject AND window_start = to_timestamp(0)
    );
END;
$$;

-- ============================================================================
-- 3. Atomic capped consume
-- ============================================================================

-- Increment-if-under-cap in ONE atomic statement. Returns the post-increment
-- count when consumed, NULL when the cap would be exceeded (in which case
-- NOTHING is consumed — denials never eat quota). in_cap semantics:
--   NULL      = uncapped (plain increment; used for admin-exempt quotas),
--   0         = kill switch (always deny, touch nothing),
--   N >= 1    = at most N successful consumes per window.
-- Concurrency: ON CONFLICT DO UPDATE locks the conflicting row and
-- re-evaluates the WHERE clause against the latest committed version, so two
-- simultaneous callers at count = cap-1 serialize — exactly one wins.
CREATE OR REPLACE FUNCTION app.rate_limit_try_bump(
    in_scope text,
    in_subject text,
    in_window_start timestamptz,
    in_cap int
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
    IF in_scope NOT IN ('open_cd', 'opens_1h', 'opens_1d', 'acct_opens_1h', 'loc_opens_1d', 'chat_1m') THEN
        RAISE EXCEPTION 'rate_limit_unknown_scope: %', in_scope;
    END IF;

    IF in_cap IS NOT NULL AND in_cap <= 0 THEN
        RETURN NULL;  -- explicit 0 cap = kill switch: deny without touching anything
    END IF;

    INSERT INTO rate_limit_counters (scope, subject, window_start, count)
    VALUES (in_scope, in_subject, in_window_start, 1)
    ON CONFLICT (scope, subject, window_start) DO UPDATE
        SET count = rate_limit_counters.count + 1,
            updated_at = now()
        WHERE in_cap IS NULL OR rate_limit_counters.count < in_cap
    RETURNING count, (xmax = 0) INTO new_count, inserted;

    IF new_count IS NULL THEN
        RETURN NULL;  -- at/over cap: denied, nothing consumed
    END IF;

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

-- ============================================================================
-- 4. Atomic cooldown claim + sentinel pruning
-- ============================================================================

-- Atomically claim the cooldown sentinel for a subject: succeeds (and
-- refreshes updated_at = last successful open) only when the previous claim
-- is at least in_cooldown_s old. Two simultaneous opens serialize on the
-- sentinel row — exactly one passes the cooldown. in_cooldown_s <= 0 always
-- claims (cooldown disabled; the sentinel still records the last open so a
-- later-enabled cooldown has history).
-- The insert path (new subject) opportunistically prunes stale sentinels:
-- a sentinel not updated for max(cooldown, 1 day) can no longer influence
-- any cooldown decision, and without pruning these rows grow unboundedly
-- (one per visitor-phone × access point). Bounded batch, same as the
-- regular window prune.
CREATE OR REPLACE FUNCTION app.rate_limit_claim_cooldown(
    in_subject text,
    in_cooldown_s int
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    new_count int;
    inserted boolean;
BEGIN
    INSERT INTO rate_limit_counters (scope, subject, window_start, count)
    VALUES ('open_cd', in_subject, to_timestamp(0), 1)
    ON CONFLICT (scope, subject, window_start) DO UPDATE
        SET count = rate_limit_counters.count + 1,
            updated_at = now()
        WHERE in_cooldown_s <= 0
           OR rate_limit_counters.updated_at <= now() - make_interval(secs => in_cooldown_s)
    RETURNING count, (xmax = 0) INTO new_count, inserted;

    IF new_count IS NULL THEN
        RETURN false;  -- still cooling down: claim denied, sentinel untouched
    END IF;

    IF inserted THEN
        DELETE FROM rate_limit_counters
        WHERE ctid IN (
            SELECT ctid FROM rate_limit_counters
            WHERE scope = 'open_cd'
              AND window_start = to_timestamp(0)
              AND updated_at < now() - greatest(make_interval(secs => in_cooldown_s), interval '1 day')
            LIMIT 50
        );
    END IF;

    RETURN true;
END;
$$;

-- ============================================================================
-- Ownership + privileges (REVOKE PUBLIC, grant actual runtime roles)
-- ============================================================================

ALTER FUNCTION app.rate_limit_bump(text, text, timestamptz, int)     OWNER TO lintel_internal;
ALTER FUNCTION app.rate_limit_get(text, text, timestamptz)           OWNER TO lintel_internal;
ALTER FUNCTION app.rate_limit_last(text, text)                       OWNER TO lintel_internal;
ALTER FUNCTION app.rate_limit_try_bump(text, text, timestamptz, int) OWNER TO lintel_internal;
ALTER FUNCTION app.rate_limit_claim_cooldown(text, int)              OWNER TO lintel_internal;

REVOKE EXECUTE ON FUNCTION app.rate_limit_bump(text, text, timestamptz, int)     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.rate_limit_get(text, text, timestamptz)           FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.rate_limit_last(text, text)                       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.rate_limit_try_bump(text, text, timestamptz, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.rate_limit_claim_cooldown(text, int)              FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.rate_limit_bump(text, text, timestamptz, int)     TO lintel_app, lintel_internal;
GRANT EXECUTE ON FUNCTION app.rate_limit_get(text, text, timestamptz)           TO lintel_app, lintel_internal;
GRANT EXECUTE ON FUNCTION app.rate_limit_last(text, text)                       TO lintel_app, lintel_internal;
GRANT EXECUTE ON FUNCTION app.rate_limit_try_bump(text, text, timestamptz, int) TO lintel_app, lintel_internal;
GRANT EXECUTE ON FUNCTION app.rate_limit_claim_cooldown(text, int)              TO lintel_app, lintel_internal;
