-- 0001_baseline.sql
-- SQLite baseline for the lintel gateway, translated from the ESSENTIAL core
-- of backend/migrations/20260505000000_baseline.sql (Postgres) plus the
-- instance_settings table from 20260505020000_admin.sql.
--
-- Included: users, profiles, accounts, account_members, locations,
--           access_points, devices, access_logs, refresh_tokens,
--           instance_settings.
--
-- Deliberately DEFERRED (ported when their routes are ported):
--   countries (reference data; country_code kept as a plain 2-letter TEXT),
--   oauth_identities, password_reset_tokens, email_verification_tokens,
--   profile_phone_numbers, account_invites, location_members,
--   location_settings, device_commands, whatsapp_/telegram_/slack_ chat +
--   message tables, access_point_meters, maintenance_events,
--   temporary_access_grants, rate_limit tables, admin_audit_log.
--
-- Postgres RLS does not exist in SQLite. Tenancy is APP-LAYER: every store
-- method that touches tenant data takes an accountID and scopes its SQL to it
-- (see internal/store). Conventions: ids are UUIDv4 TEXT, timestamps are
-- INTEGER unix seconds (UTC), booleans are INTEGER 0/1, json is TEXT.

CREATE TABLE users (
    id                 TEXT PRIMARY KEY,
    email              TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash      TEXT,
    status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','disabled','pending')),
    email_verified_at  INTEGER,
    is_platform_admin  INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
);

CREATE TABLE profiles (
    id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name  TEXT,
    avatar_url    TEXT,
    avatar_source TEXT CHECK (avatar_source IS NULL OR avatar_source IN ('google','user')),
    locale        TEXT NOT NULL DEFAULT 'en',
    country_code  TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE refresh_tokens (
    id          TEXT PRIMARY KEY,
    family_id   TEXT NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    issued_at   INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked_at  INTEGER,
    replaced_by TEXT,
    user_agent  TEXT,
    ip          TEXT,
    created_at  INTEGER NOT NULL
);
CREATE INDEX refresh_tokens_user_id_idx   ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens (family_id);

CREATE TABLE accounts (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    country_code TEXT NOT NULL DEFAULT 'ZA',
    status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','suspended')),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE TABLE account_members (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
    status     TEXT NOT NULL DEFAULT 'active',
    invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    joined_at  INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, user_id)
);
CREATE INDEX account_members_user_id_idx ON account_members (user_id);

CREATE TABLE locations (
    id                 TEXT PRIMARY KEY,
    account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    parent_location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
    type               TEXT NOT NULL CHECK (type IN ('house','complex','building','other')),
    name               TEXT NOT NULL,
    slug               TEXT NOT NULL,
    address            TEXT NOT NULL DEFAULT '{}', -- json
    lat                REAL,
    long               REAL,
    status             TEXT NOT NULL DEFAULT 'active',
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    UNIQUE (account_id, slug)
);
CREATE INDEX locations_account_id_idx ON locations (account_id);

CREATE TABLE devices (
    id               TEXT PRIMARY KEY,
    location_id      TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    label            TEXT,
    claim_token_hash TEXT UNIQUE,
    claim_expires_at INTEGER,
    paired_at        INTEGER,
    last_seen_at     INTEGER,
    public_key       TEXT,
    status           TEXT NOT NULL DEFAULT 'unpaired',
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);
CREATE INDEX devices_location_id_idx ON devices (location_id);

CREATE TABLE access_points (
    id          TEXT PRIMARY KEY,
    location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('gate','door','barrier','other')),
    lat         REAL,
    long        REAL,
    device_id   TEXT REFERENCES devices(id) ON DELETE SET NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX access_points_location_id_idx ON access_points (location_id);
CREATE INDEX access_points_device_id_idx   ON access_points (device_id);

-- Append-only audit log, denormalised for analytics (as in the Postgres
-- baseline: account_id/location_id are stamped at insert time so history
-- survives deletes via ON DELETE SET NULL).
CREATE TABLE access_logs (
    id              TEXT PRIMARY KEY,
    access_point_id TEXT REFERENCES access_points(id) ON DELETE SET NULL,
    location_id     TEXT REFERENCES locations(id) ON DELETE SET NULL,
    account_id      TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
    command         TEXT,
    source          TEXT,
    lat             REAL,
    long            REAL,
    distance_m      REAL,
    success         INTEGER NOT NULL,
    error           TEXT,
    ts              INTEGER NOT NULL,
    created_at      INTEGER NOT NULL
);
CREATE INDEX access_logs_account_id_ts_idx  ON access_logs (account_id, ts DESC);
CREATE INDEX access_logs_location_id_ts_idx ON access_logs (location_id, ts DESC);

-- Internal instance-wide key/value settings. Holds the one-shot admin-claim
-- burn flag (key 'admin_claimed') and, later, rate-limit overrides.
CREATE TABLE instance_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL, -- json
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
