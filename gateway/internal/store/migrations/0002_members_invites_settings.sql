-- 0002_members_invites_settings.sql
-- Stage 1 of the product-core port: per-location membership, admin quotas,
-- account invites and profile phone numbers, translated from the Postgres
-- baseline (backend/migrations/20260505000000_baseline.sql) with the same
-- SQLite conventions as 0001 (TEXT uuids, INTEGER unix seconds, 0/1 bools).

CREATE TABLE location_members (
    location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (location_id, user_id)
);
CREATE INDEX location_members_user_id_idx ON location_members (user_id);

-- Abuse-protection quotas (NOT billing — whatsacc has none). NULL = unlimited.
CREATE TABLE location_settings (
    location_id                    TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
    max_opens_per_member_per_day   INTEGER,
    max_opens_per_location_per_day INTEGER,
    created_at                     INTEGER NOT NULL,
    updated_at                     INTEGER NOT NULL
);

CREATE TABLE account_invites (
    id          TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email       TEXT NOT NULL COLLATE NOCASE,
    role        TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
    token_hash  TEXT NOT NULL UNIQUE,
    phone_e164  TEXT,
    expires_at  INTEGER NOT NULL,
    accepted_at INTEGER,
    accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    revoked_at  INTEGER,
    created_at  INTEGER NOT NULL
);
CREATE INDEX account_invites_account_id_idx ON account_invites (account_id);

CREATE TABLE profile_phone_numbers (
    id          TEXT PRIMARY KEY,
    profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    phone_e164  TEXT NOT NULL,
    is_primary  INTEGER NOT NULL DEFAULT 0,
    verified_at INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (profile_id, phone_e164)
);
-- One VERIFIED owner per number (the index invite-accept auto-verify used to
-- let attackers squat — invites now always link phones UNVERIFIED).
CREATE UNIQUE INDEX profile_phone_numbers_verified_unique
    ON profile_phone_numbers (phone_e164) WHERE verified_at IS NOT NULL;
