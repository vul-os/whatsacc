-- 20260505040000_admin_hardening.sql
-- Hardening of the instance-admin machinery (adversarial review 2026-07-17).
-- New migration on purpose — earlier migrations may already be applied
-- elsewhere; history is never edited.
--
--   1. app.is_platform_admin() no longer trusts the caller-settable GUC
--      app.is_platform_admin (empirically settable by the request role via
--      set_config/SET LOCAL — custom GUCs have no ACL). It now DERIVES the
--      answer from the users table, keyed by app.current_user_id():
--      admin ⇔ the current user's row has is_platform_admin AND is not
--      disabled. SECURITY DEFINER owned by whatsacc_internal (BYPASSRLS) so
--      the users read cannot recurse into the users RLS policy.
--
--      Semantics preserved exactly:
--        * Admin HTTP requests run withAdminDb (real admin user_id in
--          app.user_id, verified live by requireAuth) → still admin.
--        * Anon/webhook contexts (app.user_id = '') were never granted by
--          THIS function's callers anyway — every policy that must admit the
--          anon backend context carries its own explicit
--          `app.current_user_id() IS NULL` clause. Anon now simply gets
--          `false` here, which only closes doors (admin_audit_log reads,
--          instance_setting_set, countries writes).
--        * `status <> 'disabled'` (not `= 'active'`) mirrors requireAuth's
--          live gate: a pending-status admin keeps admin RLS, a disabled
--          one loses it.
--
--      Defense gained: forging the GUC under a tenant identity no longer
--      unlocks cross-tenant RLS, admin_audit_log, or instance_setting_set.
--      (app.user_id remains the trusted identity anchor — it always was.)
--
--   2. PUBLIC EXECUTE revoked from the admin SECURITY DEFINER functions
--      (instance_setting_get/set, admin_audit_write, platform_admin_exists,
--      claim_platform_admin — the *_get was flagged in the rate-limit review
--      too). Runtime callers all execute as whatsacc_app (withRLS does
--      SET LOCAL ROLE whatsacc_app for user, admin and anon contexts alike),
--      so grants go to whatsacc_app + whatsacc_internal only.

-- ============================================================================
-- 1. Table-derived is_platform_admin()
-- ============================================================================

CREATE OR REPLACE FUNCTION app.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = app.current_user_id()
          AND u.is_platform_admin
          AND u.status <> 'disabled'
    );
$$;

ALTER FUNCTION app.is_platform_admin() OWNER TO whatsacc_internal;

REVOKE EXECUTE ON FUNCTION app.is_platform_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_platform_admin() TO whatsacc_app, whatsacc_internal;

-- ============================================================================
-- 2. Privilege tightening on the admin SECURITY DEFINER seam
-- ============================================================================

REVOKE EXECUTE ON FUNCTION app.instance_setting_get(text)                                FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.instance_setting_set(text, jsonb, uuid)                   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.platform_admin_exists()                                   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.claim_platform_admin(uuid)                                FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.admin_audit_write(uuid, text, text, text, boolean, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.instance_setting_get(text)                                TO whatsacc_app, whatsacc_internal;
GRANT EXECUTE ON FUNCTION app.instance_setting_set(text, jsonb, uuid)                   TO whatsacc_app, whatsacc_internal;
GRANT EXECUTE ON FUNCTION app.platform_admin_exists()                                   TO whatsacc_app, whatsacc_internal;
GRANT EXECUTE ON FUNCTION app.claim_platform_admin(uuid)                                TO whatsacc_app, whatsacc_internal;
GRANT EXECUTE ON FUNCTION app.admin_audit_write(uuid, text, text, text, boolean, jsonb) TO whatsacc_app, whatsacc_internal;
