-- 20260512000000_invite_phone.sql
-- Add optional phone number to invites for WhatsApp notifications.

ALTER TABLE account_invites ADD COLUMN IF NOT EXISTS phone_e164 text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'account_invites_phone_e164_check'
          AND conrelid = 'account_invites'::regclass
    ) THEN
        ALTER TABLE account_invites
            ADD CONSTRAINT account_invites_phone_e164_check
            CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$');
    END IF;
END;
$$;

COMMENT ON COLUMN account_invites.phone_e164 IS 'Optional phone number to notify via WhatsApp when the invite is sent.';
