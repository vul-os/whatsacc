-- 20260505000000_baseline.sql
-- Clean baseline schema for whatsacc: auth, tenancy, access control,
-- WhatsApp / Telegram / Slack messaging, maintenance tracking, temporary
-- access grants, and row-level security.
--
-- Folded from the previous ordered migration set:
--   - 20260505000000_foundation.sql
--   - 20260507000000_app_role_for_rls.sql
--   - 20260511000000_telegram_slack.sql
--   - 20260512000000_invites_whatsapp.sql
--   - 20260516000000_profile_avatar_source.sql

-- ============================================================================
-- Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ============================================================================
-- Reference data: countries
-- ============================================================================

CREATE TABLE countries (
    code text PRIMARY KEY CHECK (length(code) = 2 AND code = upper(code)),
    name text NOT NULL,
    flag_emoji text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE countries IS 'Supported countries. Reference data for signup and account region.';

INSERT INTO countries (code, name, flag_emoji) VALUES
    ('ZA', 'South Africa',   '🇿🇦'),
    ('NG', 'Nigeria',        '🇳🇬'),
    ('KE', 'Kenya',          '🇰🇪'),
    ('US', 'United States',  '🇺🇸'),
    ('CA', 'Canada',         '🇨🇦'),
    ('BR', 'Brazil',         '🇧🇷'),
    ('MX', 'Mexico',         '🇲🇽'),
    ('GB', 'United Kingdom', '🇬🇧'),
    ('DE', 'Germany',        '🇩🇪'),
    ('FR', 'France',         '🇫🇷'),
    ('AE', 'UAE',            '🇦🇪'),
    ('IN', 'India',          '🇮🇳'),
    ('ID', 'Indonesia',      '🇮🇩'),
    ('PH', 'Philippines',    '🇵🇭'),
    ('AU', 'Australia',      '🇦🇺');

-- ============================================================================
-- Authentication: users, profiles, oauth, tokens, phone numbers
-- ============================================================================

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
    -- 'google'  — last set from the Google `picture` claim on sign-in;
    --             refreshed on every subsequent Google sign-in.
    -- 'user'    — last set by the account holder via PATCH /auth/me/profile;
    --             sign-in MUST NOT overwrite this.
    -- NULL      — no avatar set; treated as 'google' for refresh purposes.
    avatar_source text NULL CHECK (avatar_source IS NULL OR avatar_source IN ('google', 'user')),
    -- Forward-compatibility hook for a CDN-cached copy of avatar_url.
    avatar_cdn_url text NULL,
    locale text NOT NULL DEFAULT 'en',
    country_code text NULL REFERENCES countries(code),
    -- Optional Slack identity fields for linking Slack bot users to profiles.
    slack_user_id text,
    slack_handle text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE profiles IS 'Per-user profile metadata, 1:1 with users.';
COMMENT ON COLUMN profiles.slack_user_id IS 'Slack user ID, e.g. U123ABC, used to link bot messages to a profile.';
COMMENT ON COLUMN profiles.slack_handle IS 'Optional Slack handle without @, used for display and support.';

CREATE UNIQUE INDEX profiles_slack_user_id_unique
    ON profiles (slack_user_id)
    WHERE slack_user_id IS NOT NULL;
CREATE INDEX profiles_slack_handle_idx
    ON profiles (lower(slack_handle))
    WHERE slack_handle IS NOT NULL;

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
-- Tenancy: accounts, members, invites, locations, overrides and settings
-- ============================================================================

CREATE TABLE accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    country_code text NOT NULL DEFAULT 'ZA' REFERENCES countries(code),
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE accounts IS 'Top-level tenant owning locations and members.';
CREATE INDEX accounts_country_code_idx ON accounts (country_code);

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
    phone_e164 text CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NULL REFERENCES users(id) ON DELETE SET NULL
);
COMMENT ON TABLE account_invites IS 'Pending invitations to join an account.';
COMMENT ON COLUMN account_invites.phone_e164 IS 'Optional phone number to notify via WhatsApp when the invite is sent.';
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
-- Access control: devices, access points, command queue, access logs
-- ============================================================================

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
-- WhatsApp (Meta Cloud API) chat threads and messages
-- ============================================================================

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
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Prevents duplicate processing when Meta retries webhook delivery.
    CONSTRAINT whatsapp_messages_provider_message_id_unique UNIQUE (provider_message_id)
);
COMMENT ON TABLE whatsapp_messages IS 'Individual WhatsApp messages exchanged on a chat.';
CREATE INDEX whatsapp_messages_chat_id_ts_idx ON whatsapp_messages (chat_id, ts DESC);

-- ============================================================================
-- Telegram and Slack chat threads and messages
-- ============================================================================

CREATE TABLE telegram_chats (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id bigint UNIQUE NOT NULL, -- Telegram chat ID
    profile_id uuid NULL REFERENCES profiles(id) ON DELETE SET NULL,
    username text,
    first_name text,
    last_name text,
    last_inbound_at timestamptz,
    last_outbound_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE telegram_chats IS 'Telegram conversation thread, one per chat/user.';
CREATE INDEX telegram_chats_profile_id_idx ON telegram_chats (profile_id);

CREATE TABLE telegram_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id uuid NOT NULL REFERENCES telegram_chats(id) ON DELETE CASCADE,
    direction text NOT NULL CHECK (direction IN ('in','out')),
    kind text NOT NULL CHECK (kind IN ('text','location','photo','document','system')),
    body jsonb NOT NULL,
    provider_message_id text,
    status text,
    ts timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE telegram_messages IS 'Individual Telegram messages exchanged on a chat.';
CREATE INDEX telegram_messages_chat_id_ts_idx ON telegram_messages (chat_id, ts DESC);
CREATE INDEX telegram_messages_provider_message_id_idx
    ON telegram_messages (provider_message_id)
    WHERE provider_message_id IS NOT NULL;

CREATE TABLE slack_chats (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id text UNIQUE NOT NULL, -- Slack channel ID (C...) or DM (D...)
    team_id text NOT NULL,
    profile_id uuid NULL REFERENCES profiles(id) ON DELETE SET NULL,
    last_inbound_at timestamptz,
    last_outbound_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE slack_chats IS 'Slack conversation thread, one per channel/DM.';
CREATE INDEX slack_chats_profile_id_idx ON slack_chats (profile_id);

CREATE TABLE slack_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id uuid NOT NULL REFERENCES slack_chats(id) ON DELETE CASCADE,
    direction text NOT NULL CHECK (direction IN ('in','out')),
    kind text NOT NULL CHECK (kind IN ('text','file','system')),
    body jsonb NOT NULL,
    provider_message_id text,
    status text,
    ts timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE slack_messages IS 'Individual Slack messages exchanged on a chat.';
CREATE INDEX slack_messages_chat_id_ts_idx ON slack_messages (chat_id, ts DESC);
CREATE INDEX slack_messages_provider_message_id_idx
    ON slack_messages (provider_message_id)
    WHERE provider_message_id IS NOT NULL;

-- ============================================================================
-- Row-level security: helper functions in `app` schema and per-table policies
-- ============================================================================

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
-- countries (reference data: world-readable, platform-admin write)
-- =========================================================================
ALTER TABLE countries ENABLE ROW LEVEL SECURITY;
CREATE POLICY countries_read ON countries FOR SELECT USING (true);
CREATE POLICY countries_insert ON countries FOR INSERT WITH CHECK (app.is_platform_admin());
CREATE POLICY countries_update ON countries FOR UPDATE USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());
CREATE POLICY countries_delete ON countries FOR DELETE USING (app.is_platform_admin());

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
-- telegram_chats
-- =========================================================================
ALTER TABLE telegram_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY telegram_chats_owner ON telegram_chats
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
-- telegram_messages
-- =========================================================================
ALTER TABLE telegram_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY telegram_messages_owner ON telegram_messages
    FOR ALL
    USING (
        app.is_platform_admin()
        OR app.current_user_id() IS NULL
        OR EXISTS (
            SELECT 1 FROM telegram_chats c
            WHERE c.id = telegram_messages.chat_id
              AND c.profile_id = app.current_user_id()
        )
    )
    WITH CHECK (
        app.is_platform_admin()
        OR app.current_user_id() IS NULL
        OR EXISTS (
            SELECT 1 FROM telegram_chats c
            WHERE c.id = telegram_messages.chat_id
              AND c.profile_id = app.current_user_id()
        )
    );

-- =========================================================================
-- slack_chats
-- =========================================================================
ALTER TABLE slack_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY slack_chats_owner ON slack_chats
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
-- slack_messages
-- =========================================================================
ALTER TABLE slack_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY slack_messages_owner ON slack_messages
    FOR ALL
    USING (
        app.is_platform_admin()
        OR app.current_user_id() IS NULL
        OR EXISTS (
            SELECT 1 FROM slack_chats c
            WHERE c.id = slack_messages.chat_id
              AND c.profile_id = app.current_user_id()
        )
    )
    WITH CHECK (
        app.is_platform_admin()
        OR app.current_user_id() IS NULL
        OR EXISTS (
            SELECT 1 FROM slack_chats c
            WHERE c.id = slack_messages.chat_id
              AND c.profile_id = app.current_user_id()
        )
    );

-- ============================================================================
-- Maintenance tracking for access points
-- ============================================================================
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
-- Temporary access grants
-- ============================================================================
-- A WhatsApp number can be authorised to operate one or more access points
-- for a defined time window, with an optional cap on the number of uses.
-- Membership of a registered user is NOT required — the grant is keyed on
-- the phone number itself.

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
-- Force row-level security
-- ============================================================================
-- ENABLE ROW LEVEL SECURITY only enforces RLS on non-owner roles. The app
-- connects with the role that owns the schema (whatsacc_app), so without
-- this every policy would be silently bypassed. FORCE applies the policies
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
-- Internal role for RLS helper / trigger functions
-- ============================================================================
-- With FORCE ROW LEVEL SECURITY on, SECURITY DEFINER helper functions like
-- app.is_account_member recurse into the policies of the tables they read
-- (account_members's SELECT policy calls is_account_member, which queries
-- account_members, which invokes the policy again). The fix is to own those
-- helpers with a separate role that has BYPASSRLS — SECURITY DEFINER then
-- lets them read past the policies.
--
-- The same role owns trigger functions that write into system-managed
-- tables (meters, grant consumption) where there is no direct write policy
-- on purpose.
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
ALTER FUNCTION app.try_consume_grant(text, uuid, timestamptz) OWNER TO whatsacc_internal;

-- Make sure the app role can call them.
GRANT EXECUTE ON FUNCTION app.is_account_member(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_account_admin(uuid)  TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.try_consume_grant(text, uuid, timestamptz) TO PUBLIC;

-- ============================================================================
-- Application role for per-request RLS (from 20260507000000_app_role_for_rls)
-- ============================================================================
-- Creates a NOLOGIN, non-BYPASSRLS role that the backend SET LOCAL ROLEs to
-- inside every request transaction (see lib/db.ts withRLS). The connection
-- itself still authenticates as the database owner (neondb_owner on Neon,
-- whatsacc_app on local) — but on Neon that role has BYPASSRLS=true, which
-- silently disables every RLS policy. Switching role per-transaction to a
-- non-BYPASSRLS role re-arms the policies without burning a separate
-- connection pool. Idempotent.

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
