// Shared helpers for the chat-flow suites (WhatsApp / Slack / Telegram):
// env plumbing, webhook signing, payload builders, and small DB fixtures
// that the flow tests need beyond tests/helpers/fixtures.ts.

import { withRLS, type TxSql } from '@/lib/db.ts';
import { resetEnvCache } from '@/lib/env.ts';
import type { AppHandle, TestResponse } from './app.ts';

// ---------------------------------------------------------------------------
// Env plumbing
// ---------------------------------------------------------------------------

/**
 * Set (or delete, via undefined) process.env vars for one test and reset the
 * env cache. Returns a restore function — always call it from finally.
 */
export function setEnvVars(vars: Record<string, string | undefined>): () => void {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
  return () => {
    for (const [k, p] of Object.entries(prior)) {
      if (p === undefined) delete process.env[k];
      else process.env[k] = p;
    }
    resetEnvCache();
  };
}

// ---------------------------------------------------------------------------
// Admin-context DB access
// ---------------------------------------------------------------------------

export async function adminSql<T>(fn: (tx: TxSql) => Promise<T>): Promise<T> {
  return await withRLS({ user_id: '', account_id: null, is_platform_admin: true }, fn);
}

/** Link a verified phone number to a user (bypasses the OTP flow). */
export async function linkVerifiedPhone(userId: string, phoneE164: string): Promise<void> {
  await adminSql(async (tx) => {
    await tx`
      insert into profile_phone_numbers (profile_id, phone_e164, verified_at, is_primary)
      values (${userId}, ${phoneE164}, now(), true)
    `;
  });
}

/** Link a Slack user id to a user's profile (dashboard-linking shortcut). */
export async function linkSlackUser(userId: string, slackUserId: string): Promise<void> {
  await adminSql(async (tx) => {
    await tx`update profiles set slack_user_id = ${slackUserId} where id = ${userId}`;
  });
}

/** Add another active access point to an existing location. */
export async function seedExtraAccessPoint(locationId: string, name: string): Promise<string> {
  return await adminSql(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into access_points (location_id, name, kind, status)
      values (${locationId}, ${name}, 'gate', 'active')
      returning id
    `;
    return row!.id;
  });
}

// ---------------------------------------------------------------------------
// WhatsApp webhook signing + payloads
// ---------------------------------------------------------------------------

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
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

export async function signWhatsAppBody(secret: string, body: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, body)}`;
}

let waMsgSeq = 0;

/** Wrap a raw `value` object in Meta's entry/changes envelope. */
export function waValueEnvelope(value: Record<string, unknown>): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', ...value } }],
      },
    ],
  });
}

/** Wrap one inbound message object in Meta's entry/changes envelope. */
export function waEnvelope(
  message: Record<string, unknown>,
  opts: { phoneNumberId?: string } = {},
): string {
  return waValueEnvelope({
    ...(opts.phoneNumberId
      ? { metadata: { phone_number_id: opts.phoneNumberId } }
      : {}),
    messages: [message],
  });
}

export function waTextMessage(
  fromNoPlus: string,
  text: string,
  opts: { messageId?: string } = {},
): Record<string, unknown> {
  waMsgSeq += 1;
  return {
    id: opts.messageId ?? `wamid.test-${Date.now()}-${waMsgSeq}`,
    from: fromNoPlus,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'text',
    text: { body: text },
  };
}

export function waInteractiveMessage(
  fromNoPlus: string,
  kind: 'list_reply' | 'button_reply',
  replyId: string,
  title: string,
): Record<string, unknown> {
  waMsgSeq += 1;
  return {
    id: `wamid.test-${Date.now()}-${waMsgSeq}`,
    from: fromNoPlus,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'interactive',
    interactive: { type: kind, [kind]: { id: replyId, title } },
  };
}

/** POST a signed WhatsApp webhook body. */
export async function postSignedWhatsApp(
  app: AppHandle,
  secret: string,
  rawBody: string,
): Promise<TestResponse> {
  const sig = await signWhatsAppBody(secret, rawBody);
  return await app.request('POST', '/webhooks/whatsapp', {
    rawBody,
    contentType: 'application/json',
    headers: { 'X-Hub-Signature-256': sig },
  });
}

// ---------------------------------------------------------------------------
// Slack webhook signing
// ---------------------------------------------------------------------------

export async function signSlack(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const bytes = new Uint8Array(sig);
  let hex = 'v0=';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

/** POST a signed Slack request (events or interactions endpoint). */
export async function postSignedSlack(
  app: AppHandle,
  secret: string,
  path: '/webhooks/slack' | '/webhooks/slack/interactions',
  rawBody: string,
  contentType: string,
): Promise<TestResponse> {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await signSlack(secret, ts, rawBody);
  return await app.request('POST', path, {
    rawBody,
    contentType,
    headers: { 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': sig },
  });
}

// ---------------------------------------------------------------------------
// Chat-message DB readbacks
// ---------------------------------------------------------------------------

export type LoggedMessage = {
  direction: 'in' | 'out';
  kind: string;
  status: string;
  provider_message_id: string | null;
  body: unknown;
};

/** All whatsapp_messages rows for one phone, oldest first. */
export async function whatsappMessagesFor(phoneE164: string): Promise<LoggedMessage[]> {
  return await adminSql(
    async (tx) =>
      await tx<LoggedMessage[]>`
        select m.direction, m.kind, m.status, m.provider_message_id, m.body
        from whatsapp_messages m
        join whatsapp_chats c on c.id = m.chat_id
        where c.phone_e164 = ${phoneE164}
        order by m.ts asc, m.created_at asc
      `,
  );
}

/** All slack_messages rows for one channel, oldest first. */
export async function slackMessagesFor(channelId: string): Promise<LoggedMessage[]> {
  return await adminSql(
    async (tx) =>
      await tx<LoggedMessage[]>`
        select m.direction, m.kind, m.status, m.provider_message_id, m.body
        from slack_messages m
        join slack_chats c on c.id = m.chat_id
        where c.channel_id = ${channelId}
        order by m.ts asc, m.created_at asc
      `,
  );
}

/** All telegram_messages rows for one chat id, oldest first. */
export async function telegramMessagesFor(chatId: number): Promise<LoggedMessage[]> {
  return await adminSql(
    async (tx) =>
      await tx<LoggedMessage[]>`
        select m.direction, m.kind, m.status, m.provider_message_id, m.body
        from telegram_messages m
        join telegram_chats c on c.id = m.chat_id
        where c.chat_id = ${chatId}
        order by m.ts asc, m.created_at asc
      `,
  );
}

/** Access-log rows for one access point, oldest first. */
export async function accessLogsFor(
  apId: string,
): Promise<{ success: boolean; error: string | null; user_id: string | null; source: string; command: string }[]> {
  return await adminSql(
    async (tx) =>
      await tx<{ success: boolean; error: string | null; user_id: string | null; source: string; command: string }[]>`
        select success, error, user_id, source, command
        from access_logs
        where access_point_id = ${apId}
        order by ts asc
      `,
  );
}
