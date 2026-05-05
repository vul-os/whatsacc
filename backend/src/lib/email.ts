import { getEnv } from './env.ts';

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
};

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const env = getEnv();
  if (!env.RESEND_API_KEY) {
    console.warn('[email:dev]', JSON.stringify({ to: msg.to, subject: msg.subject, text: msg.text }));
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: msg.from ?? 'whatsacc <noreply@whatsacc.com>',
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`resend send failed: ${res.status} ${body}`);
  }
}
