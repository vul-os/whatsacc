-- 20260513000000_invoice_external_ref.sql
-- Idempotency anchor for invoices that don't have a payment_intent row.
-- Subscription renewals paid from the wallet have no Paystack transaction
-- so payment_intent_id can't carry their idempotency key. external_ref lets
-- the issuance helper use any stable string (e.g. 'subscription_renewal:<id>').

ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS external_ref text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_external_ref_idx
    ON invoices (external_ref)
    WHERE external_ref IS NOT NULL;
