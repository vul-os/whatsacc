-- 20260505020000_auth.sql
-- Authentication: users, profiles, oauth, tokens, phone numbers.

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email citext UNIQUE NOT NULL,
    password_hash text NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','pending')),
    email_verified_at timestamptz NULL,
    is_platform_admin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE users IS 'Authenticated end-users of the platform.';

CREATE TABLE profiles (
    id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name text,
    avatar_url text,
    locale text NOT NULL DEFAULT 'en',
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE profiles IS 'Per-user profile metadata, 1:1 with users.';

CREATE TABLE oauth_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL,
    provider_sub text NOT NULL,
    email citext,
    linked_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    UNIQUE (provider, provider_sub)
);
COMMENT ON TABLE oauth_identities IS 'Linked external identity-provider identities per user.';
CREATE INDEX oauth_identities_user_id_idx ON oauth_identities (user_id);

CREATE TABLE refresh_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz NULL,
    replaced_by uuid NULL,
    user_agent text,
    ip inet,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
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
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE password_reset_tokens IS 'Single-use tokens for password reset flows.';
CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);

CREATE TABLE email_verification_tokens (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose text NOT NULL DEFAULT 'verify' CHECK (purpose IN ('verify')),
    expires_at timestamptz NOT NULL,
    used_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE email_verification_tokens IS 'Single-use tokens for email-address verification.';
CREATE INDEX email_verification_tokens_user_id_idx ON email_verification_tokens (user_id);

CREATE TABLE profile_phone_numbers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    phone_e164 text NOT NULL,
    verified_at timestamptz NULL,
    is_primary boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
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
