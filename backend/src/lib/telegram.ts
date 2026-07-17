import { getEnv } from './env.ts';

export type SendTelegramResult = {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
};

export async function sendTelegramText(chatId: number | string, body: string): Promise<SendTelegramResult> {
  const env = getEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: 'telegram_token_unset' };

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: body,
      parse_mode: 'HTML',
    }),
  });

  const json = (await res.json().catch(() => ({}))) as {
    ok: boolean;
    result?: { message_id: number };
    description?: string;
  };

  if (!json.ok) return { ok: false, error: json.description ?? `http_${res.status}` };
  return { ok: true, providerMessageId: json.result?.message_id.toString() };
}
