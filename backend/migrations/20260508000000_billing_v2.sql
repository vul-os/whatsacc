-- 20260508000000_billing_v2.sql
-- Region-aware plans, invoices, and subscription-renewal audit.
-- Extends the existing plans / wallet schema to support per-region pricing
-- driven by billing-model/out/tiers.json (mirrored in src/lib/billing/tiers.ts).

-- ─────────────────────────────────────────────────────────────────────────────
-- plans: region_code + tier metadata
-- ─────────────────────────────────────────────────────────────────────────────

-- Replace the (code) unique with (code, region_code).
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_code_key;

ALTER TABLE plans
    ADD COLUMN region_code text NOT NULL DEFAULT 'us-ca'
        CHECK (region_code IN ('us-ca', 'eu-west', 'za', 'latam', 'in-sea')),
    ADD COLUMN included_opens int NOT NULL DEFAULT 0,
    ADD COLUMN included_residents int NOT NULL DEFAULT 0,
    ADD COLUMN included_locations int NOT NULL DEFAULT 1,
    ADD COLUMN payg_open_price_cents int NOT NULL DEFAULT 0,
    ADD COLUMN web_portal boolean NOT NULL DEFAULT true,
    ADD COLUMN blurb text NOT NULL DEFAULT '';

ALTER TABLE plans
    ADD CONSTRAINT plans_code_region_unique UNIQUE (code, region_code);

CREATE INDEX plans_region_code_idx ON plans (region_code);

-- The original 3 rows (free/starter/pro) are referenced by account_subscriptions,
-- so we update them in-place (preserving their primary keys + FK targets) to
-- become the ZA region's free/starter/business rows. Any old 'pro' becomes
-- 'business' since that's the closest tier in the new shape.

UPDATE plans
SET region_code = 'za', currency = 'ZAR', name = 'Free',
    monthly_message_quota = 100, included_opens = 100, included_residents = 5,
    included_devices = 1, included_locations = 1,
    price_cents = 0, payg_open_price_cents = 150,
    web_portal = true, blurb = 'Try it. Web portal access included.'
WHERE code = 'free';

UPDATE plans
SET region_code = 'za', currency = 'ZAR', name = 'Starter',
    monthly_message_quota = 900, included_opens = 900, included_residents = 30,
    included_devices = 3, included_locations = 1,
    price_cents = 34900, payg_open_price_cents = 150,
    web_portal = true, blurb = 'For a single estate or building.'
WHERE code = 'starter';

UPDATE plans
SET code = 'business', region_code = 'za', currency = 'ZAR', name = 'Business',
    monthly_message_quota = 9000, included_opens = 9000, included_residents = 300,
    included_devices = 20, included_locations = 5,
    price_cents = 229900, payg_open_price_cents = 150,
    web_portal = true, blurb = 'Multi-site or large estate.'
WHERE code = 'pro';

-- Seed the remaining 22 rows. Any pre-existing collision is a no-op.
INSERT INTO plans (
    code, name, region_code, currency,
    monthly_message_quota, included_opens, included_residents,
    included_devices, included_locations,
    price_cents, payg_open_price_cents,
    web_portal, blurb
) VALUES
-- ── US / Canada (USD) ────────────────────────────────────────────────────
('free',     'Free',     'us-ca', 'USD',    100,   100,    5,  1,  1,     0,  10, true, 'Try it. Web portal access included.'),
('starter',  'Starter',  'us-ca', 'USD',    900,   900,   30,  3,  1,  3899,  10, true, 'For a single estate or building.'),
('growth',   'Growth',   'us-ca', 'USD',   3000,  3000,  100,  8,  2,  9900,  10, true, 'Most popular — small estate.'),
('business', 'Business', 'us-ca', 'USD',   9000,  9000,  300, 20,  5, 24900,  10, true, 'Multi-site or large estate.'),
('scale',    'Scale',    'us-ca', 'USD',  30000, 30000, 1000, 60, 15, 69900,  10, true, 'Enterprise estates / property mgmt.'),
-- ── Western Europe (EUR) ─────────────────────────────────────────────────
('free',     'Free',     'eu-west', 'EUR',  100,   100,    5,  1,  1,     0,   8, true, 'Try it. Web portal access included.'),
('starter',  'Starter',  'eu-west', 'EUR',  900,   900,   30,  3,  1,  3199,   8, true, 'For a single estate or building.'),
('growth',   'Growth',   'eu-west', 'EUR', 3000,  3000,  100,  8,  2,  8299,   8, true, 'Most popular — small estate.'),
('business', 'Business', 'eu-west', 'EUR', 9000,  9000,  300, 20,  5, 20900,   8, true, 'Multi-site or large estate.'),
('scale',    'Scale',    'eu-west', 'EUR',30000, 30000, 1000, 60, 15, 57900,   8, true, 'Enterprise estates / property mgmt.'),
-- ── South Africa (ZAR) — free/starter/business handled by UPDATEs above ──
('growth',   'Growth',   'za', 'ZAR',     3000,  3000,  100,  8,  2,  89900, 150, true, 'Most popular — small estate.'),
('scale',    'Scale',    'za', 'ZAR',    30000, 30000, 1000, 60, 15, 629900, 150, true, 'Enterprise estates / property mgmt.'),
-- ── Brazil / LATAM (USD) ─────────────────────────────────────────────────
('free',     'Free',     'latam', 'USD',   100,   100,    5,  1,  1,     0,   4, true, 'Try it. Web portal access included.'),
('starter',  'Starter',  'latam', 'USD',   900,   900,   30,  3,  1,  1499,   4, true, 'For a single estate or building.'),
('growth',   'Growth',   'latam', 'USD',  3000,  3000,  100,  8,  2,  3899,   4, true, 'Most popular — small estate.'),
('business', 'Business', 'latam', 'USD',  9000,  9000,  300, 20,  5,  9799,   4, true, 'Multi-site or large estate.'),
('scale',    'Scale',    'latam', 'USD', 30000, 30000, 1000, 60, 15, 26900,   4, true, 'Enterprise estates / property mgmt.'),
-- ── India / SE Asia (USD) ────────────────────────────────────────────────
('free',     'Free',     'in-sea', 'USD',  100,   100,    5,  1,  1,     0,   3, true, 'Try it. Web portal access included.'),
('starter',  'Starter',  'in-sea', 'USD',  900,   900,   30,  3,  1,  1199,   3, true, 'For a single estate or building.'),
('growth',   'Growth',   'in-sea', 'USD', 3000,  3000,  100,  8,  2,  3099,   3, true, 'Most popular — small estate.'),
('business', 'Business', 'in-sea', 'USD', 9000,  9000,  300, 20,  5,  7799,   3, true, 'Multi-site or large estate.'),
('scale',    'Scale',    'in-sea', 'USD',30000, 30000, 1000, 60, 15, 21900,   3, true, 'Enterprise estates / property mgmt.');

-- ─────────────────────────────────────────────────────────────────────────────
-- invoices: PDF-rendered, with VAT line and stable invoice number sequence.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1000 INCREMENT 1;

CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- Human-readable invoice number ('INV-001000') — generated at insert time.
    number text NOT NULL UNIQUE,
    -- Source of this invoice: subscription renewal / wallet topup / manual / refund.
    kind text NOT NULL CHECK (kind IN ('subscription','wallet_topup','manual','refund')),
    -- Linked records.
    payment_intent_id uuid NULL REFERENCES payment_intents(id) ON DELETE SET NULL,
    plan_id uuid NULL REFERENCES plans(id),
    -- Currency + amounts. All cents/minor units in invoice's own currency.
    currency text NOT NULL,
    subtotal_cents bigint NOT NULL CHECK (subtotal_cents >= 0),
    vat_rate_bps int NOT NULL DEFAULT 0 CHECK (vat_rate_bps >= 0 AND vat_rate_bps <= 10000),
    vat_cents bigint NOT NULL DEFAULT 0 CHECK (vat_cents >= 0),
    total_cents bigint NOT NULL CHECK (total_cents >= 0),
    -- Bill-to snapshot — captured at issue time so historical invoices stay accurate
    -- even if the customer renames or moves.
    bill_to jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Issuer snapshot (our company details from .env at time of issue).
    issuer jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Line items: [{description, quantity, unit_cents, line_cents}]
    line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
    status text NOT NULL DEFAULT 'paid' CHECK (status IN ('draft','issued','paid','void','refunded')),
    issued_at timestamptz NOT NULL DEFAULT now(),
    paid_at timestamptz NULL,
    pdf_url text NULL,
    pdf_generated_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE invoices IS 'Issued invoices with frozen bill-to / issuer snapshots and computed VAT.';
CREATE INDEX invoices_account_id_issued_at_idx ON invoices (account_id, issued_at DESC);
CREATE INDEX invoices_payment_intent_id_idx ON invoices (payment_intent_id);
CREATE INDEX invoices_status_idx ON invoices (status);

-- Trigger to auto-assign sequential invoice number on insert.
CREATE OR REPLACE FUNCTION app.invoices_assign_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.number IS NULL OR NEW.number = '' THEN
        NEW.number := 'INV-' || lpad(nextval('invoice_number_seq')::text, 6, '0');
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_assign_number_trg
    BEFORE INSERT ON invoices
    FOR EACH ROW EXECUTE FUNCTION app.invoices_assign_number();

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_select ON invoices
    FOR SELECT
    USING (
        app.is_account_admin(account_id)
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY invoices_write ON invoices
    FOR ALL
    USING (app.current_user_id() IS NULL OR app.is_platform_admin())
    WITH CHECK (app.current_user_id() IS NULL OR app.is_platform_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- subscription_renewals: audit row per renewal attempt, used by the cron.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE subscription_renewals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    subscription_id uuid NOT NULL REFERENCES account_subscriptions(id) ON DELETE CASCADE,
    plan_id uuid NOT NULL REFERENCES plans(id),
    period_start timestamptz NOT NULL,
    period_end timestamptz NOT NULL,
    -- 'pending' → 'charged' | 'wallet_paid' | 'failed' | 'skipped'
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'charged', 'wallet_paid', 'failed', 'skipped')),
    attempt_count int NOT NULL DEFAULT 0,
    -- If charged, the payment intent that paid it.
    payment_intent_id uuid NULL REFERENCES payment_intents(id) ON DELETE SET NULL,
    invoice_id uuid NULL REFERENCES invoices(id) ON DELETE SET NULL,
    failure_reason text NULL,
    next_attempt_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- Idempotency: one renewal row per (subscription, period_start).
    UNIQUE (subscription_id, period_start)
);
COMMENT ON TABLE subscription_renewals IS 'Per-period renewal attempts; cron reads this and retries on failure.';
CREATE INDEX subscription_renewals_status_next_idx
    ON subscription_renewals (status, next_attempt_at);

ALTER TABLE subscription_renewals ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscription_renewals_select ON subscription_renewals
    FOR SELECT
    USING (
        app.is_account_admin(account_id)
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY subscription_renewals_write ON subscription_renewals
    FOR ALL
    USING (app.current_user_id() IS NULL OR app.is_platform_admin())
    WITH CHECK (app.current_user_id() IS NULL OR app.is_platform_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- account_subscriptions: extend with paystack identifiers and grace state.
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop the legacy stripe column name → paystack. The column was unused, so a
-- straight rename is safe.
ALTER TABLE account_subscriptions
    RENAME COLUMN stripe_subscription_id TO paystack_subscription_code;

ALTER INDEX account_subscriptions_stripe_idx
    RENAME TO account_subscriptions_paystack_idx;

ALTER TABLE account_subscriptions
    ADD COLUMN paystack_authorization_code text NULL,
    ADD COLUMN grace_period_end timestamptz NULL,
    ADD COLUMN last_renewal_id uuid NULL REFERENCES subscription_renewals(id) ON DELETE SET NULL;

-- Status enum check — replace any existing constraint with the new set.
ALTER TABLE account_subscriptions DROP CONSTRAINT IF EXISTS account_subscriptions_status_check;
ALTER TABLE account_subscriptions
    ADD CONSTRAINT account_subscriptions_status_check
        CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired'));

-- ─────────────────────────────────────────────────────────────────────────────
-- payment_intents: extend `purpose` with subscription, refund.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_purpose_check;
ALTER TABLE payment_intents
    ADD CONSTRAINT payment_intents_purpose_check
        CHECK (purpose IN ('wallet_topup', 'subscription', 'refund'));

-- ─────────────────────────────────────────────────────────────────────────────
-- referral abuse safeguards: lifetime stats per referee, used by anti-abuse rules.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE referral_attributions
    -- True once the referee has had at least one paid (non-refunded, post-trial)
    -- charge. Until then, the referrer earns nothing — kills cancel-and-rejoin abuse.
    ADD COLUMN qualified_at timestamptz NULL,
    -- Set when the referral has been clawed back (refund within window, fraud, etc.)
    ADD COLUMN reversed_at timestamptz NULL,
    ADD COLUMN reversal_reason text NULL;

CREATE INDEX referral_attributions_qualified_idx
    ON referral_attributions (qualified_at)
    WHERE qualified_at IS NOT NULL AND reversed_at IS NULL;
