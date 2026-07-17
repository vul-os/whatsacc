-- 20260513000000_billing_additions.sql
-- 1. Idempotency anchor for invoices that don't have a payment_intent row.
--    Subscription renewals paid from the wallet have no Paystack transaction
--    so payment_intent_id can't carry their idempotency key. external_ref lets
--    the issuance helper use any stable string (e.g. 'subscription_renewal:<id>').
-- 2. Adds the 'basic' tier: R99.99/month ZA entry-point plan between free and starter.
--    Cross-region equivalents seeded for completeness; ZA is the primary target.

ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS external_ref text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_external_ref_idx
    ON invoices (external_ref)
    WHERE external_ref IS NOT NULL;

INSERT INTO plans (
    code, name, region_code, currency,
    monthly_message_quota, included_opens, included_residents,
    included_devices, included_locations,
    price_cents, payg_open_price_cents,
    web_portal, blurb
) VALUES
('basic', 'Basic', 'za',      'ZAR', 300, 300, 20, 2, 1,  9999, 150, true, 'One location, essentials included.'),
('basic', 'Basic', 'us-ca',   'USD', 300, 300, 20, 2, 1,   999,  10, true, 'One location, essentials included.'),
('basic', 'Basic', 'eu-west', 'EUR', 300, 300, 20, 2, 1,   899,   8, true, 'One location, essentials included.'),
('basic', 'Basic', 'latam',   'USD', 300, 300, 20, 2, 1,   499,   4, true, 'One location, essentials included.'),
('basic', 'Basic', 'in-sea',  'USD', 300, 300, 20, 2, 1,   399,   3, true, 'One location, essentials included.')
ON CONFLICT (code, region_code) DO NOTHING;
