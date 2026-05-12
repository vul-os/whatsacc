import { getEnv } from './env.ts';

export type SendTextResult = {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
};

export async function sendWhatsAppText(toE164NoPlus: string, body: string): Promise<SendTextResult> {
  const env = getEnv();
  const token = env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return { ok: false, error: 'whatsapp_credentials_unset' };

  const url = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION ?? 'v21.0'}/${phoneId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toE164NoPlus,
      type: 'text',
      text: { preview_url: false, body },
    }),
  });

  const json = (await res.json().catch(() => ({}))) as {
    messages?: Array<{ id: string }>;
    error?: { message?: string };
  };
  if (!res.ok) return { ok: false, error: json.error?.message ?? `http_${res.status}` };
  return { ok: true, providerMessageId: json.messages?.[0]?.id };
}

export type WhatsAppInteractive =
  | {
      type: 'list';
      header?: { type: 'text'; text: string };
      body: { text: string };
      footer?: { text: string };
      action: {
        button: string;
        sections: Array<{
          title?: string;
          rows: Array<{ id: string; title: string; description?: string }>;
        }>;
      };
    }
  | {
      type: 'button';
      header?: { type: 'text'; text: string };
      body: { text: string };
      footer?: { text: string };
      action: {
        buttons: Array<{
          type: 'reply';
          reply: { id: string; title: string };
        }>;
      };
    };

export async function sendWhatsAppInteractive(
  toE164NoPlus: string,
  interactive: WhatsAppInteractive,
): Promise<SendTextResult> {
  const env = getEnv();
  const token = env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return { ok: false, error: 'whatsapp_credentials_unset' };

  const url = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION ?? 'v21.0'}/${phoneId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toE164NoPlus,
      type: 'interactive',
      interactive,
    }),
  });

  const json = (await res.json().catch(() => ({}))) as {
    messages?: Array<{ id: string }>;
    error?: { message?: string };
  };
  if (!res.ok) return { ok: false, error: json.error?.message ?? `http_${res.status}` };
  return { ok: true, providerMessageId: json.messages?.[0]?.id };
}
