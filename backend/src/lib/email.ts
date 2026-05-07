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
  // Never call Resend from the test suite, even if a key is loaded from .env —
  // it burns the daily quota and makes the suite flake.
  if (env.APP_ENV === 'test' || !env.RESEND_API_KEY) {
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

// Brand palette — mirrors src/styles/main.css so emails feel like the app.
const INK = '#1a1f36';
const INK_SOFT = '#2c3350';
const INK_FAINT = 'rgba(26,31,54,0.62)';
const INK_HAIR = 'rgba(26,31,54,0.10)';
const PAPER = '#f4ede2';
const PAPER_COOL = '#f8f3ea';
const PAPER_EDGE = 'rgba(26,31,54,0.08)';
const TERRACOTTA = '#d6624d';
const TERRACOTTA_DEEP = '#b14b39';
const TERRACOTTA_SOFT = 'rgba(214,98,77,0.18)';

const FONT_DISPLAY =
  "'Fraunces', 'Iowan Old Style', 'Apple Garamond', Baskerville, 'Times New Roman', serif";
const FONT_SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

// Inline SVG mark — same arch + terracotta keystone dot as the app's
// ArchMark component. Renders crisply in Apple Mail, Gmail web, iOS, and
// most modern clients; Outlook desktop omits SVG so the wordmark beside it
// keeps the brand visible.
const LOGO_SVG = `<svg width="36" height="36" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="whatsacc">
  <rect width="64" height="64" rx="14" fill="${INK}"/>
  <path d="M16 50 V32 a16 16 0 0 1 32 0 V50 H40 V32 a8 8 0 0 0 -16 0 V50 Z" fill="none" stroke="${PAPER}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="32" cy="42" r="2.6" fill="${TERRACOTTA}"/>
</svg>`;

function header(): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      <tr>
        <td valign="middle" style="padding:0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
            <tr>
              <td valign="middle" style="padding:0 12px 0 0;line-height:0;">${LOGO_SVG}</td>
              <td valign="middle" style="font-family:${FONT_DISPLAY};font-size:22px;font-weight:600;color:${INK};letter-spacing:-0.01em;">
                <a href="https://whatsacc.com" style="text-decoration:none;color:${INK};">whatsacc</a>
              </td>
            </tr>
          </table>
        </td>
        <td valign="middle" align="right" style="font-family:${FONT_SANS};font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(26,31,54,0.45);">
          Transactional
        </td>
      </tr>
    </table>`;
}

export function renderEmail(input: TemplateInput): { html: string; text: string } {
  const paragraphs = input.bodyParagraphs
    .map(
      (p) =>
        `<p style="margin:0 0 18px;font-family:${FONT_SANS};font-size:16px;line-height:1.65;color:${INK_SOFT};">${p}</p>`,
    )
    .join('');

  const button = input.cta
    ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 28px;border-collapse:separate;">
        <tr>
          <td align="center" bgcolor="${TERRACOTTA}" style="border-radius:10px;box-shadow:0 1px 0 ${TERRACOTTA_DEEP};">
            <a href="${input.cta.url}"
               style="display:inline-block;padding:14px 30px;font-family:${FONT_SANS};font-size:15px;font-weight:600;letter-spacing:0.01em;color:#ffffff;text-decoration:none;border-radius:10px;background-color:${TERRACOTTA};border:1px solid ${TERRACOTTA_DEEP};mso-padding-alt:14px 30px;">
              ${escapeHtml(input.cta.label)}
            </a>
          </td>
        </tr>
      </table>`
    : '';

  const fallbackLink = input.cta
    ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;border-top:1px solid ${INK_HAIR};">
        <tr>
          <td style="padding-top:18px;">
            <p style="margin:0 0 6px;font-family:${FONT_SANS};font-size:12px;line-height:1.5;color:${INK_FAINT};text-transform:uppercase;letter-spacing:0.08em;">
              Or paste this link into your browser
            </p>
            <p style="margin:0;font-family:${FONT_SANS};font-size:13px;line-height:1.5;color:${INK_FAINT};word-break:break-all;">
              <a href="${input.cta.url}" style="color:${TERRACOTTA_DEEP};text-decoration:underline;">${input.cta.url}</a>
            </p>
          </td>
        </tr>
      </table>`
    : '';

  const footnoteBlock = input.footnote
    ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td bgcolor="${PAPER}" style="background-color:${PAPER};border-left:3px solid ${TERRACOTTA_SOFT};padding:14px 16px;border-radius:0 8px 8px 0;">
            <p style="margin:0;font-family:${FONT_SANS};font-size:13px;line-height:1.6;color:${INK_FAINT};">${input.footnote}</p>
          </td>
        </tr>
      </table>`
    : '';

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${escapeHtml(input.heading)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:${PAPER};-webkit-font-smoothing:antialiased;">
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${PAPER};">${escapeHtml(input.preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAPER}" style="background-color:${PAPER};">
      <tr>
        <td align="center" style="padding:48px 16px 56px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
            <tr>
              <td style="padding:0 4px 24px;">
                ${header()}
              </td>
            </tr>
            <tr>
              <td bgcolor="${PAPER_COOL}" style="background-color:${PAPER_COOL};border:1px solid ${PAPER_EDGE};border-radius:14px;padding:44px 44px 38px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:0 0 18px;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td style="padding:0 8px 0 0;line-height:0;">
                            <span style="display:inline-block;width:5px;height:5px;background-color:${TERRACOTTA};border-radius:50%;line-height:0;font-size:0;">&nbsp;</span>
                          </td>
                          <td style="font-family:${FONT_SANS};font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:rgba(26,31,54,0.55);">
                            Whatsacc &middot; account
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
                <h1 style="margin:0 0 22px;font-family:${FONT_DISPLAY};font-size:30px;line-height:1.15;color:${INK};font-weight:600;letter-spacing:-0.02em;">${escapeHtml(input.heading)}</h1>
                ${paragraphs}
                ${button}
                ${fallbackLink}
                ${footnoteBlock}
              </td>
            </tr>
            <tr>
              <td style="padding:28px 4px 0;border-top:1px solid ${INK_HAIR};margin-top:24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:24px 4px 0;">
                      <p style="margin:0 0 4px;font-family:${FONT_SANS};font-size:11px;line-height:1.6;color:${INK};font-weight:600;letter-spacing:0.02em;">whatsacc</p>
                      <p style="margin:0 0 10px;font-family:${FONT_DISPLAY};font-size:13px;line-height:1.5;color:${INK_FAINT};font-style:italic;">Texts that open gates.</p>
                      <p style="margin:0;font-family:${FONT_SANS};font-size:11px;line-height:1.6;color:${INK_FAINT};">
                        This is a transactional message about your whatsacc account. Manage settings at
                        <a href="https://whatsacc.com" style="color:${INK_FAINT};text-decoration:underline;">whatsacc.com</a>.
                      </p>
                    </td>
                    <td valign="top" align="right" style="padding:24px 4px 0;font-family:${FONT_SANS};font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:rgba(26,31,54,0.4);white-space:nowrap;">
                      Made in ZA
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textParts = [
    'whatsacc',
    '',
    input.heading,
    '',
    ...input.bodyParagraphs.map(stripTags),
    ...(input.cta ? ['', input.cta.label + ': ' + input.cta.url] : []),
    ...(input.footnote ? ['', stripTags(input.footnote)] : []),
    '',
    '— whatsacc · Texts that open gates.',
  ];

  return { html, text: textParts.join('\n') };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}
