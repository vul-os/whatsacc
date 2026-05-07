-- 20260505160000_internal_role_for_rls_functions.sql
-- With FORCE ROW LEVEL SECURITY on, SECURITY DEFINER helper functions like
-- app.is_account_member recurse into the policies of the tables they read
-- (account_members's SELECT policy calls is_account_member, which queries
-- account_members, which invokes the policy again). The fix is to own those
-- helpers with a separate role that has BYPASSRLS — SECURITY DEFINER then
-- lets them read past the policies.
--
-- The same role owns trigger functions that write into system-managed
-- tables (meters, referral earnings, grant consumption) where there is no
-- direct write policy on purpose.
--
-- The whatsacc_internal role is created out-of-band by the DB bootstrap
-- step (it requires CREATEROLE privilege, which the app role doesn't have).
-- See README for the bootstrap commands.

-- whatsacc_internal needs CREATE on the app schema to take ownership of
-- functions defined there (Postgres requires the grantor and target role
-- both have CREATE on the function's schema). Idempotent.
GRANT CREATE ON SCHEMA app TO whatsacc_internal;

-- Trigger functions and SECURITY DEFINER helpers need to read+write
-- application tables under their own role. Idempotent.
GRANT USAGE ON SCHEMA public TO whatsacc_internal;
GRANT USAGE ON SCHEMA app TO whatsacc_internal;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO whatsacc_internal;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO whatsacc_internal;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO whatsacc_internal;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO whatsacc_internal;

-- Hand ownership of the privileged helpers to whatsacc_internal.
ALTER FUNCTION app.is_account_member(uuid)             OWNER TO whatsacc_internal;
ALTER FUNCTION app.is_account_admin(uuid)              OWNER TO whatsacc_internal;
ALTER FUNCTION app.access_points_init_meters()         OWNER TO whatsacc_internal;
ALTER FUNCTION app.access_logs_advance_meter()         OWNER TO whatsacc_internal;
ALTER FUNCTION app.maintenance_events_after_insert()   OWNER TO whatsacc_internal;
ALTER FUNCTION app.payment_intents_attribute_referral() OWNER TO whatsacc_internal;
ALTER FUNCTION app.try_consume_grant(text, uuid, timestamptz) OWNER TO whatsacc_internal;

-- Make sure the app role can call them.
GRANT EXECUTE ON FUNCTION app.is_account_member(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_account_admin(uuid)  TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.try_consume_grant(text, uuid, timestamptz) TO PUBLIC;
