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

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;'
  );
}

export type TemplateInput = {
  preheader: string;
  heading: string;
  bodyParagraphs: string[];
  cta?: { label: string; url: string };
  footnote?: string;
};

const INK = '#1a1f36';
const INK_SOFT = '#2c3350';
const INK_FAINT = 'rgba(26,31,54,0.62)';
const PAPER = '#f4ede2';
const PAPER_COOL = '#f8f3ea';
const PAPER_EDGE = 'rgba(26,31,54,0.08)';
const TERRACOTTA = '#d6624d';
const TERRACOTTA_DEEP = '#b14b39';

const FONT_STACK =
  "ui-serif, 'Iowan Old Style', 'Apple Garamond', Baskerville, 'Times New Roman', serif";
const SANS_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export function renderEmail(input: TemplateInput): { html: string; text: string } {
  const paragraphs = input.bodyParagraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-family:${SANS_STACK};font-size:16px;line-height:1.6;color:${INK_SOFT};">${p}</p>`,
    )
    .join('');

  const button = input.cta
    ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
        <tr>
          <td align="center" bgcolor="${TERRACOTTA}" style="border-radius:10px;">
            <a href="${input.cta.url}"
               style="display:inline-block;padding:14px 28px;font-family:${SANS_STACK};font-size:15px;font-weight:600;letter-spacing:0.01em;color:#ffffff;text-decoration:none;border-radius:10px;background-color:${TERRACOTTA};border:1px solid ${TERRACOTTA_DEEP};">
              ${escapeHtml(input.cta.label)}
            </a>
          </td>
        </tr>
      </table>`
    : '';

  const fallbackLink = input.cta
    ? `
      <p style="margin:0 0 8px;font-family:${SANS_STACK};font-size:13px;line-height:1.6;color:${INK_FAINT};">
        Or paste this link into your browser:
      </p>
      <p style="margin:0 0 24px;font-family:${SANS_STACK};font-size:13px;line-height:1.5;color:${INK_FAINT};word-break:break-all;">
        <a href="${input.cta.url}" style="color:${TERRACOTTA_DEEP};text-decoration:underline;">${input.cta.url}</a>
      </p>`
    : '';

  const footnoteBlock = input.footnote
    ? `<p style="margin:0;font-family:${SANS_STACK};font-size:13px;line-height:1.6;color:${INK_FAINT};">${input.footnote}</p>`
    : '';

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(input.heading)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:${PAPER};">
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${PAPER};">${escapeHtml(input.preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAPER}" style="background-color:${PAPER};">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
            <tr>
              <td style="padding:0 8px 20px;">
                <a href="https://whatsacc.com" style="text-decoration:none;color:${INK};font-family:${FONT_STACK};font-size:22px;font-weight:600;letter-spacing:0.01em;">whatsacc</a>
              </td>
            </tr>
            <tr>
              <td bgcolor="${PAPER_COOL}" style="background-color:${PAPER_COOL};border:1px solid ${PAPER_EDGE};border-radius:14px;padding:36px 36px 32px;">
                <h1 style="margin:0 0 20px;font-family:${FONT_STACK};font-size:26px;line-height:1.2;color:${INK};font-weight:600;letter-spacing:-0.01em;">${escapeHtml(input.heading)}</h1>
                ${paragraphs}
                ${button}
                ${fallbackLink}
                ${footnoteBlock}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 8px 0;font-family:${SANS_STACK};font-size:12px;line-height:1.6;color:${INK_FAINT};">
                Sent by whatsacc · Texts that open gates.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textParts = [
    input.heading,
    '',
    ...input.bodyParagraphs.map(stripTags),
    ...(input.cta ? ['', input.cta.label + ': ' + input.cta.url] : []),
    ...(input.footnote ? ['', stripTags(input.footnote)] : []),
    '',
    '— whatsacc',
  ];

  return { html, text: textParts.join('\n') };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}
