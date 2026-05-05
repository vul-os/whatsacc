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
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
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
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
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
    requested_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    delivered_at timestamptz NULL,
    executed_at timestamptz NULL,
    error text NULL,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
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
    ts timestamptz NOT NULL DEFAULT timezone('utc', now()),
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE access_logs IS 'Append-only audit log of access attempts; denormalised for analytics.';
CREATE INDEX access_logs_location_id_ts_idx ON access_logs (location_id, ts DESC);
CREATE INDEX access_logs_account_id_ts_idx ON access_logs (account_id, ts DESC);
CREATE INDEX access_logs_access_point_id_ts_idx ON access_logs (access_point_id, ts DESC);
CREATE INDEX access_logs_user_id_ts_idx ON access_logs (user_id, ts DESC);
