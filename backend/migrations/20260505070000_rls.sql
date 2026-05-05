-- 20260505070000_rls.sql
-- Row-level security: helper functions in `app` schema and per-table policies.

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO PUBLIC;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    raw text;
BEGIN
    BEGIN
        raw := current_setting('app.user_id', true);
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;
    IF raw IS NULL OR raw = '' THEN
        RETURN NULL;
    END IF;
    RETURN raw::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION app.current_account_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    raw text;
BEGIN
    BEGIN
        raw := current_setting('app.account_id', true);
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;
    IF raw IS NULL OR raw = '' THEN
        RETURN NULL;
    END IF;
    RETURN raw::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION app.is_platform_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    raw text;
BEGIN
    BEGIN
        raw := current_setting('app.is_platform_admin', true);
    EXCEPTION WHEN OTHERS THEN
        RETURN false;
    END;
    IF raw IS NULL OR raw = '' THEN
        RETURN false;
    END IF;
    RETURN lower(raw) = 'true';
END;
$$;

CREATE OR REPLACE FUNCTION app.is_account_member(target_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT app.is_platform_admin()
        OR app.current_user_id() IS NULL
        OR EXISTS (
            SELECT 1 FROM account_members am
            WHERE am.account_id = target_account_id
              AND am.user_id = app.current_user_id()
              AND am.status = 'active'
        );
$$;

CREATE OR REPLACE FUNCTION app.is_account_admin(target_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT app.is_platform_admin()
        OR app.current_user_id() IS NULL
        OR EXISTS (
            SELECT 1 FROM account_members am
            WHERE am.account_id = target_account_id
              AND am.user_id = app.current_user_id()
              AND am.status = 'active'
              AND am.role IN ('owner','admin')
        );
$$;

-- =========================================================================
-- users
-- =========================================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_self ON users
    FOR ALL
    USING (id = app.current_user_id() OR app.current_user_id() IS NULL OR app.is_platform_admin())
    WITH CHECK (id = app.current_user_id() OR app.current_user_id() IS NULL OR app.is_platform_admin());

-- =========================================================================
-- profiles
-- =========================================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_self ON profiles
    FOR ALL
    USING (id = app.current_user_id() OR app.current_user_id() IS NULL OR app.is_platform_admin())
    WITH CHECK (id = app.current_user_id() OR app.current_user_id() IS NULL OR app.is_platform_admin());

-- =========================================================================
-- oauth_identities
-- =========================================================================
ALTER TABLE oauth_identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY oauth_identities_owner ON oauth_identities
    FOR ALL
    USING (user_id = app.current_user_id() OR app.current_user_id() IS NULL OR app.is_platform_admin())
    WITH CHECK (user_id = app.current_user_id() OR app.current_user_id() IS NULL OR app.is_platform_admin());

-- =========================================================================
-- refresh_tokens
-- =========================================================================
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY refresh_tokens_owner ON refresh_tokens
    FOR ALL
    USING (user_id = app.current_user_id() OR app.current_user_id() IS NULL OR app.is_platform_admin())
    WITH CHECK (user_id = app.current_user_id() OR app.current_user_id() IS NULL OR app.is_platform_admin());

-- =========================================================================
-- password_reset_tokens
-- =========================================================================
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY password_reset_tokens_owner ON password_reset_tokens
    FOR ALL
    USING (user_id = app.current_user_id() OR app.current_user_id() IS NULL OR app.is_platform_admin())
    WITH CHECK (user_id = app.current_user_id() OR app.current_user_id() IS NULL OR app.is_platform_admin());

-- =========================================================================
-- email_verification_tokens
-- =========================================================================
ALTER TABLE email_verification_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_verification_tokens_owner ON email_verification_tokens
    FOR ALL
    USING (user_id = app.current_user_id() OR app.current_user_id() IS NULL OR app.is_platform_admin())
    WITH CHECK (user_id = app.current_user_id() OR app.current_user_id() IS NULL OR app.is_platform_admin());

-- =========================================================================
-- profile_phone_numbers
-- =========================================================================
ALTER TABLE profile_phone_numbers ENABLE ROW LEVEL SECURITY;
CREATE POLICY profile_phone_numbers_owner ON profile_phone_numbers
    FOR ALL
    USING (profile_id = app.current_user_id() OR app.current_user_id() IS NULL OR app.is_platform_admin())
    WITH CHECK (profile_id = app.current_user_id() OR app.current_user_id() IS NULL OR app.is_platform_admin());

-- =========================================================================
-- accounts
-- =========================================================================
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_member ON accounts
    FOR ALL
    USING (app.is_account_member(id))
    WITH CHECK (app.is_account_admin(id));

-- =========================================================================
-- account_members
-- =========================================================================
ALTER TABLE account_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_members_select ON account_members
    FOR SELECT
    USING (app.is_account_member(account_id));
CREATE POLICY account_members_write ON account_members
    FOR INSERT
    WITH CHECK (app.is_account_admin(account_id));
CREATE POLICY account_members_update ON account_members
    FOR UPDATE
    USING (app.is_account_admin(account_id))
    WITH CHECK (app.is_account_admin(account_id));
CREATE POLICY account_members_delete ON account_members
    FOR DELETE
    USING (app.is_account_admin(account_id));

-- =========================================================================
-- account_invites
-- =========================================================================
ALTER TABLE account_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_invites_select ON account_invites
    FOR SELECT
    USING (app.is_account_member(account_id));
CREATE POLICY account_invites_write ON account_invites
    FOR INSERT
    WITH CHECK (app.is_account_admin(account_id));
CREATE POLICY account_invites_update ON account_invites
    FOR UPDATE
    USING (app.is_account_admin(account_id))
    WITH CHECK (app.is_account_admin(account_id));
CREATE POLICY account_invites_delete ON account_invites
    FOR DELETE
    USING (app.is_account_admin(account_id));

-- =========================================================================
-- locations
-- =========================================================================
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY locations_member ON locations
    FOR ALL
    USING (app.is_account_member(account_id))
    WITH CHECK (app.is_account_admin(account_id));

-- =========================================================================
-- location_members
-- =========================================================================
ALTER TABLE location_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY location_members_select ON location_members
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM locations l
            WHERE l.id = location_members.location_id
              AND app.is_account_member(l.account_id)
        )
    );
CREATE POLICY location_members_write ON location_members
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM locations l
            WHERE l.id = location_members.location_id
              AND app.is_account_admin(l.account_id)
        )
    );
CREATE POLICY location_members_update ON location_members
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM locations l
            WHERE l.id = location_members.location_id
              AND app.is_account_admin(l.account_id)
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM locations l
            WHERE l.id = location_members.location_id
              AND app.is_account_admin(l.account_id)
        )
    );
CREATE POLICY location_members_delete ON location_members
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM locations l
            WHERE l.id = location_members.location_id
              AND app.is_account_admin(l.account_id)
        )
    );

-- =========================================================================
-- location_settings
-- =========================================================================
ALTER TABLE location_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY location_settings_select ON location_settings
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM locations l
            WHERE l.id = location_settings.location_id
              AND app.is_account_member(l.account_id)
        )
    );
CREATE POLICY location_settings_write ON location_settings
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM locations l
            WHERE l.id = location_settings.location_id
              AND app.is_account_admin(l.account_id)
        )
    );
CREATE POLICY location_settings_update ON location_settings
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM locations l
            WHERE l.id = location_settings.location_id
              AND app.is_account_admin(l.account_id)
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM locations l
            WHERE l.id = location_settings.location_id
              AND app.is_account_admin(l.account_id)
        )
    );
CREATE POLICY location_settings_delete ON location_settings
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM locations l
            WHERE l.id = location_settings.location_id
              AND app.is_account_admin(l.account_id)
        )
    );

-- =========================================================================
-- devices
-- =========================================================================
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY devices_member ON devices
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM locations l
            WHERE l.id = devices.location_id
              AND app.is_account_member(l.account_id)
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM locations l
            WHERE l.id = devices.location_id
              AND app.is_account_admin(l.account_id)
        )
    );

-- =========================================================================
-- access_points
-- =========================================================================
ALTER TABLE access_points ENABLE ROW LEVEL SECURITY;
CREATE POLICY access_points_member ON access_points
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM locations l
            WHERE l.id = access_points.location_id
              AND app.is_account_member(l.account_id)
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM locations l
            WHERE l.id = access_points.location_id
              AND app.is_account_admin(l.account_id)
        )
    );

-- =========================================================================
-- device_commands
-- =========================================================================
ALTER TABLE device_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY device_commands_member ON device_commands
    FOR ALL
    USING (
        EXISTS (
            SELECT 1
            FROM access_points ap
            JOIN locations l ON l.id = ap.location_id
            WHERE ap.id = device_commands.access_point_id
              AND app.is_account_member(l.account_id)
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM access_points ap
            JOIN locations l ON l.id = ap.location_id
            WHERE ap.id = device_commands.access_point_id
              AND app.is_account_member(l.account_id)
        )
    );

-- =========================================================================
-- access_logs
-- =========================================================================
ALTER TABLE access_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY access_logs_member ON access_logs
    FOR ALL
    USING (
        app.is_platform_admin()
        OR app.current_user_id() IS NULL
        OR (account_id IS NOT NULL AND app.is_account_member(account_id))
    )
    WITH CHECK (
        app.is_platform_admin()
        OR app.current_user_id() IS NULL
        OR (account_id IS NOT NULL AND app.is_account_member(account_id))
    );

-- =========================================================================
-- whatsapp_chats
-- =========================================================================
ALTER TABLE whatsapp_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_chats_owner ON whatsapp_chats
    FOR ALL
    USING (
        profile_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    )
    WITH CHECK (
        profile_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );

-- =========================================================================
-- whatsapp_messages
-- =========================================================================
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_messages_owner ON whatsapp_messages
    FOR ALL
    USING (
        app.is_platform_admin()
        OR app.current_user_id() IS NULL
        OR EXISTS (
            SELECT 1 FROM whatsapp_chats c
            WHERE c.id = whatsapp_messages.chat_id
              AND c.profile_id = app.current_user_id()
        )
    )
    WITH CHECK (
        app.is_platform_admin()
        OR app.current_user_id() IS NULL
        OR EXISTS (
            SELECT 1 FROM whatsapp_chats c
            WHERE c.id = whatsapp_messages.chat_id
              AND c.profile_id = app.current_user_id()
        )
    );

-- =========================================================================
-- account_subscriptions
-- =========================================================================
ALTER TABLE account_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_subscriptions_admin ON account_subscriptions
    FOR ALL
    USING (app.is_account_admin(account_id))
    WITH CHECK (app.is_account_admin(account_id));

-- =========================================================================
-- wallets
-- =========================================================================
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY wallets_admin ON wallets
    FOR ALL
    USING (app.is_account_admin(account_id))
    WITH CHECK (app.is_account_admin(account_id));

-- =========================================================================
-- wallet_transactions
-- =========================================================================
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY wallet_transactions_admin ON wallet_transactions
    FOR ALL
    USING (app.is_account_admin(account_id))
    WITH CHECK (app.is_account_admin(account_id));

-- =========================================================================
-- usage_counters
-- =========================================================================
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_counters_admin ON usage_counters
    FOR ALL
    USING (app.is_account_admin(account_id))
    WITH CHECK (app.is_account_admin(account_id));
