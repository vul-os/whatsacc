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
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
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
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
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
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE wallets IS 'Prepaid balance held by an account.';

CREATE TABLE wallet_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    delta_cents bigint NOT NULL,
    reason text NOT NULL,
    reference text NULL,
    ts timestamptz NOT NULL DEFAULT timezone('utc', now()),
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE wallet_transactions IS 'Append-only ledger of wallet credits and debits.';
CREATE INDEX wallet_transactions_account_id_ts_idx ON wallet_transactions (account_id, ts DESC);

CREATE TABLE usage_counters (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    period text NOT NULL,
    messages_used int NOT NULL DEFAULT 0,
    opens int NOT NULL DEFAULT 0,
    closes int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    PRIMARY KEY (account_id, period)
);
COMMENT ON TABLE usage_counters IS 'Per-account per-month usage counters (yyyy-mm period).';
