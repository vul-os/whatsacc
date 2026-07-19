-- 0005_channels.sql
-- Stage 5: the chat-channel seam. Channel identities (resolve a
-- (channel, external id) → member profile) plus the chat + message log the
-- WhatsApp / Slack / Telegram webhooks write, translated from the Postgres
-- backend's whatsapp_/slack_/telegram_ chats + messages tables onto ONE pair
-- of channel-agnostic tables (the gateway seam is channel-agnostic; only the
-- external_key convention differs per channel).
--
-- Identity is keyed on (channel, external_id) — not phone-only — so one person
-- reachable on WhatsApp AND Slack is one member, not two records. WhatsApp's
-- identity is the VERIFIED phone (profile_phone_numbers, migration 0002); the
-- other channels map their user id here.

CREATE TABLE channel_identities (
    channel     TEXT NOT NULL,           -- 'slack' | 'telegram' | ...
    external_id TEXT NOT NULL,           -- slack_user_id | telegram user id
    profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (channel, external_id)
);
CREATE INDEX channel_identities_profile_idx ON channel_identities (profile_id);

-- One chat thread per (channel, external_key). external_key is the channel's
-- addressable target: WhatsApp = phone_e164, Slack = channel_id, Telegram =
-- chat_id. profile_id is best-effort (Slack/Telegram resolve it up front;
-- WhatsApp resolves access by phone at reply time and leaves it null).
CREATE TABLE channel_chats (
    id               TEXT PRIMARY KEY,
    channel          TEXT NOT NULL,
    external_key     TEXT NOT NULL,
    profile_id       TEXT REFERENCES profiles(id) ON DELETE SET NULL,
    phone_e164       TEXT,
    meta             TEXT NOT NULL DEFAULT '{}', -- json (username, names, team id)
    last_inbound_at  INTEGER,
    last_outbound_at INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE (channel, external_key)
);

CREATE TABLE channel_messages (
    id                  TEXT PRIMARY KEY,
    chat_id             TEXT NOT NULL REFERENCES channel_chats(id) ON DELETE CASCADE,
    channel             TEXT NOT NULL,
    direction           TEXT NOT NULL CHECK (direction IN ('in','out')),
    kind                TEXT NOT NULL,
    body                TEXT NOT NULL DEFAULT '{}', -- json
    provider_message_id TEXT,
    status              TEXT NOT NULL,              -- received | sent | failed:<err>
    ts                  INTEGER NOT NULL,
    created_at          INTEGER NOT NULL
);
CREATE INDEX channel_messages_chat_idx ON channel_messages (chat_id, ts DESC);

-- Inbound dedupe: a redelivered webhook (same provider message id, same
-- channel) is silently ignored so the bot never double-replies or double-opens.
-- Partial + per channel so two providers can't collide on a shared id space.
CREATE UNIQUE INDEX channel_messages_inbound_unique
    ON channel_messages (channel, provider_message_id)
    WHERE direction = 'in' AND provider_message_id IS NOT NULL;
