import { Hono } from 'hono';
import type { JSONValue } from '../lib/db.ts';
import type { AppEnv } from '../middleware/auth.ts';
import { withAnonDb } from '../middleware/rls.ts';
import { Forbidden, BadRequest } from '../lib/errors.ts';
import { getEnv } from '../lib/env.ts';
import { sendSlackText } from '../lib/slack.ts';

async function verifySlackSignature(secret: string, timestamp: string, body: string, signature: string): Promise<boolean> {
  const base = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
  const bytes = new Uint8Array(sig);
  let hex = 'v0=';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  
  if (hex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

type SlackEvent = {
  type: string;
  channel: string;
  user: string;
  text?: string;
  ts: string;
  bot_id?: string;
  [k: string]: unknown;
};

type SlackPayload = {
  token?: string;
  challenge?: string;
  type?: string;
  team_id?: string;
  event?: SlackEvent;
};

function slackRouter() {
  const app = new Hono<AppEnv>();

  app.post('/webhooks/slack', async (c) => {
    const rawBody = await c.req.text();
    const timestamp = c.req.header('X-Slack-Request-Timestamp');
    const signature = c.req.header('X-Slack-Signature');
    const secret = getEnv().SLACK_SIGNING_SECRET;

    if (secret && timestamp && signature) {
      const isValid = await verifySlackSignature(secret, timestamp, rawBody, signature);
      if (!isValid) throw Forbidden('bad_signature');
    }

    let payload: SlackPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw BadRequest('bad_json');
    }

    if (payload.type === 'url_verification') {
      return c.json({ challenge: payload.challenge });
    }

    if (payload.type === 'event_callback' && payload.event) {
      const event = payload.event;
      if (event.type === 'message' && !event.bot_id) {
        const teamId = payload.team_id ?? 'unknown';
        const channelId = event.channel;
        
        type PendingReply = { to: string; chatId: string; body: string };
        const replies: PendingReply[] = [];

        await withAnonDb(async (tx) => {
          const chatRows = await tx<{ id: string; profile_id: string | null }[]>`
            insert into slack_chats (channel_id, team_id, last_inbound_at)
            values (${channelId}, ${teamId}, now())
            on conflict (channel_id) do update set 
              last_inbound_at = excluded.last_inbound_at
            returning id, profile_id
          `;
          const chat = chatRows[0]!;

          const kind = event.text ? 'text' : 'system';
          await tx`
            insert into slack_messages
              (chat_id, direction, kind, body, provider_message_id, status, ts)
            values
              (${chat.id}, 'in', ${kind}, ${tx.json(event as unknown as JSONValue)},
               ${event.ts}, 'received', to_timestamp(${parseFloat(event.ts)}))
            on conflict do nothing
          `;

          if (event.text) {
            const text = event.text.trim().toLowerCase();
            const reply = text === 'open' ? 'success' : 'failed';
            replies.push({ to: channelId, chatId: chat.id, body: reply });
          }
        });

        for (const r of replies) {
          const sent = await sendSlackText(r.to, r.body);
          await withAnonDb(async (tx) => {
            await tx`
              insert into slack_messages
                (chat_id, direction, kind, body, provider_message_id, status, ts)
              values
                (${r.chatId}, 'out', 'text',
                 ${tx.json({ text: r.body } as unknown as JSONValue)},
                 ${sent.providerMessageId ?? null},
                 ${sent.ok ? 'sent' : `failed:${sent.error ?? 'unknown'}`},
                 now())
            `;
            await tx`
              update slack_chats
              set last_outbound_at = now()
              where id = ${r.chatId}
            `;
          });
        }
      }
    }

    return c.json({ ok: true });
  });

  return app;
}

export const slackRoutes = slackRouter();
