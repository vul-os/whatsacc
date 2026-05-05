import { Hono } from 'hono';
import type postgres from 'postgres';
import type { AppEnv } from '../middleware/auth.ts';
import { withAnonDb } from '../middleware/rls.ts';
import { Forbidden, BadRequest } from '../lib/errors.ts';
import { getEnv } from '../lib/env.ts';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const bytes = new Uint8Array(sig);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

type WhatsAppValue = {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
  messages?: Array<{
    id: string;
    from: string;
    timestamp: string;
    type: string;
    text?: { body: string };
    [k: string]: unknown;
  }>;
  statuses?: Array<{ id: string; status: string; timestamp: string }>;
};

type WhatsAppPayload = {
  object?: string;
  entry?: Array<{
    id: string;
    changes: Array<{ field: string; value: WhatsAppValue }>;
  }>;
};

function whatsappRouter() {
  const app = new Hono<AppEnv>();

  // Meta webhook verification handshake
  app.get('/webhooks/whatsapp', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    const expected = getEnv().WHATSAPP_APP_SECRET;
    if (mode === 'subscribe' && token && expected && token === expected) {
      return c.text(challenge ?? '');
    }
    throw Forbidden('verify_token_mismatch');
  });

  app.post('/webhooks/whatsapp', async (c) => {
    const raw = await c.req.text();
    const sigHeader = c.req.header('X-Hub-Signature-256');
    const secret = getEnv().WHATSAPP_APP_SECRET;
    if (!secret) throw Forbidden('webhook_secret_unset');
    if (!sigHeader || !sigHeader.startsWith('sha256=')) throw Forbidden('missing_signature');
    const expected = `sha256=${await hmacSha256Hex(secret, raw)}`;
    if (!timingSafeEqual(expected, sigHeader)) throw Forbidden('bad_signature');

    let payload: WhatsAppPayload;
    try {
      payload = JSON.parse(raw) as WhatsAppPayload;
    } catch {
      throw BadRequest('bad_json');
    }

    await withAnonDb(async (tx) => {
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value;
          for (const msg of value.messages ?? []) {
            const from = `+${msg.from}`;
            const chatRows = await tx<{ id: string; profile_id: string | null }[]>`
              insert into whatsapp_chats (phone_e164, last_inbound_at)
              values (${from}, now())
              on conflict (phone_e164) do update set last_inbound_at = excluded.last_inbound_at
              returning id, profile_id
            `;
            const chat = chatRows[0]!;
            await tx`
              insert into whatsapp_messages
                (chat_id, direction, kind, body, provider_message_id, status, ts)
              values
                (${chat.id}, 'in', ${msg.type}, ${tx.json(msg as unknown as postgres.JSONValue)},
                 ${msg.id}, 'received', to_timestamp(${Number(msg.timestamp)}))
              on conflict do nothing
            `;
          }
          // TODO: handle status updates (delivered/read) by upserting whatsapp_messages.status
          // TODO: dispatch intent/conversation engine for inbound messages
        }
      }
    });

    return c.json({ ok: true });
  });

  return app;
}

export const whatsappRoutes = whatsappRouter();
