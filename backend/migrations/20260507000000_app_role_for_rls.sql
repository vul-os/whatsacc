-- 20260507000000_app_role_for_rls.sql
-- Creates a NOLOGIN, non-BYPASSRLS role that the backend SET LOCAL ROLEs to
-- inside every request transaction (see lib/db.ts withRLS). The connection
-- itself still authenticates as the database owner (neondb_owner on Neon,
-- whatsacc_app on local) — but on Neon that role has BYPASSRLS=true, which
-- silently disables every RLS policy. Switching role per-transaction to a
-- non-BYPASSRLS role re-arms the policies without burning a separate
-- connection pool. Idempotent.

-- Idempotent + permission-tolerant: if the role already exists (typical when
-- the connecting user IS whatsacc_app), skip CREATE entirely so we don't trip
-- on missing CREATEROLE privilege. If we're already connected as the target
-- role, skip the GRANT-to-self that would otherwise be a no-op or error.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whatsacc_app') THEN
        CREATE ROLE whatsacc_app NOLOGIN;
    END IF;
    IF current_user <> 'whatsacc_app' THEN
        EXECUTE format('GRANT whatsacc_app TO %I', current_user);
    END IF;
END $$;

-- Schema + table privileges. RLS will still filter rows; these grants only
-- decide whether the role can see/touch the relations at all.
GRANT USAGE ON SCHEMA public TO whatsacc_app;
GRANT USAGE ON SCHEMA app TO whatsacc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO whatsacc_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO whatsacc_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO whatsacc_app;

-- Default privileges so future tables/sequences/functions are also reachable
-- without re-running this migration. Run with neondb_owner / table owner.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO whatsacc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO whatsacc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
    GRANT EXECUTE ON FUNCTIONS TO whatsacc_app;
