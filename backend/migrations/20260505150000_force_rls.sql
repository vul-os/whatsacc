-- 20260505150000_force_rls.sql
-- ENABLE ROW LEVEL SECURITY only enforces RLS on non-owner roles. The app
-- connects with the role that owns the schema (whatsacc_app), so without
-- this every policy was being silently bypassed. FORCE applies the policies
-- to the owner too. Superusers still bypass — production must use a non-
-- superuser role for the application connection.

DO $$
DECLARE
    t text;
BEGIN
    FOR t IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relrowsecurity
    LOOP
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    END LOOP;
END
$$;
