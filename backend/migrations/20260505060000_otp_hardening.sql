-- 20260505060000_otp_hardening.sql
-- Hardening of the phone-OTP system (adversarial review 2026-07-18). New
-- migration on purpose: earlier migrations may already be applied elsewhere,
-- so history is never edited.
--
--   1. RATE-LIMIT SCOPES: the app.rate_limit_* functions enforce a scope
--      allowlist (20260505030000). The OTP flow gains two persistent
--      fixed-window limits enforced from src/routes/phones.ts:
--        'otp_start'  — OTP challenges started per user per hour. Closes the
--                       unlimited-restart hole: POST /me/phones re-add used
--                       to reset the per-challenge attempt counter with a
--                       fresh code, forever.
--        'otp_verify' — verify attempts per phone row per hour, surviving
--                       challenge restarts (the per-challenge 5-attempt cap
--                       alone resets with every restart).
--      Recreate bump/get/last/try_bump with the extended allowlist.
--      (rate_limit_claim_cooldown hardcodes 'open_cd' and is untouched.)
--
--   2. SALTED OTP HASHES (defense in depth): phone_verification_codes stored
--      an UNSALTED SHA-256 over a 10^6 code space — trivially reversible via
--      a precomputed table by anyone who can read the row (backup leak,
--      misconfigured replica). Add a per-challenge salt column and store
--      SHA-256(salt || code) instead. Hashing now lives in EXACTLY one
--      place: inside the SECURITY DEFINER functions, which take the
--      plaintext code (route TS no longer pre-hashes). Uses the Postgres
--      built-in sha256() — no pgcrypto dependency. A per-challenge random
--      salt defeats precomputation; brute-forcing 10^6 guesses against a
--      LEAKED row remains possible (inherent to 6-digit codes) but online
--      guessing is bounded by the attempt cap + the new rate limits.

-- ============================================================================
-- 1. Recreate rate-limit functions with 'otp_start' / 'otp_verify' scopes
-- ============================================================================

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
    IF in_scope NOT IN ('open_cd', 'opens_1h', 'opens_1d', 'acct_opens_1h', 'loc_opens_1d', 'chat_1m', 'otp_start', 'otp_verify') THEN
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
    IF in_scope NOT IN ('open_cd', 'opens_1h', 'opens_1d', 'acct_opens_1h', 'loc_opens_1d', 'chat_1m', 'otp_start', 'otp_verify') THEN
        RAISE EXCEPTION 'rate_limit_unknown_scope: %', in_scope;
    END IF;

    RETURN COALESCE((
        SELECT count FROM rate_limit_counters
        WHERE scope = in_scope AND subject = in_subject AND window_start = in_window_start
    ), 0);
END;
$$;

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
    IF in_scope NOT IN ('open_cd', 'opens_1h', 'opens_1d', 'acct_opens_1h', 'loc_opens_1d', 'chat_1m', 'otp_start', 'otp_verify') THEN
        RAISE EXCEPTION 'rate_limit_unknown_scope: %', in_scope;
    END IF;

    RETURN (
        SELECT updated_at FROM rate_limit_counters
        WHERE scope = in_scope AND subject = in_subject AND window_start = to_timestamp(0)
    );
END;
$$;

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
    IF in_scope NOT IN ('open_cd', 'opens_1h', 'opens_1d', 'acct_opens_1h', 'loc_opens_1d', 'chat_1m', 'otp_start', 'otp_verify') THEN
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

-- Re-assert ownership + privileges (CREATE OR REPLACE preserves them, but
-- keep the migration self-contained and robust against partial replays).
ALTER FUNCTION app.rate_limit_bump(text, text, timestamptz, int)     OWNER TO whatsacc_internal;
ALTER FUNCTION app.rate_limit_get(text, text, timestamptz)           OWNER TO whatsacc_internal;
ALTER FUNCTION app.rate_limit_last(text, text)                       OWNER TO whatsacc_internal;
ALTER FUNCTION app.rate_limit_try_bump(text, text, timestamptz, int) OWNER TO whatsacc_internal;

REVOKE EXECUTE ON FUNCTION app.rate_limit_bump(text, text, timestamptz, int)     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.rate_limit_get(text, text, timestamptz)           FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.rate_limit_last(text, text)                       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.rate_limit_try_bump(text, text, timestamptz, int) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.rate_limit_bump(text, text, timestamptz, int)     TO whatsacc_app, whatsacc_internal;
GRANT EXECUTE ON FUNCTION app.rate_limit_get(text, text, timestamptz)           TO whatsacc_app, whatsacc_internal;
GRANT EXECUTE ON FUNCTION app.rate_limit_last(text, text)                       TO whatsacc_app, whatsacc_internal;
GRANT EXECUTE ON FUNCTION app.rate_limit_try_bump(text, text, timestamptz, int) TO whatsacc_app, whatsacc_internal;

-- ============================================================================
-- 2. Per-challenge salt for OTP code hashes
-- ============================================================================

-- Pending challenges hold pre-salt hashes that the new consume() could never
-- match. They are 10-minute ephemera — drop them; users simply re-request.
-- (Required anyway: ADD COLUMN ... NOT NULL without DEFAULT needs an empty
-- table.)
DELETE FROM phone_verification_codes;

ALTER TABLE phone_verification_codes
    ADD COLUMN salt text NOT NULL;

COMMENT ON COLUMN phone_verification_codes.salt
    IS 'Per-challenge random salt (uuid). code_hash = hex(SHA-256(salt || code)).';
COMMENT ON COLUMN phone_verification_codes.code_hash
    IS 'Hex SHA-256 of salt || 6-digit code. The plaintext code is never stored and never logged; it only travels in the WhatsApp text to the number being verified.';

-- ============================================================================
-- 3. Verification functions: hash (with salt) INSIDE the definer functions
-- ============================================================================
-- The functions now take the PLAINTEXT code; hashing happens in exactly one
-- place (here). Parameter names change, so DROP + CREATE (same arg types —
-- CREATE OR REPLACE cannot rename parameters).

DROP FUNCTION IF EXISTS app.phone_verification_start(uuid, text, timestamptz);
DROP FUNCTION IF EXISTS app.phone_verification_consume(uuid, text, int);

-- Start (or restart) a verification challenge for a phone the caller owns.
-- Returns true when a code row was (re)created; false when the phone does
-- not exist, is not the caller's, or is already verified.
CREATE FUNCTION app.phone_verification_start(
    in_phone_id uuid,
    in_code text,
    in_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    new_salt text := gen_random_uuid()::text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM profile_phone_numbers ppn
        WHERE ppn.id = in_phone_id
          AND ppn.verified_at IS NULL
          AND (
              ppn.profile_id = app.current_user_id()
              OR app.current_user_id() IS NULL
              OR app.is_platform_admin()
          )
    ) THEN
        RETURN false;
    END IF;

    INSERT INTO phone_verification_codes (phone_id, salt, code_hash, expires_at, attempts)
    VALUES (
        in_phone_id,
        new_salt,
        encode(sha256(convert_to(new_salt || in_code, 'UTF8')), 'hex'),
        in_expires_at,
        0
    )
    ON CONFLICT (phone_id) DO UPDATE
        SET salt = EXCLUDED.salt,
            code_hash = EXCLUDED.code_hash,
            expires_at = EXCLUDED.expires_at,
            attempts = 0,
            updated_at = now();
    RETURN true;
END;
$$;

-- Check a code attempt for a phone the caller owns. Outcomes:
--   'ok'          — code matched: the challenge row is deleted and the phone
--                   is marked verified (atomically, in this call).
--   'no_code'     — no pending challenge (or phone not the caller's).
--   'locked'      — attempt cap (in_max_attempts) already burned.
--   'expired'     — challenge exists but is past its expiry.
--   'bad_code'    — mismatch; the attempt counter was incremented.
--   'phone_taken' — code matched but the number is already verified on
--                   another profile (partial unique index on phone_e164).
CREATE FUNCTION app.phone_verification_consume(
    in_phone_id uuid,
    in_code text,
    in_max_attempts int DEFAULT 5
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v RECORD;
BEGIN
    SELECT pvc.salt, pvc.code_hash, pvc.expires_at, pvc.attempts
      INTO v
      FROM phone_verification_codes pvc
      JOIN profile_phone_numbers ppn ON ppn.id = pvc.phone_id
      WHERE pvc.phone_id = in_phone_id
        AND (
            ppn.profile_id = app.current_user_id()
            OR app.current_user_id() IS NULL
            OR app.is_platform_admin()
        )
      FOR UPDATE OF pvc;

    IF NOT FOUND THEN
        RETURN 'no_code';
    END IF;
    IF v.attempts >= in_max_attempts THEN
        RETURN 'locked';
    END IF;
    IF v.expires_at <= now() THEN
        RETURN 'expired';
    END IF;
    IF v.code_hash <> encode(sha256(convert_to(v.salt || in_code, 'UTF8')), 'hex') THEN
        UPDATE phone_verification_codes
            SET attempts = attempts + 1, updated_at = now()
            WHERE phone_id = in_phone_id;
        RETURN 'bad_code';
    END IF;

    BEGIN
        UPDATE profile_phone_numbers
            SET verified_at = now()
            WHERE id = in_phone_id;
    EXCEPTION WHEN unique_violation THEN
        -- profile_phone_numbers_verified_unique: the number is already
        -- verified on some other profile. Keep the challenge; honest error.
        RETURN 'phone_taken';
    END;

    DELETE FROM phone_verification_codes WHERE phone_id = in_phone_id;
    RETURN 'ok';
END;
$$;

ALTER FUNCTION app.phone_verification_start(uuid, text, timestamptz)  OWNER TO whatsacc_internal;
ALTER FUNCTION app.phone_verification_consume(uuid, text, int)        OWNER TO whatsacc_internal;
GRANT EXECUTE ON FUNCTION app.phone_verification_start(uuid, text, timestamptz) TO whatsacc_app, whatsacc_internal;
GRANT EXECUTE ON FUNCTION app.phone_verification_consume(uuid, text, int)       TO whatsacc_app, whatsacc_internal;
