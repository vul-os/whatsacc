-- 20260512010000_whatsapp_message_unique.sql
-- Add unique constraint to whatsapp_messages(provider_message_id) to prevent duplicate processing on retries.

-- First, clean up any existing duplicates if they exist (keep the oldest one)
DELETE FROM whatsapp_messages a
USING whatsapp_messages b
WHERE a.provider_message_id = b.provider_message_id
  AND a.id > b.id;

-- Add the unique constraint
ALTER TABLE whatsapp_messages
ADD CONSTRAINT whatsapp_messages_provider_message_id_unique UNIQUE (provider_message_id);
