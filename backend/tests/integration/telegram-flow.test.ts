// Integration tests for the Telegram webhook (src/routes/telegram.ts).
//
// HONEST DOCUMENTATION OF A STUB: the Telegram integration is NOT a
// conversational gate bot yet. What it actually does — and what these tests
// pin so the docs stay true:
//
//   - X-Telegram-Bot-Api-Secret-Token is verified WHEN a secret is
//     configured (403 bad_secret_token otherwise);
//   - the chat is upserted into telegram_chats (username/name refreshed);
//   - inbound and outbound messages are logged in telegram_messages;
//   - the per-chat flood throttle applies (bot goes quiet, still 200s);
//   - the reply is the LITERAL STUB: 'success' for the text "open",
//     'failed' for anything else — no linking, no access lookup, and it
//     NEVER opens a gate (no access_logs are written, ever).

import { assert, assertEquals } from '../helpers/assert.ts';
import { bootTestApp, type AppHandle } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { dbTest } from '../helpers/test.ts';
import { interceptOutbound } from '../helpers/outbound.ts';
import { adminSql, setEnvVars, telegramMessagesFor } from '../helpers/chat.ts';

const TG_SECRET = 'test-telegram-secret';
const TG_TOKEN = '12345:test-telegram-token';

function setTelegramEnv(): () => void {
  return setEnvVars({
    TELEGRAM_WEBHOOK_SECRET: TG_SECRET,
    TELEGRAM_BOT_TOKEN: TG_TOKEN,
  });
}

let tgSeq = 0;

function tgUpdate(
  chatId: number,
  text: string,
  opts: { isBot?: boolean; messageId?: number; username?: string } = {},
): unknown {
  tgSeq += 1;
  return {
    update_id: 900000 + tgSeq,
    message: {
      message_id: opts.messageId ?? 1000 + tgSeq,
      from: {
        id: chatId,
        is_bot: opts.isBot ?? false,
        first_name: 'Thabo',
        last_name: 'Test',
        username: opts.username ?? 'thabo_test',
      },
      chat: {
        id: chatId,
        type: 'private',
        username: opts.username ?? 'thabo_test',
        first_name: 'Thabo',
        last_name: 'Test',
      },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

async function postUpdate(app: AppHandle, update: unknown, secretHeader?: string) {
  return await app.request('POST', '/webhooks/telegram', {
    rawBody: JSON.stringify(update),
    contentType: 'application/json',
    headers: secretHeader === undefined ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secretHeader },
  });
}

async function accessLogCount(): Promise<number> {
  const rows = await adminSql(
    async (tx) => await tx<{ count: string }[]>`select count(*)::text as count from access_logs`,
  );
  return Number(rows[0]!.count);
}

// ---------------------------------------------------------------------------

dbTest('tg flow: secret token is verified when configured — wrong or missing header is 403', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setTelegramEnv();
  const outbound = interceptOutbound();
  try {
    const wrong = await postUpdate(app, tgUpdate(101, 'open'), 'not-the-secret');
    assertEquals(wrong.status, 403);
    assertEquals((wrong.body as { error: string }).error, 'bad_secret_token');

    const missing = await postUpdate(app, tgUpdate(101, 'open'));
    assertEquals(missing.status, 403);

    // Nothing was processed for the rejected requests.
    assertEquals((await telegramMessagesFor(101)).length, 0);
    assertEquals(outbound.calls.length, 0);

    const ok = await postUpdate(app, tgUpdate(101, 'open'), TG_SECRET);
    assertEquals(ok.status, 200);
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('tg flow: without a configured secret the webhook processes unauthenticated requests', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setEnvVars({ TELEGRAM_WEBHOOK_SECRET: undefined, TELEGRAM_BOT_TOKEN: TG_TOKEN });
  const outbound = interceptOutbound();
  try {
    // TODO(REAL FINDING — documented, not fixed; tests must not touch src/):
    // src/routes/telegram.ts only checks the secret token `if (secret)` is
    // configured — with TELEGRAM_WEBHOOK_SECRET unset, ANY unauthenticated
    // POST is processed (chat rows created, replies sent through the bot
    // token). Contrast src/routes/slack.ts, which fails CLOSED with 403
    // slack_not_configured when its secret is missing. Today the blast
    // radius is spam/DB-writes only because the handler is a stub that never
    // opens gates (asserted below) — but the fail-open becomes a real gate
    // bypass the day the stub grows access logic. Pinned so the gap stays
    // visible.
    const r = await postUpdate(app, tgUpdate(202, 'open'));
    assertEquals(r.status, 200);
    const rows = await telegramMessagesFor(202);
    assertEquals(rows.filter((m) => m.direction === 'in').length, 1);
    assertEquals(rows.filter((m) => m.direction === 'out').length, 1);
    assertEquals(await accessLogCount(), 0, 'stub must never actuate a gate');
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('tg flow: the stub contract — "open" replies literal success, anything else failed; no gate ever opens', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setTelegramEnv();
  const outbound = interceptOutbound();
  try {
    const chatId = 303;
    assertEquals((await postUpdate(app, tgUpdate(chatId, 'open'), TG_SECRET)).status, 200);
    assertEquals((await postUpdate(app, tgUpdate(chatId, 'hello there'), TG_SECRET)).status, 200);

    // The chat was upserted with the Telegram identity fields.
    const chat = await adminSql(
      async (tx) => await tx<{ username: string | null; first_name: string | null; profile_id: string | null }[]>`
        select username, first_name, profile_id from telegram_chats where chat_id = ${chatId}
      `,
    );
    assertEquals(chat.length, 1);
    assertEquals(chat[0]!.username, 'thabo_test');
    assertEquals(chat[0]!.first_name, 'Thabo');
    assertEquals(chat[0]!.profile_id, null, 'no account linking exists for Telegram');

    // In/out messages are logged; replies are the literal stub strings.
    const rows = await telegramMessagesFor(chatId);
    const inbound = rows.filter((m) => m.direction === 'in');
    const outboundRows = rows.filter((m) => m.direction === 'out');
    assertEquals(inbound.length, 2);
    assertEquals(outboundRows.length, 2);
    assertEquals((outboundRows[0]!.body as { text: string }).text, 'success');
    assertEquals((outboundRows[1]!.body as { text: string }).text, 'failed');
    for (const row of outboundRows) {
      assertEquals(row.status, 'sent');
      assert(row.provider_message_id !== null, 'mocked provider id must be recorded');
    }

    // The replies went to the Telegram Bot API with the bot token in the URL.
    const calls = outbound.to('api.telegram.org');
    assertEquals(calls.length, 2);
    assert(calls[0]!.url.includes(`/bot${TG_TOKEN}/sendMessage`), calls[0]!.url);
    const sent = calls[0]!.body as { chat_id: number; text: string; parse_mode: string };
    assertEquals(sent.chat_id, chatId);
    assertEquals(sent.text, 'success');
    assertEquals(sent.parse_mode, 'HTML');

    // "open" did NOT open anything — there is no gate wiring at all.
    assertEquals(await accessLogCount(), 0, 'telegram stub must never write access_logs');
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('tg flow: flood throttle silences the stub past the per-minute cap but still 200s', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setTelegramEnv();
  const restoreRate = setEnvVars({ RATE_CHAT_MSGS_PER_MIN: '2' });
  const outbound = interceptOutbound();
  try {
    const chatId = 404;
    for (let i = 0; i < 4; i++) {
      const r = await postUpdate(app, tgUpdate(chatId, 'open'), TG_SECRET);
      assertEquals(r.status, 200, 'webhook must 200 even when throttled (no retry amplification)');
    }
    const rows = await telegramMessagesFor(chatId);
    assertEquals(rows.filter((m) => m.direction === 'in').length, 4, 'all inbound logged');
    assertEquals(rows.filter((m) => m.direction === 'out').length, 2, 'only the first 2 got replies');
    assertEquals(outbound.to('api.telegram.org').length, 2);
  } finally {
    outbound.restore();
    restoreRate();
    restore();
  }
});

dbTest('tg flow: bot senders and message-less updates are ignored', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setTelegramEnv();
  const outbound = interceptOutbound();
  try {
    const fromBot = await postUpdate(app, tgUpdate(505, 'open', { isBot: true }), TG_SECRET);
    assertEquals(fromBot.status, 200);
    assertEquals((await telegramMessagesFor(505)).length, 0, 'bot traffic must not be logged or answered');

    const noMessage = await postUpdate(app, { update_id: 999999 }, TG_SECRET);
    assertEquals(noMessage.status, 200);
    assertEquals(outbound.calls.length, 0);
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('tg flow: redelivered updates are NOT deduplicated (documented current behavior)', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setTelegramEnv();
  const outbound = interceptOutbound();
  try {
    // Pinned current behavior: the inbound INSERT carries ON CONFLICT DO
    // NOTHING, but telegram_messages has NO unique constraint on
    // provider_message_id (plain index only — compare whatsapp_messages'
    // UNIQUE constraint), so the clause never fires: a redelivered update is
    // processed twice and replied to twice.
    const chatId = 606;
    const update = tgUpdate(chatId, 'open', { messageId: 7777 });
    assertEquals((await postUpdate(app, update, TG_SECRET)).status, 200);
    assertEquals((await postUpdate(app, update, TG_SECRET)).status, 200);

    const rows = await telegramMessagesFor(chatId);
    assertEquals(rows.filter((m) => m.direction === 'in').length, 2, 'duplicate inbound rows (no dedupe)');
    assertEquals(rows.filter((m) => m.direction === 'out').length, 2, 'duplicate replies (no dedupe)');
  } finally {
    outbound.restore();
    restore();
  }
});
