-- 20260512000000_invite_phone.sql
-- Invite/profile contact additions: invite phone, location-member backfill,
-- and optional Slack identity fields.

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

-- Keep per-location membership in step with account membership so users can
-- see the locations and access points attached to accounts they joined.
INSERT INTO location_members (location_id, user_id, role)
SELECT l.id, am.user_id, am.role
FROM locations l
JOIN account_members am ON am.account_id = l.account_id
WHERE am.status = 'active'
ON CONFLICT (location_id, user_id)
DO UPDATE SET role = excluded.role, updated_at = now();

-- Optional Slack identity fields for linking Slack bot users to profiles.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS slack_user_id text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS slack_handle text;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_slack_user_id_unique
    ON profiles (slack_user_id)
    WHERE slack_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS profiles_slack_handle_idx
    ON profiles (lower(slack_handle))
    WHERE slack_handle IS NOT NULL;

COMMENT ON COLUMN profiles.slack_user_id IS 'Slack user ID, e.g. U123ABC, used to link bot messages to a profile.';
COMMENT ON COLUMN profiles.slack_handle IS 'Optional Slack handle without @, used for display and support.';
