-- 20260505020000_admin.sql
-- Instance-admin (gateway operator) system.
--
-- whatsacc is a self-hosted gateway: each deployment is run by an operator.
-- This migration adds the operator plumbing:
--
--   1. instance_settings — internal-only key/value store. Holds the runtime
--      rate-limit overrides (key 'rate_limits', partial jsonb object) and the
--      one-time admin-claim burn flag (key 'admin_claimed'). FORCEd RLS with
--      NO policies (same pattern as rate_limit_counters): request roles can
--      never touch rows directly; all access goes through the SECURITY
--      DEFINER app.instance_setting_* functions owned by whatsacc_internal.
--   2. admin_audit_log — append-only log of admin actions AND denied
--      /admin/* attempts. Readable by platform admins only; written only via
--      app.admin_audit_write (no INSERT policy on purpose, so a tenant can
--      neither forge nor spam audit rows through SQL-reachable paths).
--   3. app.claim_platform_admin — the atomic first-run claim: exactly one
--      caller can ever win, and the mechanism burns permanently once any
--      platform admin exists.
--   4. Account suspension support (status CHECK) + audit-friendly indexes.
--
-- NOTE: users.status ('active','disabled','pending') and accounts.status
-- already exist in the baseline — no columns to add, only the accounts
-- status domain is tightened here.

-- ============================================================================
-- accounts.status domain
-- ============================================================================
-- NOT VALID: pre-existing rows (all 'active' in practice) are not re-checked,
-- so the migration can never fail on legacy data; new writes are constrained.

ALTER TABLE accounts
    ADD CONSTRAINT accounts_status_allowed
    CHECK (status IN ('active', 'suspended')) NOT VALID;

-- ============================================================================
-- instance_settings (internal-only)
-- ============================================================================

CREATE TABLE instance_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE instance_settings
    IS 'Internal instance-wide settings (rate-limit overrides, admin-claim flag). No RLS policies on purpose — access only via app.instance_setting_* SECURITY DEFINER functions.';

ALTER TABLE instance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_settings FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON instance_settings TO whatsacc_internal;
GRANT SELECT, INSERT, UPDATE, DELETE ON instance_settings TO whatsacc_app;

-- ============================================================================
-- admin_audit_log
-- ============================================================================

CREATE TABLE admin_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    -- e.g. 'admin_access_denied', 'admin_claim', 'account_status',
    -- 'user_status', 'platform_admin', 'limits_update'
    action text NOT NULL,
    target_kind text NULL,
    target_id text NULL,
    -- false = the attempt was denied (non-admin probing /admin/*, bad claim
    -- token, ...); true = a real admin action that succeeded.
    allowed boolean NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE admin_audit_log
    IS 'Append-only audit of instance-admin actions and denied /admin/* attempts. Written only via app.admin_audit_write.';

CREATE INDEX admin_audit_log_created_at_idx ON admin_audit_log (created_at DESC);
CREATE INDEX admin_audit_log_actor_idx ON admin_audit_log (actor_user_id, created_at DESC);

ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log FORCE ROW LEVEL SECURITY;

-- Platform admins can read; NOBODY can write directly (writes only via the
-- SECURITY DEFINER function below).
CREATE POLICY admin_audit_log_admin_read ON admin_audit_log
    FOR SELECT
    USING (app.is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON admin_audit_log TO whatsacc_internal;
GRANT SELECT ON admin_audit_log TO whatsacc_app;

-- ============================================================================
-- Audit-friendly indexes
-- ============================================================================
-- Cross-account admin views (overview, /admin/audit) scan access_logs by
-- time without a tenant filter — the per-tenant (account_id, ts) indexes
-- don't help there.

CREATE INDEX access_logs_ts_idx ON access_logs (ts DESC);
CREATE INDEX access_logs_denied_ts_idx ON access_logs (ts DESC) WHERE success = false;
CREATE INDEX users_created_at_idx ON users (created_at DESC);
CREATE INDEX accounts_created_at_idx ON accounts (created_at DESC);

-- ============================================================================
-- Accessor functions (SECURITY DEFINER, owned by whatsacc_internal)
-- ============================================================================

-- Read one setting. PUBLIC: the rate limiter must read overrides under every
-- RLS context (member opens, anon webhook opens). Values are non-secret.
CREATE OR REPLACE FUNCTION app.instance_setting_get(in_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT value FROM instance_settings WHERE key = in_key;
$$;

-- Upsert one setting. Self-gated: callable only when the transaction's RLS
-- context carries is_platform_admin=true (set from a verified JWT + a live
-- users-row check by the backend). Fail-closed for everyone else.
CREATE OR REPLACE FUNCTION app.instance_setting_set(
    in_key text,
    in_value jsonb,
    in_user uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT app.is_platform_admin() THEN
        RAISE EXCEPTION 'instance_setting_set requires platform admin'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    INSERT INTO instance_settings (key, value, updated_by)
    VALUES (in_key, in_value, in_user)
    ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_by = EXCLUDED.updated_by,
            updated_at = now();
END;
$$;

-- Does ANY platform admin exist? Drives the claim flow's fail-closed gate.
-- Boolean-only disclosure; needed under non-admin contexts.
CREATE OR REPLACE FUNCTION app.platform_admin_exists()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM users WHERE is_platform_admin);
$$;

-- One-time first-run claim. Atomic under an advisory xact lock: exactly one
-- caller can ever win. Returns false (never raises) when:
--   - any platform admin already exists, or
--   - the claim was already burned (admin_claimed flag), or
--   - the target user does not exist / is not active.
-- On success: promotes the user AND burns the claim permanently.
CREATE OR REPLACE FUNCTION app.claim_platform_admin(in_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('whatsacc:admin_claim', 0));

    IF EXISTS (SELECT 1 FROM users WHERE is_platform_admin) THEN
        RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM instance_settings WHERE key = 'admin_claimed') THEN
        RETURN false;
    END IF;

    UPDATE users
       SET is_platform_admin = true, updated_at = now()
     WHERE id = in_user_id AND status = 'active';
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    INSERT INTO instance_settings (key, value, updated_by)
    VALUES (
        'admin_claimed',
        jsonb_build_object('claimed_by', in_user_id, 'claimed_at', now()),
        in_user_id
    );
    RETURN true;
END;
$$;

-- Append an admin-audit row. PUBLIC on purpose: denied /admin/* attempts are
-- written while the caller is NOT an admin. Insert-only, reachable solely
-- through backend code paths (tenants cannot run SQL).
CREATE OR REPLACE FUNCTION app.admin_audit_write(
    in_actor uuid,
    in_action text,
    in_target_kind text,
    in_target_id text,
    in_allowed boolean,
    in_detail jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    new_id uuid;
BEGIN
    INSERT INTO admin_audit_log (actor_user_id, action, target_kind, target_id, allowed, detail)
    VALUES (in_actor, in_action, in_target_kind, in_target_id, in_allowed, COALESCE(in_detail, '{}'::jsonb))
    RETURNING id INTO new_id;
    RETURN new_id;
END;
$$;

-- Hand ownership to the BYPASSRLS internal role (baseline pattern) so the
-- functions can cross the FORCEd RLS on the internal tables.
ALTER FUNCTION app.instance_setting_get(text)                            OWNER TO whatsacc_internal;
ALTER FUNCTION app.instance_setting_set(text, jsonb, uuid)               OWNER TO whatsacc_internal;
ALTER FUNCTION app.platform_admin_exists()                               OWNER TO whatsacc_internal;
ALTER FUNCTION app.claim_platform_admin(uuid)                            OWNER TO whatsacc_internal;
ALTER FUNCTION app.admin_audit_write(uuid, text, text, text, boolean, jsonb) OWNER TO whatsacc_internal;

GRANT EXECUTE ON FUNCTION app.instance_setting_get(text)                            TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.instance_setting_set(text, jsonb, uuid)               TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_admin_exists()                               TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_platform_admin(uuid)                            TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_audit_write(uuid, text, text, text, boolean, jsonb) TO PUBLIC;
