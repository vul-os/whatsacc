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
