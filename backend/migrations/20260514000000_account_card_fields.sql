-- Add saved payment method fields to accounts so subscription renewals
-- can charge a stored card when wallet balance is insufficient.
-- card_last4 / card_brand are display-only; the auth code is what Paystack needs.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS paystack_authorization_code text NULL,
  ADD COLUMN IF NOT EXISTS card_last4 text NULL,
  ADD COLUMN IF NOT EXISTS card_brand text NULL;
