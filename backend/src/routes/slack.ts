import { Hono } from 'hono';
import type { JSONValue } from '../lib/db.ts';
import type { AppEnv } from '../middleware/auth.ts';
import { withAnonDb } from '../middleware/rls.ts';
import { Forbidden, BadRequest } from '../lib/errors.ts';
import { getEnv } from '../lib/env.ts';
import { sendSlackText, sendSlackBlocks } from '../lib/slack.ts';
import { getAvailableAccessPoints } from '../lib/access-lookup.ts';
import { logAccess } from './access.ts';
import { noteChatMessage, chatDenialMessage } from '../lib/rate-limit.ts';

// Slack's standard replay window: reject requests whose timestamp is more
// than this many seconds away from now, so a captured (validly signed)
// request cannot be replayed later.
const SLACK_REPLAY_WINDOW_S = 300;

// Log the missing-secret refusal once per isolate, not per request.
let warnedMissingSlackSecret = false;

/**
 * Fail-closed Slack request authentication, shared by the events and
 * interactions endpoints.
 *
 * - SLACK_SIGNING_SECRET configured: the X-Slack-Request-Timestamp and
 *   X-Slack-Signature headers are REQUIRED. Missing header, stale timestamp
 *   (outside the 300s replay window), or bad HMAC → 403 bad_signature.
 *   Omitting the headers must never skip verification (that was the bypass:
 *   unauthenticated block_actions could reach gate actuation).
 * - SLACK_SIGNING_SECRET not configured: refuse to process entirely (403
 *   slack_not_configured, logged once). Deliberate choice: processing
 *   unauthenticated webhooks would let anyone actuate gates, so the Slack
 *   integration simply does not work until the operator sets the secret.
 */
async function requireSlackSignature(
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
): Promise<void> {
  const secret = getEnv().SLACK_SIGNING_SECRET;
  if (!secret) {
    if (!warnedMissingSlackSecret) {
      console.error(
        'SLACK_SIGNING_SECRET is not configured — refusing all Slack webhooks (fail closed).',
      );
      warnedMissingSlackSecret = true;
    }
    throw Forbidden('slack_not_configured');
  }
  if (!timestamp || !signature) throw Forbidden('bad_signature');
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SLACK_REPLAY_WINDOW_S) {
    throw Forbidden('bad_signature');
  }
  const isValid = await verifySlackSignature(secret, timestamp, rawBody, signature);
  if (!isValid) throw Forbidden('bad_signature');
}

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

function slackMenu(profileName?: string): string {
  const hello = profileName ? `Hi ${profileName}.` : 'Welcome to whatsacc.';
  return [
    hello,
    '',
    'I can help you open your linked gates.',
    'Send "open" to see available gates, or use the buttons below if provided.',
  ].join('\n');
}

function accessBlocks(profileName: string, gates: any[]) {
  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Hi *${profileName}*, which gate would you like to open?`,
      },
    },
  ];

  for (const g of gates) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${g.ap_name}*\n${g.loc_name}`,
      },
      accessory: {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Open',
          emoji: true,
        },
        value: g.ap_id,
        action_id: `open_gate:${g.ap_id}`,
      },
    });
  }

  return blocks;
}

function normalizeSlackText(text: string | undefined): string {
  return (text ?? '')
    .replace(/<@[A-Z0-9]+>/g, '')
    .trim()
    .toLowerCase();
}

function slackRouter() {
  const app = new Hono<AppEnv>();

  app.post('/webhooks/slack', async (c) => {
    const rawBody = await c.req.text();
    await requireSlackSignature(
      c.req.header('X-Slack-Request-Timestamp'),
      c.req.header('X-Slack-Signature'),
      rawBody,
    );

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
      if ((event.type === 'message' || event.type === 'app_mention') && !event.bot_id) {
        const teamId = payload.team_id ?? 'unknown';
        const channelId = event.channel;
        
        type PendingReply = 
          | { type: 'text'; to: string; chatId: string; body: string }
          | { type: 'blocks'; to: string; chatId: string; text: string; blocks: any[] };
        const replies: PendingReply[] = [];

        await withAnonDb(async (tx) => {
          const profileRows = await tx<{ id: string; display_name: string | null }[]>`
            select p.id, p.display_name
            from profiles p
            where p.slack_user_id = ${event.user}
            limit 1
          `;
          const profile = profileRows[0] ?? null;

          const chatRows = await tx<{ id: string; profile_id: string | null }[]>`
            insert into slack_chats (channel_id, team_id, profile_id, last_inbound_at)
            values (${channelId}, ${teamId}, ${profile?.id ?? null}, now())
            on conflict (channel_id) do update set 
              last_inbound_at = excluded.last_inbound_at,
              profile_id = coalesce(slack_chats.profile_id, ${profile?.id ?? null})
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

          // Webhook flood throttle: past RATE_CHAT_MSGS_PER_MIN messages per
          // Slack user per minute the bot goes quiet — no reply, but the
          // webhook still returns 200 so Slack doesn't retry-amplify.
          const throttle = await noteChatMessage(tx, `slack:${event.user}`);
          if (throttle.quiet) {
            console.warn('Slack chat throttle — staying quiet:', { user: event.user });
            return;
          }

          const text = normalizeSlackText(event.text);
          if (text) {
            if (['hi', 'hello', 'hey', 'help', 'menu', 'start'].includes(text)) {
              replies.push({ type: 'text', to: channelId, chatId: chat.id, body: slackMenu(profile?.display_name ?? undefined) });
            } else if (!profile) {
              replies.push({
                type: 'text',
                to: channelId,
                chatId: chat.id,
                body: [
                  "I don't know which whatsacc profile this Slack user belongs to yet.",
                  `Add Slack user ID ${event.user} in the web dashboard, then send "menu".`,
                ].join('\n'),
              });
            } else if (text === 'open' || text === 'gates') {
              const gates = await getAvailableAccessPoints(tx, { profileId: profile.id });
              if (gates.length === 0) {
                replies.push({
                  type: 'text',
                  to: channelId,
                  chatId: chat.id,
                  body: "You don't have any active gate access. Please contact the administrator.",
                });
              } else {
                replies.push({
                  type: 'blocks',
                  to: channelId,
                  chatId: chat.id,
                  text: 'Select a gate to open',
                  blocks: accessBlocks(profile.display_name ?? 'there', gates),
                });
              }
            } else {
              replies.push({ type: 'text', to: channelId, chatId: chat.id, body: slackMenu(profile?.display_name ?? undefined) });
            }
          }
        });

        for (const r of replies) {
          const sent = r.type === 'text' 
            ? await sendSlackText(r.to, r.body)
            : await sendSlackBlocks(r.to, r.text, r.blocks);

          await withAnonDb(async (tx) => {
            const kind = r.type === 'text' ? 'text' : 'interactive';
            const body = r.type === 'text' ? { text: r.body } : { blocks: r.blocks };

            await tx`
              insert into slack_messages
                (chat_id, direction, kind, body, provider_message_id, status, ts)
              values
                (${r.chatId}, 'out', ${kind},
                 ${tx.json(body as unknown as JSONValue)},
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

  app.post('/webhooks/slack/interactions', async (c) => {
    const rawBody = await c.req.text();
    // Authenticate BEFORE parsing anything attacker-controlled.
    await requireSlackSignature(
      c.req.header('X-Slack-Request-Timestamp'),
      c.req.header('X-Slack-Signature'),
      rawBody,
    );

    const params = new URLSearchParams(rawBody);
    const payloadStr = params.get('payload');
    if (!payloadStr) throw BadRequest('missing_payload');

    let payload: any;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      throw BadRequest('bad_json');
    }

    if (payload.type === 'block_actions') {
      const action = payload.actions?.[0];
      if (action?.action_id?.startsWith('open_gate:')) {
        const apId = action.value;
        const slackUserId = payload.user?.id;
        const channelId = payload.channel?.id;

        await withAnonDb(async (tx) => {
          const profileRows = await tx<{ id: string }[]>`
            select id from profiles where slack_user_id = ${slackUserId} limit 1
          `;
          const profile = profileRows[0];
          if (!profile) return;

          const gates = await getAvailableAccessPoints(tx, { profileId: profile.id });
          const hasAccess = gates.some(g => g.ap_id === apId);

          if (hasAccess) {
            const verdict = await logAccess(tx, {
              user_id: profile.id,
              access_point_id: apId,
              command: 'open',
              source: 'slack',
            });
            if (!verdict.allowed) {
              // Denied by rate limit / quota — audit-logged by logAccess;
              // reply honestly instead of pretending the gate opened.
              await sendSlackText(channelId, chatDenialMessage(verdict));
              return;
            }
            await sendSlackText(channelId, `✅ Opening gate...`);
          } else {
            await sendSlackText(channelId, `❌ Sorry, you no longer have access to this gate.`);
          }
        });
      }
    } else if (payload.type === 'shortcut' && payload.callback_id === 'open_gates_shortcut') {
      const slackUserId = payload.user?.id;
      // Shortcuts don't always have a channelId (can be global), but we can 
      // use the user's DM channel or just rely on the fact that we can't 
      // easily 'reply' without a channel. Slack usually provides a 
      // channel_id for shortcuts if triggered in a channel context.
      // If no channel, we can't send blocks back easily via chat.postMessage
      // without opening a DM.
      const channelId = payload.channel?.id;
      if (!channelId) return c.json({ ok: true }); // Or handle DM opening

      await withAnonDb(async (tx) => {
        const profileRows = await tx<{ id: string; display_name: string | null }[]>`
          select id, display_name from profiles where slack_user_id = ${slackUserId} limit 1
        `;
        const profile = profileRows[0];
        if (!profile) {
          await sendSlackText(channelId, "I don't know who you are yet. Link your Slack ID in the dashboard.");
          return;
        }

        const gates = await getAvailableAccessPoints(tx, { profileId: profile.id });
        if (gates.length === 0) {
          await sendSlackText(channelId, "You don't have any active gate access.");
        } else {
          const blocks = accessBlocks(profile.display_name ?? 'there', gates);
          await sendSlackBlocks(channelId, 'Select a gate to open', blocks);
        }
      });
    }

    return c.json({ ok: true });
  });

  return app;
}

export const slackRoutes = slackRouter();
