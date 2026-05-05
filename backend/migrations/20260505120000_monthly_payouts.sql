-- 20260505120000_monthly_payouts.sql
-- Convert payout_requests to a fully automatic monthly system. Adds a period
-- key (YYYY-MM) so the cron can dedupe per user per month, plus a Paystack
-- transfer recipient cache on kyc_profiles and the transfer-id / failure-
-- reason columns on the request itself.

ALTER TABLE kyc_profiles
    ADD COLUMN paystack_recipient_code text NULL,
    ADD COLUMN paystack_recipient_synced_at timestamptz NULL;

ALTER TABLE payout_requests
    ADD COLUMN payout_period text NULL,
    ADD COLUMN paystack_transfer_id text NULL,
    ADD COLUMN failure_reason text NULL,
    ADD COLUMN auto_generated boolean NOT NULL DEFAULT false;

-- Period key shape: 'YYYY-MM' (UTC). Validated when present.
ALTER TABLE payout_requests
    ADD CONSTRAINT payout_requests_period_format
    CHECK (payout_period IS NULL OR payout_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- One live payout per user per period. Failed/cancelled rows do not block
-- a future retry for the same period.
CREATE UNIQUE INDEX payout_requests_user_period_live_idx
    ON payout_requests (user_id, payout_period)
    WHERE payout_period IS NOT NULL
      AND status IN ('pending', 'approved', 'paid');

CREATE INDEX payout_requests_period_idx ON payout_requests (payout_period);
CREATE UNIQUE INDEX payout_requests_paystack_transfer_id_idx
    ON payout_requests (paystack_transfer_id)
    WHERE paystack_transfer_id IS NOT NULL;
