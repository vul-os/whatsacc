-- 20260505170000_payout_requests_updated_at.sql
-- The cron + webhook update payout_requests.updated_at, but the column was
-- never added. Add it now.

ALTER TABLE payout_requests
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
