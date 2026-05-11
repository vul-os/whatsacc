-- 20260511000000_telegram_slack.sql
-- Telegram and Slack chat threads and messages.

CREATE TABLE telegram_chats (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id bigint UNIQUE NOT NULL, -- Telegram chat ID
    profile_id uuid NULL REFERENCES profiles(id) ON DELETE SET NULL,
    username text,
    first_name text,
    last_name text,
    last_inbound_at timestamptz,
    last_outbound_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE telegram_chats IS 'Telegram conversation thread, one per chat/user.';
CREATE INDEX telegram_chats_profile_id_idx ON telegram_chats (profile_id);

CREATE TABLE telegram_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id uuid NOT NULL REFERENCES telegram_chats(id) ON DELETE CASCADE,
    direction text NOT NULL CHECK (direction IN ('in','out')),
    kind text NOT NULL CHECK (kind IN ('text','location','photo','document','system')),
    body jsonb NOT NULL,
    provider_message_id text,
    status text,
    ts timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE telegram_messages IS 'Individual Telegram messages exchanged on a chat.';
CREATE INDEX telegram_messages_chat_id_ts_idx ON telegram_messages (chat_id, ts DESC);
CREATE INDEX telegram_messages_provider_message_id_idx
    ON telegram_messages (provider_message_id)
    WHERE provider_message_id IS NOT NULL;

CREATE TABLE slack_chats (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id text UNIQUE NOT NULL, -- Slack channel ID (C...) or DM (D...)
    team_id text NOT NULL,
    profile_id uuid NULL REFERENCES profiles(id) ON DELETE SET NULL,
    last_inbound_at timestamptz,
    last_outbound_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE slack_chats IS 'Slack conversation thread, one per channel/DM.';
CREATE INDEX slack_chats_profile_id_idx ON slack_chats (profile_id);

CREATE TABLE slack_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id uuid NOT NULL REFERENCES slack_chats(id) ON DELETE CASCADE,
    direction text NOT NULL CHECK (direction IN ('in','out')),
    kind text NOT NULL CHECK (kind IN ('text','file','system')),
    body jsonb NOT NULL,
    provider_message_id text,
    status text,
    ts timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE slack_messages IS 'Individual Slack messages exchanged on a chat.';
CREATE INDEX slack_messages_chat_id_ts_idx ON slack_messages (chat_id, ts DESC);
CREATE INDEX slack_messages_provider_message_id_idx
    ON slack_messages (provider_message_id)
    WHERE provider_message_id IS NOT NULL;

-- =========================================================================
-- RLS Policies
-- =========================================================================

-- Telegram
ALTER TABLE telegram_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY telegram_chats_owner ON telegram_chats
    FOR ALL
    USING (
        profile_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    )
    WITH CHECK (
        profile_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );

ALTER TABLE telegram_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY telegram_messages_owner ON telegram_messages
    FOR ALL
    USING (
        app.is_platform_admin()
        OR app.current_user_id() IS NULL
        OR EXISTS (
            SELECT 1 FROM telegram_chats c
            WHERE c.id = telegram_messages.chat_id
              AND c.profile_id = app.current_user_id()
        )
    )
    WITH CHECK (
        app.is_platform_admin()
        OR app.current_user_id() IS NULL
        OR EXISTS (
            SELECT 1 FROM telegram_chats c
            WHERE c.id = telegram_messages.chat_id
              AND c.profile_id = app.current_user_id()
        )
    );

-- Slack
ALTER TABLE slack_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY slack_chats_owner ON slack_chats
    FOR ALL
    USING (
        profile_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    )
    WITH CHECK (
        profile_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );

ALTER TABLE slack_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY slack_messages_owner ON slack_messages
    FOR ALL
    USING (
        app.is_platform_admin()
        OR app.current_user_id() IS NULL
        OR EXISTS (
            SELECT 1 FROM slack_chats c
            WHERE c.id = slack_messages.chat_id
              AND c.profile_id = app.current_user_id()
        )
    )
    WITH CHECK (
        app.is_platform_admin()
        OR app.current_user_id() IS NULL
        OR EXISTS (
            SELECT 1 FROM slack_chats c
            WHERE c.id = slack_messages.chat_id
              AND c.profile_id = app.current_user_id()
        )
    );
