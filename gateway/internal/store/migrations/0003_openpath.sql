-- 0003_openpath.sql
-- Stage 3: temporary access grants + rate-limit counter tables (translated
-- from backend/migrations 20260505010000_rate_limits.sql and the grants
-- tables in the Postgres baseline).

CREATE TABLE temporary_access_grants (
    id                 TEXT PRIMARY KEY,
    account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    granted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    phone_e164         TEXT NOT NULL,
    visitor_name       TEXT,
    starts_at          INTEGER NOT NULL,
    ends_at            INTEGER NOT NULL,
    max_uses           INTEGER,
    uses_count         INTEGER NOT NULL DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    revoked_at         INTEGER,
    revoked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    notes              TEXT,
    last_used_at       INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
);
CREATE INDEX temp_grants_account_idx ON temporary_access_grants (account_id, created_at DESC);
CREATE INDEX temp_grants_phone_idx   ON temporary_access_grants (phone_e164);

CREATE TABLE temporary_access_grant_access_points (
    grant_id        TEXT NOT NULL REFERENCES temporary_access_grants(id) ON DELETE CASCADE,
    access_point_id TEXT NOT NULL REFERENCES access_points(id) ON DELETE CASCADE,
    PRIMARY KEY (grant_id, access_point_id)
);

-- Fixed-window counters (the Postgres rate_limit_counters, minus RLS: this
-- table is internal — no store accessor exposes it to tenants).
CREATE TABLE rate_limit_counters (
    scope        TEXT NOT NULL,
    subject      TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, subject, window_start)
);

-- Cooldown sentinels: last fully-allowed open per (subject, access point).
-- Only refreshed when an open is allowed — denials never restart a cooldown.
CREATE TABLE rate_limit_cooldowns (
    subject      TEXT PRIMARY KEY,
    last_open_at INTEGER NOT NULL
);
