import { Hono } from 'hono';
import type { JSONValue } from '../lib/db.ts';
import type { AppEnv } from '../middleware/auth.ts';
import { withAnonDb } from '../middleware/rls.ts';
import { Forbidden, BadRequest } from '../lib/errors.ts';
import { getEnv } from '../lib/env.ts';
import { getAccountQuotaStatus } from '../lib/billing/quota.ts';
import {
  sendWhatsAppText,
  sendWhatsAppInteractive,
  type WhatsAppInteractive,
} from '../lib/whatsapp.ts';
import { tryConsumeGrant, logAccess } from './access.ts';
import { getAvailableAccessPoints } from '../lib/access-lookup.ts';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

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
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

type WhatsAppValue = {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
  messages?: Array<{
    id: string;
    from: string;
    timestamp: string;
    type: string;
    text?: { body: string };
    interactive?: {
      type: 'list_reply' | 'button_reply';
      list_reply?: { id: string; title: string; description?: string };
      button_reply?: { id: string; title: string };
    };
    [k: string]: unknown;
  }>;
  statuses?: Array<{ id: string; status: string; timestamp: string }>;
};

type WhatsAppPayload = {
  object?: string;
  entry?: Array<{
    id: string;
    changes: Array<{ field: string; value: WhatsAppValue }>;
  }>;
};

function signupLinkForPhone(phoneE164: string): string {
  const base = getEnv().APP_PUBLIC_URL.replace(/\/$/, '');
  const params = new URLSearchParams({ wa_phone: phoneE164 });
  return `${base}/signup?${params.toString()}`;
}

function whatsappRouter() {
  const app = new Hono<AppEnv>();

  // Meta webhook verification handshake. Verify token is sent in plaintext
  // by Meta on the GET handshake — keep it distinct from the App Secret used
  // to HMAC-sign POST payloads.
  app.get('/webhooks/whatsapp', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    const expected = getEnv().WHATSAPP_VERIFY_TOKEN;
    if (mode === 'subscribe' && token && expected && token === expected) {
      return c.text(challenge ?? '');
    }
    throw Forbidden('verify_token_mismatch');
  });

  app.post('/webhooks/whatsapp', async (c) => {
    const raw = await c.req.text();
    const sigHeader = c.req.header('X-Hub-Signature-256');
    const secret = getEnv().WHATSAPP_APP_SECRET;

    console.log('WA Webhook:', {
      hasRaw: !!raw,
      sigHeader,
      hasSecret: !!secret,
    });

    if (!secret) throw Forbidden('webhook_secret_unset');
    if (!sigHeader || !sigHeader.startsWith('sha256=')) throw Forbidden('missing_signature');
    const expected = `sha256=${await hmacSha256Hex(secret, raw)}`;
    if (!timingSafeEqual(expected, sigHeader)) {
      console.error('WA Signature Mismatch');
      throw Forbidden('bad_signature');
    }

    let payload: WhatsAppPayload;
    try {
      payload = JSON.parse(raw) as WhatsAppPayload;
    } catch {
      throw BadRequest('bad_json');
    }

    type PendingReply =
      | { type: 'text'; to: string; chatId: string; body: string }
      | { type: 'interactive'; to: string; chatId: string; interactive: WhatsAppInteractive };
    const replies: PendingReply[] = [];

    // Meta delivers webhooks for every phone number on the WABA, not just
    // ours. Drop changes targeted at any other phone_number_id so we don't
    // process / reply to messages meant for a sibling project's bot.
    const ourPhoneId = getEnv().WHATSAPP_PHONE_NUMBER_ID;
    console.log('WA Config:', { ourPhoneId });

    await withAnonDb(async (tx) => {
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value;
          const incomingPhoneId = value.metadata?.phone_number_id;
          console.log('WA Incoming Msg:', { incomingPhoneId, msgCount: value.messages?.length });

          if (ourPhoneId && incomingPhoneId && incomingPhoneId !== ourPhoneId) {
            console.warn('WA ID Mismatch — ignoring');
            continue;
          }
          for (const msg of value.messages ?? []) {
            const from = `+${msg.from}`;
            const chatRows = await tx<{ id: string; profile_id: string | null }[]>`
              insert into whatsapp_chats (phone_e164, last_inbound_at)
              values (${from}, now())
              on conflict (phone_e164) do update set last_inbound_at = excluded.last_inbound_at
              returning id, profile_id
            `;
            const chat = chatRows[0]!;
            const inboundRows = await tx<{ id: string }[]>`
              insert into whatsapp_messages
                (chat_id, direction, kind, body, provider_message_id, status, ts)
              values
                (${chat.id}, 'in', ${msg.type}, ${tx.json(msg as unknown as JSONValue)},
                 ${msg.id}, 'received', to_timestamp(${Number(msg.timestamp)}))
              on conflict do nothing
              returning id
            `;
            if (inboundRows.length === 0) {
              console.log('WA duplicate message ignored:', { providerMessageId: msg.id });
              continue;
            }

            if (msg.type === 'text') {
              const body = msg.text?.body?.toLowerCase().trim() ?? '';
              const allGrants = await getAvailableAccessPoints(tx, { phoneE164: from });

              if (allGrants.length === 0) {
                const linkedRows = await tx<{ exists: boolean }[]>`
                  select exists (
                    select 1
                    from profile_phone_numbers
                    where phone_e164 = ${from}
                      and verified_at is not null
                  ) as "exists"
                `;
                if (!linkedRows[0]?.exists) {
                  replies.push({
                    type: 'text',
                    to: msg.from,
                    chatId: chat.id,
                    body: [
                      "Hello! This WhatsApp number isn't linked to a whatsacc account yet.",
                      `Create your account here: ${signupLinkForPhone(from)}`,
                      "After signup, we'll ask if you want to connect this number.",
                    ].join('\n\n'),
                  });
                  continue;
                }
                replies.push({
                  type: 'text',
                  to: msg.from,
                  chatId: chat.id,
                  body: "Hello! You don't have any active gate access linked to this number. Please contact the administrator if you believe this is an error.",
                });
                continue;
              }

              // Check if it's a direct command
              const isClose = body.includes('close');
              const isOpen = body.includes('open');
              const isHelp = body === 'hi' || body === 'hello' || body === 'help' || body === 'menu';

              if ((isOpen || isClose) && !isHelp) {
                const command = isClose ? 'close' : 'open';
                let target = allGrants.length === 1 ? allGrants[0] : null;
                if (!target && allGrants.length > 1) {
                  // Try matching by name
                  target = allGrants.find((g) => body.includes(g.ap_name.toLowerCase())) ?? null;
                }

                if (target) {
                  // Execute command
                  let grantId = await tryConsumeGrant(from, target.ap_id);
                  let isMember = false;
                  let memberProfileId: string | null = null;

                  if (!grantId) {
                    const memberCheck = await tx<{ user_id: string }[]>`
                      select am.user_id
                      from profile_phone_numbers ppn
                      join account_members am on am.user_id = ppn.profile_id
                      join locations l on l.account_id = am.account_id
                      join access_points ap on ap.location_id = l.id
                      where ppn.phone_e164 = ${from}
                        and ppn.verified_at is not null
                        and ap.id = ${target.ap_id}::uuid
                        and am.status = 'active'
                      limit 1
                    `;
                    if (memberCheck.length > 0) {
                      isMember = true;
                      memberProfileId = memberCheck[0]!.user_id;
                    }
                  }

                  if (grantId || isMember) {
                    const result = await logAccess(tx, {
                      user_id: memberProfileId,
                      access_point_id: target.ap_id,
                      command,
                      source: 'whatsapp',
                    });

                    if (result.ok) {
                      replies.push({
                        type: 'text',
                        to: msg.from,
                        chatId: chat.id,
                        body: `✅ ${command === 'close' ? 'Closing' : 'Opening'} ${target.ap_name}...`,
                      });
                      if (command === 'open') {
                        replies.push({
                          type: 'interactive',
                          to: msg.from,
                          chatId: chat.id,
                          interactive: {
                            type: 'button',
                            body: { text: `Would you like to close the ${target.ap_name}?` },
                            action: {
                              buttons: [
                                {
                                  type: 'reply',
                                  reply: { id: `close_ap:${target.ap_id}`, title: `Close ${target.ap_name}` },
                                },
                              ],
                            },
                          },
                        });
                      }
                      continue; // Handled command, don't show menu
                    } else {
                      replies.push({
                        type: 'text',
                        to: msg.from,
                        chatId: chat.id,
                        body: `❌ Sorry, gate could not be ${command === 'close' ? 'closed' : 'opened'}: ${result.error === 'quota_exhausted' ? 'Monthly quota exhausted.' : 'System error.'}`,
                      });
                      continue;
                    }
                  }
                }
              }

              // Fallback: Show welcome menu
              if (allGrants.length === 1) {
                const g = allGrants[0]!;
                // ... rest of the existing welcome logic for single gate
                let quotaFooter: string | undefined;
                if (g.type === 'member') {
                  const apData = await tx<{ account_id: string }[]>`
                    select l.account_id from access_points ap join locations l on l.id = ap.location_id where ap.id = ${g.ap_id}
                  `;
                  if (apData[0]) {
                    const status = await getAccountQuotaStatus(tx, apData[0].account_id);
                    const bal = (status.wallet_balance_cents / 100).toFixed(2);
                    quotaFooter = `Included: ${status.remaining_included}/${status.total_included} | Wallet: ${status.wallet_currency} ${bal}`;
                  }
                }
                const footerText = g.type === 'visitor' 
                  ? `You have ${g.max_uses === null ? 'unlimited' : (g.max_uses ?? 0) - (g.uses_count ?? 0)} uses remaining.`
                  : quotaFooter;

                replies.push({
                  type: 'interactive',
                  to: msg.from,
                  chatId: chat.id,
                  interactive: {
                    type: 'button',
                    body: { text: `Welcome! Would you like to open the ${g.ap_name}?` },
                    footer: footerText ? { text: footerText } : undefined,
                    action: {
                      buttons: [{ type: 'reply', reply: { id: `open_ap:${g.ap_id}`, title: `Open ${g.ap_name}` } }],
                    },
                  },
                });
              } else {
                // ... rest of the existing welcome logic for multiple gates
                let listFooter: string | undefined;
                const apData = await tx<{ account_id: string }[]>`
                  select l.account_id from access_points ap join locations l on l.id = ap.location_id where ap.id = ${allGrants[0]!.ap_id}
                `;
                if (apData[0]) {
                   const status = await getAccountQuotaStatus(tx, apData[0].account_id);
                   const bal = (status.wallet_balance_cents / 100).toFixed(2);
                   listFooter = `Included: ${status.remaining_included}/${status.total_included} | Wallet: ${status.wallet_currency} ${bal}`;
                }

                replies.push({
                  type: 'interactive',
                  to: msg.from,
                  chatId: chat.id,
                  interactive: {
                    type: 'list',
                    header: { type: 'text', text: 'Gate Access' },
                    body: { text: 'Welcome! Please select the gate you would like to open.' },
                    footer: listFooter ? { text: listFooter } : undefined,
                    action: {
                      button: 'Select Gate',
                      sections: [
                        {
                          title: 'Available Gates',
                          rows: allGrants.slice(0, 10).map((g) => ({
                            id: `open_ap:${g.ap_id}`,
                            title: g.ap_name,
                            description: g.loc_name,
                          })),
                        },
                      ],
                    },
                  },
                });
              }
            } else if (msg.type === 'interactive') {
              const reply = msg.interactive?.list_reply || msg.interactive?.button_reply;
              if (reply) {
                const parts = reply.id.split(':');
                const rawCommand = parts.length > 1 ? parts[0] : 'open';
                const command = rawCommand.startsWith('close') ? 'close' : 'open';
                const apId = parts.length > 1 ? parts[1]! : reply.id;
                
                // Try consuming as visitor first
                let grantId = await tryConsumeGrant(from, apId);
                let isMember = false;
                let memberProfileId: string | null = null;

                if (!grantId) {
                  // If not visitor, check if they are a member
                  const memberCheck = await tx<{ user_id: string }[]>`
                    select am.user_id
                    from profile_phone_numbers ppn
                    join account_members am on am.user_id = ppn.profile_id
                    join locations l on l.account_id = am.account_id
                    join access_points ap on ap.location_id = l.id
                    where ppn.phone_e164 = ${from}
                      and ppn.verified_at is not null
                      and ap.id = ${apId}::uuid
                      and am.status = 'active'
                    limit 1
                  `;
                  if (memberCheck.length > 0) {
                    isMember = true;
                    memberProfileId = memberCheck[0]!.user_id;
                  }
                }

                if (grantId || isMember) {
                  const result = await logAccess(tx, {
                    user_id: memberProfileId,
                    access_point_id: apId,
                    command,
                    source: 'whatsapp',
                  });

                  if (result.ok) {
                    const gateName = reply.title.replace(/^(Open|Close) /, '');
                    if (command === 'close') {
                       replies.push({
                        type: 'text',
                        to: msg.from,
                        chatId: chat.id,
                        body: `✅ Closing ${gateName}...`,
                      });
                    } else {
                      replies.push({
                        type: 'text',
                        to: msg.from,
                        chatId: chat.id,
                        body: `✅ Opening ${gateName}...`,
                      });
                      
                      // Add "Close" button for convenience
                      replies.push({
                        type: 'interactive',
                        to: msg.from,
                        chatId: chat.id,
                        interactive: {
                          type: 'button',
                          body: { text: `Would you like to close the ${gateName}?` },
                          action: {
                            buttons: [
                              {
                                type: 'reply',
                                reply: { id: `close_ap:${apId}`, title: `Close ${gateName}` },
                              },
                            ],
                          },
                        },
                      });
                    }
                  } else {
                    replies.push({
                      type: 'text',
                      to: msg.from,
                      chatId: chat.id,
                      body: `❌ Sorry, gate could not be ${command === 'close' ? 'closed' : 'opened'}: ${result.error === 'quota_exhausted' ? 'Monthly quota exhausted. Please contact admin or top up wallet.' : 'System error.'}`,
                    });
                  }
                } else {
                  replies.push({
                    type: 'text',
                    to: msg.from,
                    chatId: chat.id,
                    body: `❌ Sorry, you no longer have access to this gate.`,
                  });
                }
              }
            }
          }
        }
      }
    });

    // Send replies outside the DB tx so a slow Meta API call doesn't hold a
    // connection. Persist outbound rows after each send completes.
    for (const r of replies) {
      const sent =
        r.type === 'text'
          ? await sendWhatsAppText(r.to, r.body)
          : await sendWhatsAppInteractive(r.to, r.interactive);

      await withAnonDb(async (tx) => {
        const kind = r.type === 'text' ? 'text' : 'interactive';
        const body = r.type === 'text' ? { text: { body: r.body } } : r.interactive;

        await tx`
          insert into whatsapp_messages
            (chat_id, direction, kind, body, provider_message_id, status, ts)
          values
            (${r.chatId}, 'out', ${kind},
             ${tx.json(body as unknown as JSONValue)},
             ${sent.providerMessageId ?? null},
             ${sent.ok ? 'sent' : `failed:${sent.error ?? 'unknown'}`},
             now())
        `;
        await tx`
          update whatsapp_chats
          set last_outbound_at = now()
          where id = ${r.chatId}
        `;
      });
    }

    return c.json({ ok: true });
  });

  return app;
}

export const whatsappRoutes = whatsappRouter();
