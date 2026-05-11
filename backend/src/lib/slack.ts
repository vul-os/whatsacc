import { getEnv } from './env.ts';

export type SendSlackResult = {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
};

export async function sendSlackText(channelId: string, body: string): Promise<SendSlackResult> {
  const env = getEnv();
  const token = env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: 'slack_token_unset' };

  const url = 'https://slack.com/api/chat.postMessage';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel: channelId,
      text: body,
    }),
  });

  const json = (await res.json().catch(() => ({}))) as {
    ok: boolean;
    ts?: string;
    error?: string;
  };

  if (!json.ok) return { ok: false, error: json.error ?? `http_${res.status}` };
  return { ok: true, providerMessageId: json.ts };
}
