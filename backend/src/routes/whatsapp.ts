import { Hono } from 'hono';
import type { JSONValue } from '../lib/db.ts';
import type { AppEnv } from '../middleware/auth.ts';
import { withAnonDb } from '../middleware/rls.ts';
import { Forbidden, BadRequest } from '../lib/errors.ts';
import { getEnv } from '../lib/env.ts';
import {
  sendWhatsAppText,
  sendWhatsAppInteractive,
  type WhatsAppInteractive,
} from '../lib/whatsapp.ts';
import { tryConsumeGrant, logAccess } from './access.ts';
import { getAvailableAccessPoints } from '../lib/access-lookup.ts';

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
    interactive?: {
      type: 'list_reply' | 'button_reply';
      list_reply?: { id: string; title: string; description?: string };
      button_reply?: { id: string; title: string };
    };
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

  // Meta webhook verification handshake. Verify token is sent in plaintext
  // by Meta on the GET handshake — keep it distinct from the App Secret used
  // to HMAC-sign POST payloads.
  app.get('/webhooks/whatsapp', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    const expected = getEnv().WHATSAPP_VERIFY_TOKEN;
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

    type PendingReply =
      | { type: 'text'; to: string; chatId: string; body: string }
      | { type: 'interactive'; to: string; chatId: string; interactive: WhatsAppInteractive };
    const replies: PendingReply[] = [];

    // Meta delivers webhooks for every phone number on the WABA, not just
    // ours. Drop changes targeted at any other phone_number_id so we don't
    // process / reply to messages meant for a sibling project's bot.
    const ourPhoneId = getEnv().WHATSAPP_PHONE_NUMBER_ID;

    await withAnonDb(async (tx) => {
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value;
          const incomingPhoneId = value.metadata?.phone_number_id;
          if (ourPhoneId && incomingPhoneId && incomingPhoneId !== ourPhoneId) continue;
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
                (${chat.id}, 'in', ${msg.type}, ${tx.json(msg as unknown as JSONValue)},
                 ${msg.id}, 'received', to_timestamp(${Number(msg.timestamp)}))
              on conflict do nothing
            `;

            if (msg.type === 'text') {
              const allGrants = await getAvailableAccessPoints(tx, { phoneE164: from });

              if (allGrants.length === 0) {
                replies.push({
                  type: 'text',
                  to: msg.from,
                  chatId: chat.id,
                  body: "Hello! You don't have any active gate access linked to this number. Please contact the administrator if you believe this is an error.",
                });
              } else if (allGrants.length === 1) {
                const g = allGrants[0]!;
                const footer = g.type === 'visitor' 
                  ? { text: `You have ${g.max_uses === null ? 'unlimited' : (g.max_uses ?? 0) - (g.uses_count ?? 0)} uses remaining.` }
                  : undefined;

                replies.push({
                  type: 'interactive',
                  to: msg.from,
                  chatId: chat.id,
                  interactive: {
                    type: 'button',
                    body: { text: `Welcome! Would you like to open the ${g.ap_name}?` },
                    footer,
                    action: {
                      buttons: [
                        {
                          type: 'reply',
                          reply: { id: g.ap_id, title: `Open ${g.ap_name}` },
                        },
                      ],
                    },
                  },
                });
              } else {
                // Multiple gates: use a List Message.
                replies.push({
                  type: 'interactive',
                  to: msg.from,
                  chatId: chat.id,
                  interactive: {
                    type: 'list',
                    header: { type: 'text', text: 'Gate Access' },
                    body: { text: 'Welcome! Please select the gate you would like to open.' },
                    action: {
                      button: 'Select Gate',
                      sections: [
                        {
                          title: 'Available Gates',
                          rows: allGrants.slice(0, 10).map((g) => ({
                            id: g.ap_id,
                            title: g.ap_name,
                            description: g.loc_name,
                          })),
                        },
                      ],
                    },
                  },
                });
              }
            } else if (msg.type === 'interactive') {
              const reply = msg.interactive?.list_reply || msg.interactive?.button_reply;
              if (reply) {
                const apId = reply.id;
                
                // Try consuming as visitor first
                let grantId = await tryConsumeGrant(from, apId);
                let isMember = false;

                if (!grantId) {
                  // If not visitor, check if they are a member
                  const memberCheck = await tx`
                    select am.user_id
                    from profile_phone_numbers ppn
                    join account_members am on am.user_id = ppn.profile_id
                    join locations l on l.account_id = am.account_id
                    join access_points ap on ap.location_id = l.id
                    where ppn.phone_e164 = ${from}
                      and ppn.verified_at is not null
                      and ap.id = ${apId}::uuid
                      and am.status = 'active'
                    limit 1
                  `;
                  if (memberCheck.length > 0) {
                    isMember = true;
                  }
                }

                if (grantId || isMember) {
                  await logAccess(tx, {
                    user_id: null, // TODO: resolve user_id for members?
                    access_point_id: apId,
                    command: 'open',
                    source: 'whatsapp',
                  });
                  replies.push({
                    type: 'text',
                    to: msg.from,
                    chatId: chat.id,
                    body: `✅ Opening ${reply.title}...`,
                  });
                } else {
                  replies.push({
                    type: 'text',
                    to: msg.from,
                    chatId: chat.id,
                    body: `❌ Sorry, you no longer have access to this gate.`,
                  });
                }
              }
            }
          }
        }
      }
    });

    // Send replies outside the DB tx so a slow Meta API call doesn't hold a
    // connection. Persist outbound rows after each send completes.
    for (const r of replies) {
      const sent =
        r.type === 'text'
          ? await sendWhatsAppText(r.to, r.body)
          : await sendWhatsAppInteractive(r.to, r.interactive);

      await withAnonDb(async (tx) => {
        const kind = r.type === 'text' ? 'text' : 'interactive';
        const body = r.type === 'text' ? { text: { body: r.body } } : r.interactive;

        await tx`
          insert into whatsapp_messages
            (chat_id, direction, kind, body, provider_message_id, status, ts)
          values
            (${r.chatId}, 'out', ${kind},
             ${tx.json(body as unknown as JSONValue)},
             ${sent.providerMessageId ?? null},
             ${sent.ok ? 'sent' : `failed:${sent.error ?? 'unknown'}`},
             now())
        `;
        await tx`
          update whatsapp_chats
          set last_outbound_at = now()
          where id = ${r.chatId}
        `;
      });
    }

    return c.json({ ok: true });
  });

  return app;
}

export const whatsappRoutes = whatsappRouter();
