-- 20260505050000_whatsapp.sql
-- WhatsApp (Meta Cloud API) chat threads and messages.

CREATE TABLE whatsapp_chats (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164 text UNIQUE NOT NULL,
    profile_id uuid NULL REFERENCES profiles(id) ON DELETE SET NULL,
    last_inbound_at timestamptz,
    last_outbound_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE whatsapp_chats IS 'WhatsApp conversation thread, one per phone number.';
CREATE INDEX whatsapp_chats_profile_id_idx ON whatsapp_chats (profile_id);

CREATE TABLE whatsapp_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
    direction text NOT NULL CHECK (direction IN ('in','out')),
    kind text NOT NULL CHECK (kind IN ('text','location','media','interactive','system')),
    body jsonb NOT NULL,
    provider_message_id text,
    status text,
    ts timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE whatsapp_messages IS 'Individual WhatsApp messages exchanged on a chat.';
CREATE INDEX whatsapp_messages_chat_id_ts_idx ON whatsapp_messages (chat_id, ts DESC);
CREATE INDEX whatsapp_messages_provider_message_id_idx
    ON whatsapp_messages (provider_message_id)
    WHERE provider_message_id IS NOT NULL;
