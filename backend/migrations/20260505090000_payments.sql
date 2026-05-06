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
