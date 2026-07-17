import { Hono } from 'hono';
import type { JSONValue } from '../lib/db.ts';
import type { AppEnv } from '../middleware/auth.ts';
import { withAnonDb } from '../middleware/rls.ts';
import { Forbidden, BadRequest } from '../lib/errors.ts';
import { getEnv } from '../lib/env.ts';
import { sendTelegramText } from '../lib/telegram.ts';
import { noteChatMessage } from '../lib/rate-limit.ts';

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      is_bot: boolean;
      first_name: string;
      last_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
      title?: string;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
    date: number;
    text?: string;
    [k: string]: unknown;
  };
};

// Log the missing-secret refusal once per isolate, not per request.
let warnedMissingTelegramSecret = false;

function telegramRouter() {
  const app = new Hono<AppEnv>();

  app.post('/webhooks/telegram', async (c) => {
    // Fail closed, mirroring the Slack webhook: without a configured secret
    // token we refuse to process entirely instead of accepting ANY
    // unauthenticated POST (chat rows + bot replies for anyone — and a real
    // gate bypass the day this handler grows access logic).
    const secret = getEnv().TELEGRAM_WEBHOOK_SECRET;
    if (!secret) {
      if (!warnedMissingTelegramSecret) {
        console.error(
          'TELEGRAM_WEBHOOK_SECRET is not configured — refusing all Telegram webhooks (fail closed).',
        );
        warnedMissingTelegramSecret = true;
      }
      throw Forbidden('telegram_not_configured');
    }
    const headerSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
    if (headerSecret !== secret) throw Forbidden('bad_secret_token');

    let update: TelegramUpdate;
    try {
      update = await c.req.json();
    } catch {
      throw BadRequest('bad_json');
    }

    if (!update.message) return c.json({ ok: true });
    const msg = update.message;
    const from = msg.from;
    if (!from || from.is_bot) return c.json({ ok: true });

    type PendingReply = { to: number; chatId: string; body: string };
    const replies: PendingReply[] = [];

    await withAnonDb(async (tx) => {
      const chatRows = await tx<{ id: string; profile_id: string | null }[]>`
        insert into telegram_chats (chat_id, username, first_name, last_name, last_inbound_at)
        values (${msg.chat.id}, ${msg.chat.username ?? null}, ${msg.chat.first_name ?? null}, ${msg.chat.last_name ?? null}, now())
        on conflict (chat_id) do update set 
          username = excluded.username,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          last_inbound_at = excluded.last_inbound_at
        returning id, profile_id
      `;
      const chat = chatRows[0]!;
      
      const kind = msg.text ? 'text' : 'system'; // simplistic for now
      const inboundRows = await tx<{ id: string }[]>`
        insert into telegram_messages
          (chat_id, direction, kind, body, provider_message_id, status, ts)
        values
          (${chat.id}, 'in', ${kind}, ${tx.json(msg as unknown as JSONValue)},
           ${msg.message_id.toString()}, 'received', to_timestamp(${msg.date}))
        on conflict do nothing
        returning id
      `;
      if (inboundRows.length === 0) {
        // Redelivered update (telegram_messages_inbound_provider_unique
        // arbitrated the conflict) — already processed, don't reply twice.
        console.log('TG duplicate update ignored:', { chatId: msg.chat.id, messageId: msg.message_id });
        return;
      }

      // Webhook flood throttle — same policy as WhatsApp/Slack: go quiet
      // past the per-minute cap but still 200 so Telegram doesn't retry.
      const throttle = await noteChatMessage(tx, `tg:${msg.chat.id}`);
      if (!throttle.quiet && msg.text) {
        const text = msg.text.trim().toLowerCase();
        const reply = text === 'open' ? 'success' : 'failed';
        replies.push({ to: msg.chat.id, chatId: chat.id, body: reply });
      }
    });

    for (const r of replies) {
      const sent = await sendTelegramText(r.to, r.body);
      await withAnonDb(async (tx) => {
        await tx`
          insert into telegram_messages
            (chat_id, direction, kind, body, provider_message_id, status, ts)
          values
            (${r.chatId}, 'out', 'text',
             ${tx.json({ text: r.body } as unknown as JSONValue)},
             ${sent.providerMessageId ?? null},
             ${sent.ok ? 'sent' : `failed:${sent.error ?? 'unknown'}`},
             now())
        `;
        await tx`
          update telegram_chats
          set last_outbound_at = now()
          where id = ${r.chatId}
        `;
      });
    }

    return c.json({ ok: true });
  });

  return app;
}

export const telegramRoutes = telegramRouter();
