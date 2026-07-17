-- 20260505000000_foundation.sql
-- Folded foundation schema through 2026-05-05 patches.
-- Folded from:
--   - 20260505000000_init.sql
--   - 20260505010000_extensions.sql
--   - 20260505020000_auth.sql
--   - 20260505030000_tenancy.sql
--   - 20260505040000_access.sql
--   - 20260505050000_whatsapp.sql
--   - 20260505060000_billing.sql
--   - 20260505070000_rls.sql
--   - 20260505080000_geo_currency.sql
--   - 20260505090000_payments.sql
--   - 20260505100000_maintenance.sql
--   - 20260505110000_referrals.sql
--   - 20260505120000_monthly_payouts.sql
--   - 20260505130000_temp_access.sql
--   - 20260505140000_fix_referral_trigger.sql
--   - 20260505150000_force_rls.sql
--   - 20260505160000_internal_role_for_rls_functions.sql
--   - 20260505170000_payout_requests_updated_at.sql


-- ============================================================================
-- 20260505000000_init.sql
-- ============================================================================

-- 20260505000000_init.sql
-- Initial schema for whatsacc.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ============================================================================
-- 20260505010000_extensions.sql
-- ============================================================================

-- 20260505010000_extensions.sql
-- Additional Postgres extensions.

CREATE EXTENSION IF NOT EXISTS citext;

-- ============================================================================
-- 20260505020000_auth.sql
-- ============================================================================

-- 20260505020000_auth.sql
-- Authentication: users, profiles, oauth, tokens, phone numbers.

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email citext UNIQUE NOT NULL,
    password_hash text NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','pending')),
    email_verified_at timestamptz NULL,
    is_platform_admin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE users IS 'Authenticated end-users of the platform.';

CREATE TABLE profiles (
    id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name text,
    avatar_url text,
    locale text NOT NULL DEFAULT 'en',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE profiles IS 'Per-user profile metadata, 1:1 with users.';

CREATE TABLE oauth_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL,
    provider_sub text NOT NULL,
    email citext,
    linked_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_sub)
);
COMMENT ON TABLE oauth_identities IS 'Linked external identity-provider identities per user.';
CREATE INDEX oauth_identities_user_id_idx ON oauth_identities (user_id);

CREATE TABLE refresh_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz NULL,
    replaced_by uuid NULL,
    user_agent text,
    ip inet,
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE refresh_tokens IS 'Rotating refresh-token records grouped by family for reuse detection.';
CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens (family_id);
CREATE UNIQUE INDEX refresh_tokens_token_hash_idx ON refresh_tokens (token_hash);

CREATE TABLE password_reset_tokens (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE password_reset_tokens IS 'Single-use tokens for password reset flows.';
CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);

CREATE TABLE email_verification_tokens (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose text NOT NULL DEFAULT 'verify' CHECK (purpose IN ('verify')),
    expires_at timestamptz NOT NULL,
    used_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE email_verification_tokens IS 'Single-use tokens for email-address verification.';
CREATE INDEX email_verification_tokens_user_id_idx ON email_verification_tokens (user_id);

CREATE TABLE profile_phone_numbers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    phone_e164 text NOT NULL,
    verified_at timestamptz NULL,
    is_primary boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (profile_id, phone_e164)
);
COMMENT ON TABLE profile_phone_numbers IS 'Phone numbers attached to a profile, verified or pending.';
CREATE UNIQUE INDEX profile_phone_numbers_verified_unique
    ON profile_phone_numbers (phone_e164)
    WHERE verified_at IS NOT NULL;
CREATE INDEX profile_phone_numbers_profile_id_idx ON profile_phone_numbers (profile_id);

CREATE OR REPLACE FUNCTION enforce_max_phones_per_profile()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    max_phones int;
    current_count int;
    raw text;
BEGIN
    BEGIN
        raw := current_setting('app.max_phones_per_profile', true);
    EXCEPTION WHEN OTHERS THEN
        raw := NULL;
    END;

    IF raw IS NULL OR raw = '' THEN
        max_phones := 3;
    ELSE
        max_phones := raw::int;
    END IF;

    SELECT count(*) INTO current_count
    FROM profile_phone_numbers
    WHERE profile_id = NEW.profile_id;

    IF current_count + 1 > max_phones THEN
        RAISE EXCEPTION 'profile % already has % phone numbers (max %)',
            NEW.profile_id, current_count, max_phones
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER profile_phone_numbers_max_phones
BEFORE INSERT ON profile_phone_numbers
FOR EACH ROW
EXECUTE FUNCTION enforce_max_phones_per_profile();

-- ============================================================================
-- 20260505030000_tenancy.sql
-- ============================================================================

-- 20260505030000_tenancy.sql
-- Tenancy: accounts, members, invites, locations, location overrides and settings.

CREATE TABLE accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    billing_type text NOT NULL CHECK (billing_type IN ('personal','business')),
    billing_address jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE accounts IS 'Top-level billing tenant owning locations and members.';

CREATE TABLE account_members (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
    status text NOT NULL DEFAULT 'active',
    invited_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    joined_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, user_id)
);
COMMENT ON TABLE account_members IS 'Membership of users in accounts with account-level role.';
CREATE INDEX account_members_user_id_idx ON account_members (user_id);

CREATE TABLE account_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email citext NOT NULL,
    role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz NULL,
    accepted_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    revoked_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NULL REFERENCES users(id) ON DELETE SET NULL
);
COMMENT ON TABLE account_invites IS 'Pending invitations to join an account.';
CREATE INDEX account_invites_account_id_idx ON account_invites (account_id);
CREATE INDEX account_invites_email_idx ON account_invites (email);
CREATE UNIQUE INDEX account_invites_token_hash_idx ON account_invites (token_hash);

CREATE TABLE locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    parent_location_id uuid NULL REFERENCES locations(id) ON DELETE SET NULL,
    type text NOT NULL CHECK (type IN ('house','complex','building','other')),
    name text NOT NULL,
    slug text NOT NULL,
    address jsonb NOT NULL DEFAULT '{}'::jsonb,
    lat double precision,
    long double precision,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, slug)
);
COMMENT ON TABLE locations IS 'Physical properties (houses, complexes, buildings) under an account.';
CREATE INDEX locations_account_id_idx ON locations (account_id);
CREATE INDEX locations_parent_location_id_idx ON locations (parent_location_id);

CREATE TABLE location_members (
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (location_id, user_id)
);
COMMENT ON TABLE location_members IS 'Per-location role overrides for users that already belong to the account.';
CREATE INDEX location_members_user_id_idx ON location_members (user_id);

CREATE TABLE location_settings (
    location_id uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
    max_distance_m int NOT NULL DEFAULT 50,
    gate_movement_m_per_op numeric(8,2) NOT NULL DEFAULT 3.5,
    max_phones_per_profile int NOT NULL DEFAULT 3,
    allow_command_via_whatsapp boolean NOT NULL DEFAULT true,
    allow_command_via_web boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE location_settings IS 'Per-location operational tunables (geofence, channels, limits).';

-- ============================================================================
-- 20260505040000_access.sql
-- ============================================================================

-- 20260505040000_access.sql
-- Devices, access points, command queue, access logs.

CREATE TABLE devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    label text,
    claim_token_hash text NULL,
    claim_expires_at timestamptz NULL,
    paired_at timestamptz NULL,
    last_seen_at timestamptz NULL,
    public_key text NULL,
    status text NOT NULL DEFAULT 'unpaired',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE devices IS 'Physical controllers paired to a location, receiving commands.';
CREATE INDEX devices_location_id_idx ON devices (location_id);
CREATE UNIQUE INDEX devices_claim_token_hash_idx
    ON devices (claim_token_hash)
    WHERE claim_token_hash IS NOT NULL;

CREATE TABLE access_points (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('gate','door','barrier','other')),
    lat double precision,
    long double precision,
    device_id uuid NULL REFERENCES devices(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE access_points IS 'Gates, doors and barriers under a location, optionally bound to a device.';
CREATE INDEX access_points_location_id_idx ON access_points (location_id);
CREATE INDEX access_points_device_id_idx ON access_points (device_id);

CREATE TABLE device_commands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    access_point_id uuid NOT NULL REFERENCES access_points(id) ON DELETE CASCADE,
    requested_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    command text NOT NULL CHECK (command IN ('open','close')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','executed','failed','expired')),
    source text NOT NULL CHECK (source IN ('web','whatsapp','api')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz NULL,
    executed_at timestamptz NULL,
    error text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE device_commands IS 'Queue of open/close commands dispatched to devices.';
CREATE INDEX device_commands_device_id_idx ON device_commands (device_id);
CREATE INDEX device_commands_access_point_id_idx ON device_commands (access_point_id);
CREATE INDEX device_commands_requested_by_user_id_idx ON device_commands (requested_by_user_id);
CREATE INDEX device_commands_status_idx ON device_commands (status) WHERE status IN ('pending','delivered');

CREATE TABLE access_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    access_point_id uuid NULL REFERENCES access_points(id) ON DELETE SET NULL,
    location_id uuid NULL REFERENCES locations(id) ON DELETE SET NULL,
    account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
    user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    command text,
    source text,
    lat double precision NULL,
    long double precision NULL,
    distance_m numeric(10,2) NULL,
    success boolean NOT NULL,
    error text NULL,
    ts timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE access_logs IS 'Append-only audit log of access attempts; denormalised for analytics.';
CREATE INDEX access_logs_location_id_ts_idx ON access_logs (location_id, ts DESC);
CREATE INDEX access_logs_account_id_ts_idx ON access_logs (account_id, ts DESC);
CREATE INDEX access_logs_access_point_id_ts_idx ON access_logs (access_point_id, ts DESC);
CREATE INDEX access_logs_user_id_ts_idx ON access_logs (user_id, ts DESC);

-- ============================================================================
-- 20260505050000_whatsapp.sql
-- ============================================================================

-- 20260505050000_whatsapp.sql
-- WhatsApp (Meta Cloud API) chat threads and messages.

CREATE TABLE whatsapp_chats (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164 text UNIQUE NOT NULL,
    profile_id uuid NULL REFERENCES profiles(id) ON DELETE SET NULL,
    last_inbound_at timestamptz,
    last_outbound_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE whatsapp_chats IS 'WhatsApp conversation thread, one per phone number.';
CREATE INDEX whatsapp_chats_profile_id_idx ON whatsapp_chats (profile_id);

CREATE TABLE whatsapp_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
    direction text NOT NULL CHECK (direction IN ('in','out')),
    kind text NOT NULL CHECK (kind IN ('text','location','media','interactive','system')),
    body jsonb NOT NULL,
    provider_message_id text,
    status text,
    ts timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE whatsapp_messages IS 'Individual WhatsApp messages exchanged on a chat.';
CREATE INDEX whatsapp_messages_chat_id_ts_idx ON whatsapp_messages (chat_id, ts DESC);
CREATE INDEX whatsapp_messages_provider_message_id_idx
    ON whatsapp_messages (provider_message_id)
    WHERE provider_message_id IS NOT NULL;

-- ============================================================================
-- 20260505060000_billing.sql
-- ============================================================================

-- 20260505060000_billing.sql
-- Plans, subscriptions, wallets and per-period usage counters.

CREATE TABLE plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text UNIQUE NOT NULL,
    name text NOT NULL,
    monthly_message_quota int NOT NULL,
    included_devices int NOT NULL,
    price_cents int NOT NULL,
    currency text NOT NULL DEFAULT 'usd',
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE plans IS 'Subscription plans available for accounts.';

INSERT INTO plans (code, name, monthly_message_quota, included_devices, price_cents, currency) VALUES
    ('free',    'Free',      100, 1,   0, 'usd'),
    ('starter', 'Starter',  2000, 5, 900, 'usd'),
    ('pro',     'Pro',     20000, 50, 4900, 'usd');

CREATE TABLE account_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid UNIQUE NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    plan_id uuid NOT NULL REFERENCES plans(id),
    status text NOT NULL DEFAULT 'active',
    current_period_start timestamptz,
    current_period_end timestamptz,
    cancel_at timestamptz NULL,
    stripe_subscription_id text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE account_subscriptions IS 'Active subscription binding an account to a plan.';
CREATE INDEX account_subscriptions_plan_id_idx ON account_subscriptions (plan_id);
CREATE UNIQUE INDEX account_subscriptions_stripe_idx
    ON account_subscriptions (stripe_subscription_id)
    WHERE stripe_subscription_id IS NOT NULL;

CREATE TABLE wallets (
    account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    balance_cents bigint NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'usd',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE wallets IS 'Prepaid balance held by an account.';

CREATE TABLE wallet_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    delta_cents bigint NOT NULL,
    reason text NOT NULL,
    reference text NULL,
    ts timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE wallet_transactions IS 'Append-only ledger of wallet credits and debits.';
CREATE INDEX wallet_transactions_account_id_ts_idx ON wallet_transactions (account_id, ts DESC);

CREATE TABLE usage_counters (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    period text NOT NULL,
    messages_used int NOT NULL DEFAULT 0,
    opens int NOT NULL DEFAULT 0,
    closes int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, period)
);
COMMENT ON TABLE usage_counters IS 'Per-account per-month usage counters (yyyy-mm period).';

-- ============================================================================
-- 20260505070000_rls.sql
-- ============================================================================

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

-- ============================================================================
-- 20260505080000_geo_currency.sql
-- ============================================================================

-- 20260505080000_geo_currency.sql
-- Currencies, countries, FX rates, and country binding for accounts/users.
-- All native pricing is stored in ZAR; currencies provide display conversion
-- via fx_rates (currency -> ZAR).

CREATE TABLE currencies (
    code text PRIMARY KEY CHECK (length(code) = 3 AND code = upper(code)),
    name text NOT NULL,
    symbol text NOT NULL,
    decimals smallint NOT NULL DEFAULT 2 CHECK (decimals >= 0 AND decimals <= 4),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE currencies IS 'Supported display currencies. Native ledger is ZAR.';

CREATE TABLE fx_rates (
    currency_code text PRIMARY KEY REFERENCES currencies(code) ON DELETE CASCADE,
    -- 1 unit of currency = `rate_to_zar` ZAR. Display = zar / rate_to_zar.
    rate_to_zar numeric(18,8) NOT NULL CHECK (rate_to_zar > 0),
    source text NOT NULL DEFAULT 'seed',
    fetched_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE fx_rates IS 'Latest FX rate per currency relative to ZAR. Refreshed by cron.';

CREATE TABLE countries (
    code text PRIMARY KEY CHECK (length(code) = 2 AND code = upper(code)),
    name text NOT NULL,
    flag_emoji text NOT NULL,
    currency_code text NOT NULL REFERENCES currencies(code),
    -- WhatsApp business-initiated conversation cost in ZAR.
    msg_cost_zar numeric(10,4) NOT NULL DEFAULT 0,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE countries IS 'Supported countries with WhatsApp conversation cost in ZAR.';
CREATE INDEX countries_currency_code_idx ON countries (currency_code);

INSERT INTO currencies (code, name, symbol, decimals) VALUES
    ('ZAR', 'South African Rand',  'R',     2),
    ('USD', 'US Dollar',           '$',     2),
    ('EUR', 'Euro',                '€',     2),
    ('GBP', 'British Pound',       '£',     2),
    ('CAD', 'Canadian Dollar',     'C$',    2),
    ('AUD', 'Australian Dollar',   'A$',    2),
    ('BRL', 'Brazilian Real',      'R$',    2),
    ('MXN', 'Mexican Peso',        'Mex$',  2),
    ('INR', 'Indian Rupee',        '₹',     0),
    ('IDR', 'Indonesian Rupiah',   'Rp',    0),
    ('PHP', 'Philippine Peso',     '₱',     0),
    ('NGN', 'Nigerian Naira',      '₦',     0),
    ('KES', 'Kenyan Shilling',     'KSh',   2),
    ('AED', 'UAE Dirham',          'د.إ',   2);

INSERT INTO fx_rates (currency_code, rate_to_zar, source) VALUES
    ('ZAR', 1.0,     'seed'),
    ('USD', 18.5,    'seed'),
    ('EUR', 20.0,    'seed'),
    ('GBP', 24.0,    'seed'),
    ('CAD', 13.5,    'seed'),
    ('AUD', 12.0,    'seed'),
    ('BRL', 3.2,     'seed'),
    ('MXN', 1.0,     'seed'),
    ('INR', 0.22,    'seed'),
    ('IDR', 0.0012,  'seed'),
    ('PHP', 0.32,    'seed'),
    ('NGN', 0.012,   'seed'),
    ('KES', 0.14,    'seed'),
    ('AED', 5.0,     'seed');

INSERT INTO countries (code, name, flag_emoji, currency_code, msg_cost_zar) VALUES
    ('ZA', 'South Africa',   '🇿🇦', 'ZAR', 0.148),
    ('NG', 'Nigeria',        '🇳🇬', 'NGN', 0.122),
    ('KE', 'Kenya',          '🇰🇪', 'KES', 0.407),
    ('US', 'United States',  '🇺🇸', 'USD', 0.463),
    ('CA', 'Canada',         '🇨🇦', 'CAD', 0.463),
    ('BR', 'Brazil',         '🇧🇷', 'BRL', 0.093),
    ('MX', 'Mexico',         '🇲🇽', 'MXN', 0.113),
    ('GB', 'United Kingdom', '🇬🇧', 'GBP', 0.407),
    ('DE', 'Germany',        '🇩🇪', 'EUR', 0.407),
    ('FR', 'France',         '🇫🇷', 'EUR', 0.407),
    ('AE', 'UAE',            '🇦🇪', 'AED', 0.352),
    ('IN', 'India',          '🇮🇳', 'INR', 0.065),
    ('ID', 'Indonesia',      '🇮🇩', 'IDR', 0.191),
    ('PH', 'Philippines',    '🇵🇭', 'PHP', 0.178),
    ('AU', 'Australia',      '🇦🇺', 'AUD', 0.507);

-- Bind accounts and profiles to a country. Default to ZA (made in Durban).
ALTER TABLE accounts
    ADD COLUMN country_code text NOT NULL DEFAULT 'ZA' REFERENCES countries(code);
CREATE INDEX accounts_country_code_idx ON accounts (country_code);

ALTER TABLE profiles
    ADD COLUMN country_code text NULL REFERENCES countries(code);

-- Reference tables are world-readable; writes restricted to platform admin.
ALTER TABLE currencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY currencies_read ON currencies FOR SELECT USING (true);
CREATE POLICY currencies_insert ON currencies FOR INSERT WITH CHECK (app.is_platform_admin());
CREATE POLICY currencies_update ON currencies FOR UPDATE USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());
CREATE POLICY currencies_delete ON currencies FOR DELETE USING (app.is_platform_admin());

ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY fx_rates_read ON fx_rates FOR SELECT USING (true);
CREATE POLICY fx_rates_insert ON fx_rates FOR INSERT WITH CHECK (app.is_platform_admin());
CREATE POLICY fx_rates_update ON fx_rates FOR UPDATE USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());
CREATE POLICY fx_rates_delete ON fx_rates FOR DELETE USING (app.is_platform_admin());

ALTER TABLE countries ENABLE ROW LEVEL SECURITY;
CREATE POLICY countries_read ON countries FOR SELECT USING (true);
CREATE POLICY countries_insert ON countries FOR INSERT WITH CHECK (app.is_platform_admin());
CREATE POLICY countries_update ON countries FOR UPDATE USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());
CREATE POLICY countries_delete ON countries FOR DELETE USING (app.is_platform_admin());

-- ============================================================================
-- 20260505090000_payments.sql
-- ============================================================================

-- 20260505090000_payments.sql
-- Paystack payments: per-attempt intents and provider webhook event log.
-- Wallet ledger stays in ZAR; intents store the raw provider amount as ZAR-cents.

ALTER TABLE accounts
    ADD COLUMN paystack_customer_code text NULL;
CREATE UNIQUE INDEX accounts_paystack_customer_code_idx
    ON accounts (paystack_customer_code)
    WHERE paystack_customer_code IS NOT NULL;

ALTER TABLE wallets
    ALTER COLUMN currency SET DEFAULT 'ZAR';

CREATE TABLE payment_intents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    initiated_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    provider text NOT NULL CHECK (provider IN ('paystack')),
    provider_reference text NOT NULL,
    purpose text NOT NULL DEFAULT 'wallet_topup' CHECK (purpose IN ('wallet_topup','subscription')),
    amount_cents bigint NOT NULL CHECK (amount_cents > 0),
    currency text NOT NULL DEFAULT 'ZAR',
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','succeeded','failed','abandoned')),
    authorization_url text NULL,
    access_code text NULL,
    raw_init jsonb NOT NULL DEFAULT '{}'::jsonb,
    raw_verify jsonb NOT NULL DEFAULT '{}'::jsonb,
    completed_at timestamptz NULL,
    -- Set when this intent was credited to the wallet (idempotency anchor).
    credited_tx_id uuid NULL REFERENCES wallet_transactions(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE payment_intents IS 'One row per Paystack transaction attempt; resolves to a wallet credit on success.';
CREATE UNIQUE INDEX payment_intents_provider_reference_idx
    ON payment_intents (provider, provider_reference);
CREATE INDEX payment_intents_account_id_created_at_idx
    ON payment_intents (account_id, created_at DESC);
CREATE INDEX payment_intents_status_idx ON payment_intents (status);

CREATE TABLE webhook_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL CHECK (provider IN ('paystack','whatsapp','stripe')),
    -- For Paystack we use the body's `data.id` (numeric) as the dedupe key.
    -- Falls back to a sha256 of the body if the provider omits an id.
    event_id text NOT NULL,
    event_type text NOT NULL,
    signature text NULL,
    payload jsonb NOT NULL,
    processed_at timestamptz NULL,
    error text NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE webhook_events IS 'Append-only inbound webhook log. Used for idempotency and audit.';
CREATE UNIQUE INDEX webhook_events_provider_event_id_idx
    ON webhook_events (provider, event_id);
CREATE INDEX webhook_events_received_at_idx ON webhook_events (received_at DESC);

-- RLS: account-admin reads its own intents; webhooks bypass via anon db.
ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_intents_admin ON payment_intents
    FOR ALL
    USING (app.is_account_admin(account_id) OR app.current_user_id() IS NULL)
    WITH CHECK (app.is_account_admin(account_id) OR app.current_user_id() IS NULL);

-- webhook_events: only platform admin or anon (server-side) can touch.
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_events_admin ON webhook_events
    FOR ALL
    USING (app.is_platform_admin() OR app.current_user_id() IS NULL)
    WITH CHECK (app.is_platform_admin() OR app.current_user_id() IS NULL);

-- ============================================================================
-- 20260505100000_maintenance.sql
-- ============================================================================

-- 20260505100000_maintenance.sql
-- Maintenance tracking for access points: cumulative meters, service events
-- log, and a derived next-due timestamp.
--
-- Each access_logs insert advances the per-access-point meter using the gate
-- movement constant from location_settings (meters per op). Service events
-- snapshot the meter at service time and set a threshold for the next.

CREATE TABLE access_point_meters (
    access_point_id uuid PRIMARY KEY REFERENCES access_points(id) ON DELETE CASCADE,
    movement_m numeric(14,2) NOT NULL DEFAULT 0,
    total_opens int NOT NULL DEFAULT 0,
    total_closes int NOT NULL DEFAULT 0,
    last_op_at timestamptz NULL,
    last_serviced_at timestamptz NULL,
    last_service_movement_m numeric(14,2) NULL,
    next_due_movement_m numeric(14,2) NULL,
    next_due_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE access_point_meters IS 'Live cumulative wear meters per access point. Updated by trigger on access_logs.';

CREATE TABLE maintenance_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    access_point_id uuid NOT NULL REFERENCES access_points(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('inspection','service','repair','replacement')),
    performed_at timestamptz NOT NULL DEFAULT now(),
    performed_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    technician_name text NULL,
    notes text NULL,
    parts jsonb NOT NULL DEFAULT '[]'::jsonb,
    cost_zar_cents bigint NULL,
    -- Snapshot of the wear meter at the moment of service. Lets us compute
    -- the *next* due date based on historical pace.
    movement_m_at_event numeric(14,2) NULL,
    -- Threshold for the next service, expressed both as a movement target
    -- and a calendar fallback. The earlier of the two wins.
    next_due_movement_m numeric(14,2) NULL,
    next_due_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE maintenance_events IS 'Append-only log of inspections / services / repairs / replacements per access point.';
CREATE INDEX maintenance_events_access_point_id_performed_at_idx
    ON maintenance_events (access_point_id, performed_at DESC);
CREATE INDEX maintenance_events_kind_idx ON maintenance_events (kind);

-- Bootstrap one meters row per existing access_point.
INSERT INTO access_point_meters (access_point_id)
SELECT id FROM access_points
ON CONFLICT (access_point_id) DO NOTHING;

-- Auto-create the meters row for new access points.
CREATE OR REPLACE FUNCTION app.access_points_init_meters()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO access_point_meters (access_point_id)
    VALUES (NEW.id)
    ON CONFLICT (access_point_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS access_points_init_meters_trg ON access_points;
CREATE TRIGGER access_points_init_meters_trg
AFTER INSERT ON access_points
FOR EACH ROW EXECUTE FUNCTION app.access_points_init_meters();

-- Advance the meter for every successful open/close. Pulls movement constant
-- from location_settings, falling back to a default if none is configured.
CREATE OR REPLACE FUNCTION app.access_logs_advance_meter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    move_per_op numeric(8,2);
BEGIN
    IF NEW.access_point_id IS NULL OR NOT NEW.success THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(ls.gate_movement_m_per_op, 3.5)
      INTO move_per_op
      FROM access_points ap
      LEFT JOIN location_settings ls ON ls.location_id = ap.location_id
      WHERE ap.id = NEW.access_point_id;

    IF move_per_op IS NULL THEN
        move_per_op := 3.5;
    END IF;

    INSERT INTO access_point_meters (access_point_id, movement_m, total_opens, total_closes, last_op_at)
    VALUES (
        NEW.access_point_id,
        move_per_op,
        CASE WHEN NEW.command = 'open' THEN 1 ELSE 0 END,
        CASE WHEN NEW.command = 'close' THEN 1 ELSE 0 END,
        NEW.ts
    )
    ON CONFLICT (access_point_id) DO UPDATE SET
        movement_m   = access_point_meters.movement_m + EXCLUDED.movement_m,
        total_opens  = access_point_meters.total_opens + EXCLUDED.total_opens,
        total_closes = access_point_meters.total_closes + EXCLUDED.total_closes,
        last_op_at   = GREATEST(access_point_meters.last_op_at, EXCLUDED.last_op_at),
        updated_at   = now();

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS access_logs_advance_meter_trg ON access_logs;
CREATE TRIGGER access_logs_advance_meter_trg
AFTER INSERT ON access_logs
FOR EACH ROW EXECUTE FUNCTION app.access_logs_advance_meter();

-- After a maintenance event, snapshot the current meter into the access point
-- meters row and adopt the event's next-due thresholds.
CREATE OR REPLACE FUNCTION app.maintenance_events_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    current_movement numeric(14,2);
BEGIN
    SELECT movement_m INTO current_movement
      FROM access_point_meters
      WHERE access_point_id = NEW.access_point_id;

    IF current_movement IS NULL THEN
        INSERT INTO access_point_meters (access_point_id) VALUES (NEW.access_point_id);
        current_movement := 0;
    END IF;

    -- If the caller didn't snapshot a meter reading, use the live one.
    IF NEW.movement_m_at_event IS NULL THEN
        UPDATE maintenance_events
            SET movement_m_at_event = current_movement
            WHERE id = NEW.id;
        NEW.movement_m_at_event := current_movement;
    END IF;

    -- 'service' / 'repair' / 'replacement' reset the wear baseline; pure
    -- inspections do not.
    IF NEW.kind IN ('service','repair','replacement') THEN
        UPDATE access_point_meters SET
            last_serviced_at        = NEW.performed_at,
            last_service_movement_m = NEW.movement_m_at_event,
            next_due_movement_m     = NEW.next_due_movement_m,
            next_due_at             = NEW.next_due_at,
            updated_at              = now()
        WHERE access_point_id = NEW.access_point_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS maintenance_events_after_insert_trg ON maintenance_events;
CREATE TRIGGER maintenance_events_after_insert_trg
AFTER INSERT ON maintenance_events
FOR EACH ROW EXECUTE FUNCTION app.maintenance_events_after_insert();

-- RLS: meters readable by any account member, writable only by the trigger
-- (i.e. nobody — system-managed). Maintenance events: members read, admins write.
ALTER TABLE access_point_meters ENABLE ROW LEVEL SECURITY;
CREATE POLICY access_point_meters_member ON access_point_meters
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM access_points ap
            JOIN locations l ON l.id = ap.location_id
            WHERE ap.id = access_point_meters.access_point_id
              AND app.is_account_member(l.account_id)
        )
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );

ALTER TABLE maintenance_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY maintenance_events_select ON maintenance_events
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM access_points ap
            JOIN locations l ON l.id = ap.location_id
            WHERE ap.id = maintenance_events.access_point_id
              AND app.is_account_member(l.account_id)
        )
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY maintenance_events_write ON maintenance_events
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM access_points ap
            JOIN locations l ON l.id = ap.location_id
            WHERE ap.id = maintenance_events.access_point_id
              AND app.is_account_admin(l.account_id)
        )
    );
CREATE POLICY maintenance_events_update ON maintenance_events
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM access_points ap
            JOIN locations l ON l.id = ap.location_id
            WHERE ap.id = maintenance_events.access_point_id
              AND app.is_account_admin(l.account_id)
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM access_points ap
            JOIN locations l ON l.id = ap.location_id
            WHERE ap.id = maintenance_events.access_point_id
              AND app.is_account_admin(l.account_id)
        )
    );

-- ============================================================================
-- 20260505110000_referrals.sql
-- ============================================================================

-- 20260505110000_referrals.sql
-- Referral program: per-user slug, attribution, ongoing earnings ledger,
-- KYC profile (required before payout), and payout requests.

-- ---------------------------------------------------------------------------
-- users: slug + referrer pointer
-- ---------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN referral_slug text NULL,
    ADD COLUMN referral_slug_updated_at timestamptz NULL,
    ADD COLUMN referred_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN referral_attributed_at timestamptz NULL;

ALTER TABLE users
    ADD CONSTRAINT users_referral_slug_format CHECK (
        referral_slug IS NULL
        OR (
            length(referral_slug) BETWEEN 3 AND 30
            AND referral_slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'
            AND referral_slug !~ '--'
        )
    );

CREATE UNIQUE INDEX users_referral_slug_idx
    ON users (referral_slug)
    WHERE referral_slug IS NOT NULL;
CREATE INDEX users_referred_by_user_id_idx ON users (referred_by_user_id);

-- ---------------------------------------------------------------------------
-- attribution: one row per referee, locks who they belong to
-- ---------------------------------------------------------------------------
CREATE TABLE referral_attributions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    via_slug text NOT NULL,
    landed_at timestamptz NULL,
    attributed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (referee_user_id),
    CHECK (referrer_user_id <> referee_user_id)
);
COMMENT ON TABLE referral_attributions IS 'Locks each referee to exactly one referrer for life.';
CREATE INDEX referral_attributions_referrer_idx
    ON referral_attributions (referrer_user_id);

-- ---------------------------------------------------------------------------
-- earnings ledger: one row per crediting event
-- ---------------------------------------------------------------------------
CREATE TABLE referral_earnings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_payment_intent_id uuid NULL REFERENCES payment_intents(id) ON DELETE SET NULL,
    source_kind text NOT NULL CHECK (source_kind IN ('wallet_topup','subscription','adjustment')),
    amount_zar_cents bigint NOT NULL CHECK (amount_zar_cents > 0),
    rate_bps int NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
    note text NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE referral_earnings IS 'Append-only ledger of referral credits.';
CREATE INDEX referral_earnings_referrer_created_idx
    ON referral_earnings (referrer_user_id, created_at DESC);
CREATE UNIQUE INDEX referral_earnings_per_intent_idx
    ON referral_earnings (source_payment_intent_id)
    WHERE source_payment_intent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- KYC profile: required before a payout can be requested
-- ---------------------------------------------------------------------------
CREATE TABLE kyc_profiles (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    full_name text NULL,
    contact_email citext NULL,
    cellphone text NULL,
    id_kind text NULL CHECK (id_kind IS NULL OR id_kind IN ('za_id','passport')),
    id_number text NULL,
    bank_name text NULL,
    bank_branch_code text NULL,
    bank_account_number text NULL,
    bank_account_holder text NULL,
    bank_account_type text NULL CHECK (
        bank_account_type IS NULL OR bank_account_type IN ('cheque','savings','transmission')
    ),
    verified_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE kyc_profiles IS 'KYC details captured before payout. One per user.';

-- ---------------------------------------------------------------------------
-- payout requests
-- ---------------------------------------------------------------------------
CREATE TABLE payout_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_zar_cents bigint NOT NULL CHECK (amount_zar_cents > 0),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','paid','rejected','cancelled')),
    -- KYC values frozen at request time so historical records stay accurate.
    kyc_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    paystack_transfer_code text NULL,
    notes text NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz NULL,
    processed_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE payout_requests IS 'User-initiated payout against earned referral balance.';
CREATE INDEX payout_requests_user_status_idx ON payout_requests (user_id, status);
CREATE INDEX payout_requests_status_idx ON payout_requests (status);

-- ---------------------------------------------------------------------------
-- trigger: when a payment intent flips to succeeded, write a referral earning
-- if the payer's user has a referrer. Idempotent via the unique-per-intent
-- index, so reruns are safe.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payment_intents_attribute_referral()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    referrer uuid;
    rate_bps_val int := 1000;  -- 10%
    payer uuid;
BEGIN
    IF NEW.status <> 'succeeded' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'succeeded' THEN
        RETURN NEW;
    END IF;
    IF NEW.purpose <> 'wallet_topup' THEN
        RETURN NEW;
    END IF;

    payer := NEW.initiated_by;
    IF payer IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT referred_by_user_id INTO referrer FROM users WHERE id = payer;
    IF referrer IS NULL OR referrer = payer THEN
        RETURN NEW;
    END IF;

    INSERT INTO referral_earnings
        (referrer_user_id, referee_user_id, source_payment_intent_id,
         source_kind, amount_zar_cents, rate_bps)
    VALUES
        (referrer, payer, NEW.id, 'wallet_topup',
         GREATEST(1, (NEW.amount_cents * rate_bps_val) / 10000),
         rate_bps_val)
    ON CONFLICT (source_payment_intent_id) DO NOTHING;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_intents_attribute_referral_trg ON payment_intents;
CREATE TRIGGER payment_intents_attribute_referral_trg
AFTER INSERT OR UPDATE ON payment_intents
FOR EACH ROW EXECUTE FUNCTION app.payment_intents_attribute_referral();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

-- referral_attributions: visible to either side of the relationship + admin.
-- Writes only by the trigger / app via anon (current_user_id IS NULL).
ALTER TABLE referral_attributions ENABLE ROW LEVEL SECURITY;
CREATE POLICY referral_attributions_select ON referral_attributions
    FOR SELECT
    USING (
        referrer_user_id = app.current_user_id()
        OR referee_user_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY referral_attributions_write ON referral_attributions
    FOR INSERT
    WITH CHECK (app.current_user_id() IS NULL OR app.is_platform_admin());

-- referral_earnings: a referrer reads their own. Writes only via system path.
ALTER TABLE referral_earnings ENABLE ROW LEVEL SECURITY;
CREATE POLICY referral_earnings_select ON referral_earnings
    FOR SELECT
    USING (
        referrer_user_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY referral_earnings_write ON referral_earnings
    FOR INSERT
    WITH CHECK (app.current_user_id() IS NULL OR app.is_platform_admin());

-- kyc_profiles: each user manages their own.
ALTER TABLE kyc_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY kyc_profiles_self ON kyc_profiles
    FOR ALL
    USING (
        user_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    )
    WITH CHECK (
        user_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );

-- payout_requests: user reads/creates their own; user can cancel pending;
-- admin owns approve/pay/reject.
ALTER TABLE payout_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY payout_requests_select ON payout_requests
    FOR SELECT
    USING (
        user_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY payout_requests_insert ON payout_requests
    FOR INSERT
    WITH CHECK (
        user_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY payout_requests_cancel ON payout_requests
    FOR UPDATE
    USING (user_id = app.current_user_id() AND status = 'pending')
    WITH CHECK (user_id = app.current_user_id() AND status IN ('pending','cancelled'));
CREATE POLICY payout_requests_admin ON payout_requests
    FOR UPDATE
    USING (app.is_platform_admin() OR app.current_user_id() IS NULL)
    WITH CHECK (app.is_platform_admin() OR app.current_user_id() IS NULL);

-- ============================================================================
-- 20260505120000_monthly_payouts.sql
-- ============================================================================

-- 20260505120000_monthly_payouts.sql
-- Convert payout_requests to a fully automatic monthly system. Adds a period
-- key (YYYY-MM) so the cron can dedupe per user per month, plus a Paystack
-- transfer recipient cache on kyc_profiles and the transfer-id / failure-
-- reason columns on the request itself.

ALTER TABLE kyc_profiles
    ADD COLUMN paystack_recipient_code text NULL,
    ADD COLUMN paystack_recipient_synced_at timestamptz NULL;

ALTER TABLE payout_requests
    ADD COLUMN payout_period text NULL,
    ADD COLUMN paystack_transfer_id text NULL,
    ADD COLUMN failure_reason text NULL,
    ADD COLUMN auto_generated boolean NOT NULL DEFAULT false;

-- Period key shape: 'YYYY-MM' (UTC). Validated when present.
ALTER TABLE payout_requests
    ADD CONSTRAINT payout_requests_period_format
    CHECK (payout_period IS NULL OR payout_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- One live payout per user per period. Failed/cancelled rows do not block
-- a future retry for the same period.
CREATE UNIQUE INDEX payout_requests_user_period_live_idx
    ON payout_requests (user_id, payout_period)
    WHERE payout_period IS NOT NULL
      AND status IN ('pending', 'approved', 'paid');

CREATE INDEX payout_requests_period_idx ON payout_requests (payout_period);
CREATE UNIQUE INDEX payout_requests_paystack_transfer_id_idx
    ON payout_requests (paystack_transfer_id)
    WHERE paystack_transfer_id IS NOT NULL;

-- ============================================================================
-- 20260505130000_temp_access.sql
-- ============================================================================

-- 20260505130000_temp_access.sql
-- Temporary access grants. A WhatsApp number can be authorised to operate one
-- or more access points for a defined time window, with an optional cap on
-- the number of uses. Membership of a registered user is NOT required — the
-- grant is keyed on the phone number itself.

CREATE TABLE temporary_access_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    granted_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
    visitor_name text NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    max_uses int NULL CHECK (max_uses IS NULL OR max_uses >= 1),
    uses_count int NOT NULL DEFAULT 0,
    -- User-controlled state. Derived states (pending / expired / exhausted)
    -- are computed at read time from starts_at / ends_at / uses_count.
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    revoked_at timestamptz NULL,
    revoked_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    notes text NULL,
    last_used_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);
COMMENT ON TABLE temporary_access_grants
    IS 'Time-bounded access for a WhatsApp phone number to one or more access points.';
CREATE INDEX temporary_access_grants_account_id_idx
    ON temporary_access_grants (account_id);
CREATE INDEX temporary_access_grants_phone_idx
    ON temporary_access_grants (phone_e164);
CREATE INDEX temporary_access_grants_active_window_idx
    ON temporary_access_grants (status, starts_at, ends_at);

CREATE TABLE temporary_access_grant_access_points (
    grant_id uuid NOT NULL REFERENCES temporary_access_grants(id) ON DELETE CASCADE,
    access_point_id uuid NOT NULL REFERENCES access_points(id) ON DELETE CASCADE,
    PRIMARY KEY (grant_id, access_point_id)
);
COMMENT ON TABLE temporary_access_grant_access_points
    IS 'Many-to-many: a grant covers one or more access points.';
CREATE INDEX temporary_access_grant_access_points_ap_idx
    ON temporary_access_grant_access_points (access_point_id);

-- Atomic consume: returns the grant id on success, NULL otherwise.
-- Locks the row for update and increments uses_count + last_used_at if the
-- grant is currently usable for the supplied access point. Used by the
-- WhatsApp inbound flow so the cap can't be raced past.
CREATE OR REPLACE FUNCTION app.try_consume_grant(
    in_phone text,
    in_access_point_id uuid,
    in_ts timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    target_grant uuid;
BEGIN
    SELECT g.id INTO target_grant
    FROM temporary_access_grants g
    JOIN temporary_access_grant_access_points t
      ON t.grant_id = g.id AND t.access_point_id = in_access_point_id
    WHERE g.phone_e164 = in_phone
      AND g.status = 'active'
      AND g.starts_at <= in_ts
      AND g.ends_at > in_ts
      AND (g.max_uses IS NULL OR g.uses_count < g.max_uses)
    ORDER BY g.ends_at ASC
    LIMIT 1
    FOR UPDATE OF g;

    IF target_grant IS NULL THEN
        RETURN NULL;
    END IF;

    UPDATE temporary_access_grants
    SET uses_count = uses_count + 1,
        last_used_at = in_ts,
        updated_at = now()
    WHERE id = target_grant;

    RETURN target_grant;
END;
$$;

-- RLS: account members read; admins write/revoke. Anon (system, e.g. WA
-- engine) is allowed via current_user_id IS NULL paths.
ALTER TABLE temporary_access_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY temporary_access_grants_select ON temporary_access_grants
    FOR SELECT
    USING (
        app.is_account_member(account_id)
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY temporary_access_grants_insert ON temporary_access_grants
    FOR INSERT
    WITH CHECK (
        app.is_account_admin(account_id)
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY temporary_access_grants_update ON temporary_access_grants
    FOR UPDATE
    USING (
        app.is_account_admin(account_id)
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    )
    WITH CHECK (
        app.is_account_admin(account_id)
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY temporary_access_grants_delete ON temporary_access_grants
    FOR DELETE
    USING (
        app.is_account_admin(account_id)
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );

ALTER TABLE temporary_access_grant_access_points ENABLE ROW LEVEL SECURITY;
CREATE POLICY temporary_access_grant_access_points_select
    ON temporary_access_grant_access_points
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM temporary_access_grants g
            WHERE g.id = grant_id
              AND (
                app.is_account_member(g.account_id)
                OR app.current_user_id() IS NULL
                OR app.is_platform_admin()
              )
        )
    );
CREATE POLICY temporary_access_grant_access_points_write
    ON temporary_access_grant_access_points
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM temporary_access_grants g
            WHERE g.id = grant_id
              AND (
                app.is_account_admin(g.account_id)
                OR app.current_user_id() IS NULL
                OR app.is_platform_admin()
              )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM temporary_access_grants g
            WHERE g.id = grant_id
              AND (
                app.is_account_admin(g.account_id)
                OR app.current_user_id() IS NULL
                OR app.is_platform_admin()
              )
        )
    );

-- ============================================================================
-- 20260505140000_fix_referral_trigger.sql
-- ============================================================================

-- 20260505140000_fix_referral_trigger.sql
-- The referral attribution trigger writes referral_earnings with
-- ON CONFLICT (source_payment_intent_id), but that column has a partial
-- unique index (WHERE source_payment_intent_id IS NOT NULL). Postgres
-- requires the predicate be repeated on ON CONFLICT for inference; without
-- it Postgres raises 42P10 ("there is no unique or exclusion constraint
-- matching the ON CONFLICT specification") and the trigger aborts the
-- caller's UPDATE, blocking the wallet credit.

CREATE OR REPLACE FUNCTION app.payment_intents_attribute_referral()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    referrer uuid;
    rate_bps_val int := 1000;  -- 10%
    payer uuid;
BEGIN
    IF NEW.status <> 'succeeded' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'succeeded' THEN
        RETURN NEW;
    END IF;
    IF NEW.purpose <> 'wallet_topup' THEN
        RETURN NEW;
    END IF;

    payer := NEW.initiated_by;
    IF payer IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT referred_by_user_id INTO referrer FROM users WHERE id = payer;
    IF referrer IS NULL OR referrer = payer THEN
        RETURN NEW;
    END IF;

    INSERT INTO referral_earnings
        (referrer_user_id, referee_user_id, source_payment_intent_id,
         source_kind, amount_zar_cents, rate_bps)
    VALUES
        (referrer, payer, NEW.id, 'wallet_topup',
         GREATEST(1, (NEW.amount_cents * rate_bps_val) / 10000),
         rate_bps_val)
    ON CONFLICT (source_payment_intent_id)
        WHERE source_payment_intent_id IS NOT NULL
        DO NOTHING;

    RETURN NEW;
END;
$$;

-- ============================================================================
-- 20260505150000_force_rls.sql
-- ============================================================================

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

-- ============================================================================
-- 20260505160000_internal_role_for_rls_functions.sql
-- ============================================================================

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

-- ============================================================================
-- 20260505170000_payout_requests_updated_at.sql
-- ============================================================================

-- 20260505170000_payout_requests_updated_at.sql
-- The cron + webhook update payout_requests.updated_at, but the column was
-- never added. Add it now.

ALTER TABLE payout_requests
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
