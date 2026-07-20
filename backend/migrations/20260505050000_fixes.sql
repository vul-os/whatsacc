-- 20260505050000_fixes.sql
-- Four correctness/security fixes surfaced by the test-coverage pass:
--
--   1. slack_messages.kind CHECK did not allow 'interactive', but
--      src/routes/slack.ts persists gate-picker block replies with
--      kind = 'interactive'. The INSERT failed 23514 AFTER the blocks were
--      already posted to Slack → webhook 500 → Slack retried → duplicate
--      pickers, and the outbound reply was never logged. Extend the CHECK.
--
--   2. GET /accounts/:id/members INNER JOINs users, but the users_self RLS
--      policy only exposes the caller's own row, so an account owner could
--      only ever list themselves. Fix via the house pattern for cross-row
--      reads: a SECURITY DEFINER helper owned by lintel_internal
--      (BYPASSRLS), self-gated on app.is_account_member(), returning the
--      member list (email + display_name included). users/profiles RLS
--      stays untouched.
--
--   3. Phone-number OTP verification storage. Phones are no longer
--      auto-verified on add (identity root for the WhatsApp webhook!);
--      a 6-digit code is hashed (SHA-256) into phone_verification_codes
--      with a 10-minute expiry and a 5-attempt cap. Internal-table RLS
--      pattern: FORCEd RLS, request roles reach it only through the
--      SECURITY DEFINER app.phone_verification_* functions; platform
--      admins get a direct policy (operator support / tests).
--
--   4. telegram_messages had ON CONFLICT DO NOTHING in the inbound insert
--      but NO matching unique constraint (plain index only — compare
--      whatsapp_messages' UNIQUE constraint), so redelivered updates were
--      processed and replied to twice. Add the natural-key partial unique
--      index (chat_id, provider_message_id) for inbound rows.

-- ============================================================================
-- 1. slack_messages.kind: allow 'interactive'
-- ============================================================================

ALTER TABLE slack_messages
    DROP CONSTRAINT slack_messages_kind_check;
ALTER TABLE slack_messages
    ADD CONSTRAINT slack_messages_kind_check
    CHECK (kind IN ('text', 'file', 'system', 'interactive'));

-- ============================================================================
-- 2. Member listing helper (SECURITY DEFINER, lintel_internal-owned)
-- ============================================================================
-- Fail-closed: non-members of the target account get zero rows. The
-- app.is_account_member() gate keeps the baseline semantics (active member,
-- platform admin, or the anon/system context).

CREATE OR REPLACE FUNCTION app.account_member_list(target_account_id uuid)
RETURNS TABLE (
    user_id uuid,
    role text,
    status text,
    email text,
    display_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT am.user_id, am.role, am.status, u.email::text, p.display_name
    FROM account_members am
    JOIN users u ON u.id = am.user_id
    LEFT JOIN profiles p ON p.id = am.user_id
    WHERE am.account_id = target_account_id
      AND app.is_account_member(target_account_id)
    ORDER BY am.created_at ASC, am.user_id ASC;
$$;

ALTER FUNCTION app.account_member_list(uuid) OWNER TO lintel_internal;
-- Post-hardening grant style: runtime callers all execute as lintel_app
-- (withRLS does SET LOCAL ROLE lintel_app), so no PUBLIC grant.
GRANT EXECUTE ON FUNCTION app.account_member_list(uuid) TO lintel_app, lintel_internal;

-- ============================================================================
-- 3. Phone verification codes (OTP)
-- ============================================================================

CREATE TABLE phone_verification_codes (
    phone_id uuid PRIMARY KEY REFERENCES profile_phone_numbers(id) ON DELETE CASCADE,
    -- SHA-256 hex of the 6-digit code. The plaintext code is never stored
    -- and never logged; it only travels in the WhatsApp text to the number
    -- being verified.
    code_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE phone_verification_codes
    IS 'Pending OTP challenges for profile phone numbers. Internal pattern: request roles access only via app.phone_verification_* SECURITY DEFINER functions.';

ALTER TABLE phone_verification_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_verification_codes FORCE ROW LEVEL SECURITY;

-- The backend's system/anon context and platform admins may touch pending
-- codes directly (operator support, admin tooling — same trust boundary as
-- whatsapp_chats et al: tenants cannot reach the anon context). Tenant
-- request contexts have NO direct access; they go through the SECURITY
-- DEFINER functions below.
CREATE POLICY phone_verification_codes_internal ON phone_verification_codes
    FOR ALL
    USING (app.current_user_id() IS NULL OR app.is_platform_admin())
    WITH CHECK (app.current_user_id() IS NULL OR app.is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON phone_verification_codes TO lintel_internal;
GRANT SELECT, INSERT, UPDATE, DELETE ON phone_verification_codes TO lintel_app;

-- Start (or restart) a verification challenge for a phone the caller owns.
-- Returns true when a code row was (re)created; false when the phone does
-- not exist, is not the caller's, or is already verified.
CREATE OR REPLACE FUNCTION app.phone_verification_start(
    in_phone_id uuid,
    in_code_hash text,
    in_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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

    INSERT INTO phone_verification_codes (phone_id, code_hash, expires_at, attempts)
    VALUES (in_phone_id, in_code_hash, in_expires_at, 0)
    ON CONFLICT (phone_id) DO UPDATE
        SET code_hash = EXCLUDED.code_hash,
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
CREATE OR REPLACE FUNCTION app.phone_verification_consume(
    in_phone_id uuid,
    in_code_hash text,
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
    SELECT pvc.code_hash, pvc.expires_at, pvc.attempts
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
    IF v.code_hash <> in_code_hash THEN
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

ALTER FUNCTION app.phone_verification_start(uuid, text, timestamptz)  OWNER TO lintel_internal;
ALTER FUNCTION app.phone_verification_consume(uuid, text, int)        OWNER TO lintel_internal;
GRANT EXECUTE ON FUNCTION app.phone_verification_start(uuid, text, timestamptz) TO lintel_app, lintel_internal;
GRANT EXECUTE ON FUNCTION app.phone_verification_consume(uuid, text, int)       TO lintel_app, lintel_internal;

-- ============================================================================
-- 4. Telegram inbound redelivery dedupe
-- ============================================================================
-- Natural key of an inbound Telegram message: (chat, telegram message_id).
-- Partial (direction = 'in') so outbound rows — whose provider ids live in
-- the same per-chat id space — can never collide with a retried inbound.
-- ON CONFLICT DO NOTHING (no target) arbitrates against partial unique
-- indexes, so the existing insert clause now actually fires.

-- Defensive: collapse any duplicates a pre-fix deployment already ingested
-- (keep the oldest row per natural key) so the unique index can build.
DELETE FROM telegram_messages a
USING telegram_messages b
WHERE a.direction = 'in'
  AND b.direction = 'in'
  AND a.chat_id = b.chat_id
  AND a.provider_message_id IS NOT NULL
  AND a.provider_message_id = b.provider_message_id
  AND (b.created_at, b.id) < (a.created_at, a.id);

CREATE UNIQUE INDEX telegram_messages_inbound_provider_unique
    ON telegram_messages (chat_id, provider_message_id)
    WHERE direction = 'in' AND provider_message_id IS NOT NULL;
