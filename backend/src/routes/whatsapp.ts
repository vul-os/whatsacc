import { Hono } from 'hono';
import type { JSONValue, TxSql } from '../lib/db.ts';
import type { AppEnv } from '../middleware/auth.ts';
import { withAnonDb } from '../middleware/rls.ts';
import { Forbidden, BadRequest } from '../lib/errors.ts';
import { getEnv } from '../lib/env.ts';
import {
  sendWhatsAppText,
  sendWhatsAppInteractive,
  type WhatsAppInteractive,
} from '../lib/whatsapp.ts';
import { tryConsumeGrant, logAccess } from './access.ts';
import { getAvailableAccessPoints, type AvailableAP } from '../lib/access-lookup.ts';

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

type PendingReply =
  | { type: 'text'; to: string; chatId: string; body: string }
  | { type: 'interactive'; to: string; chatId: string; interactive: WhatsAppInteractive };

type LinkedLocation = { id: string; name: string };

function signupLinkForPhone(phoneE164: string): string {
  const base = getEnv().APP_PUBLIC_URL.replace(/\/$/, '');
  const params = new URLSearchParams({ wa_phone: phoneE164 });
  return `${base}/signup?${params.toString()}`;
}

function uniqueLocations(gates: AvailableAP[]): LinkedLocation[] {
  const seen = new Set<string>();
  const locations: LinkedLocation[] = [];
  for (const gate of gates) {
    if (seen.has(gate.loc_id)) continue;
    seen.add(gate.loc_id);
    locations.push({ id: gate.loc_id, name: gate.loc_name });
  }
  return locations;
}

async function linkedLocationsForPhone(tx: TxSql, phoneE164: string): Promise<LinkedLocation[]> {
  return await tx<LinkedLocation[]>`
    select distinct l.id, l.name
    from profile_phone_numbers ppn
    join account_members am on am.user_id = ppn.profile_id
    join locations l on l.account_id = am.account_id
    where ppn.phone_e164 = ${phoneE164}
      and ppn.verified_at is not null
      and am.status = 'active'
      and l.status = 'active'
    order by l.name asc
  `;
}

function textIncludesName(body: string, name: string): boolean {
  return body.includes(name.toLowerCase().trim());
}

function waTitle(value: string, max = 24): string {
  const clean = value.trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

function findMentionedLocation(body: string, locations: LinkedLocation[]): LinkedLocation | null {
  return locations.find((loc) => textIncludesName(body, loc.name)) ?? null;
}

function findMentionedGate(body: string, gates: AvailableAP[]): AvailableAP | null {
  return gates.find((gate) => textIncludesName(body, gate.ap_name)) ?? null;
}

function pushLocationMenu(
  replies: PendingReply[],
  to: string,
  chatId: string,
  locations: LinkedLocation[],
) {
  replies.push({
    type: 'interactive',
    to,
    chatId,
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Locations' },
      body: { text: 'Welcome back. Which location do you want to use?' },
      action: {
        button: 'Choose location',
        sections: [
          {
            title: 'Your locations',
            rows: locations.slice(0, 10).map((loc) => ({
              id: `select_loc:${loc.id}`,
              title: waTitle(loc.name),
            })),
          },
        ],
      },
    },
  });
}

function gateFooter(gate: AvailableAP): string | undefined {
  if (gate.type === 'visitor') {
    return `You have ${gate.max_uses === null ? 'unlimited' : (gate.max_uses ?? 0) - (gate.uses_count ?? 0)} uses remaining.`;
  }
  return undefined;
}

function pushGateMenu(
  replies: PendingReply[],
  to: string,
  chatId: string,
  locationName: string,
  gates: AvailableAP[],
) {
  if (gates.length === 1) {
    const gate = gates[0]!;
    const footer = gateFooter(gate);
    replies.push({
      type: 'interactive',
      to,
      chatId,
      interactive: {
        type: 'button',
        body: { text: `Welcome to ${locationName}. Message "open" any time, or tap below to open ${gate.ap_name}.` },
        footer: footer ? { text: footer } : undefined,
        action: {
          buttons: [{ type: 'reply', reply: { id: `open_ap:${gate.ap_id}`, title: waTitle(`Open ${gate.ap_name}`, 20) } }],
        },
      },
    });
    return;
  }

  const footer = gates[0] ? gateFooter(gates[0]) : undefined;
  replies.push({
    type: 'interactive',
    to,
    chatId,
    interactive: {
      type: 'list',
      header: { type: 'text', text: locationName },
      body: { text: `Welcome to ${locationName}. Which gate would you like to open?` },
      footer: footer ? { text: footer } : undefined,
      action: {
        button: 'Select gate',
        sections: [
          {
            title: 'Available gates',
            rows: gates.slice(0, 10).map((gate) => ({
              id: `open_ap:${gate.ap_id}`,
              title: waTitle(gate.ap_name),
              description: waTitle(gate.loc_name, 72),
            })),
          },
        ],
      },
    },
  });
}

async function pushAccessCommandResult(
  tx: TxSql,
  replies: PendingReply[],
  to: string,
  chatId: string,
  phoneE164: string,
  accessPointId: string,
  gateName: string,
  command: 'open' | 'close',
) {
  let grantId = await tryConsumeGrant(phoneE164, accessPointId);
  let isMember = false;
  let memberProfileId: string | null = null;

  if (!grantId) {
    const memberCheck = await tx<{ user_id: string }[]>`
      select am.user_id
      from profile_phone_numbers ppn
      join account_members am on am.user_id = ppn.profile_id
      join locations l on l.account_id = am.account_id
      join access_points ap on ap.location_id = l.id
      where ppn.phone_e164 = ${phoneE164}
        and ppn.verified_at is not null
        and ap.id = ${accessPointId}::uuid
        and am.status = 'active'
      limit 1
    `;
    if (memberCheck.length > 0) {
      isMember = true;
      memberProfileId = memberCheck[0]!.user_id;
    }
  }

  if (!(grantId || isMember)) {
    replies.push({
      type: 'text',
      to,
      chatId,
      body: 'Sorry, you no longer have access to this gate.',
    });
    return;
  }

  await logAccess(tx, {
    user_id: memberProfileId,
    access_point_id: accessPointId,
    command,
    source: 'whatsapp',
  });

  replies.push({
    type: 'text',
    to,
    chatId,
    body: `${command === 'close' ? 'Closing' : 'Opening'} ${gateName}...`,
  });

  if (command === 'open') {
    replies.push({
      type: 'interactive',
      to,
      chatId,
      interactive: {
        type: 'button',
        body: { text: `Would you like to close ${gateName}?` },
        action: {
          buttons: [{ type: 'reply', reply: { id: `close_ap:${accessPointId}`, title: waTitle(`Close ${gateName}`, 20) } }],
        },
      },
    });
  }
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
              const locations = allGrants.length > 0
                ? uniqueLocations(allGrants)
                : await linkedLocationsForPhone(tx, from);

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
                if (locations.length === 0) {
                  replies.push({
                    type: 'text',
                    to: msg.from,
                    chatId: chat.id,
                    body: [
                      'Welcome to whatsacc. Your number is connected.',
                      "You don't have a location set up yet. Open the dashboard to add Home, HQ, or your first site.",
                      `${getEnv().APP_PUBLIC_URL.replace(/\/$/, '')}/app`,
                    ].join('\n\n'),
                  });
                  continue;
                }
                replies.push({
                  type: 'text',
                  to: msg.from,
                  chatId: chat.id,
                  body: [
                    `Welcome to ${locations.length === 1 ? locations[0]!.name : 'whatsacc'}.`,
                    locations.length === 1
                      ? 'No gates or doors are ready at this location yet.'
                      : `I found ${locations.length} locations, but none have active gates or doors ready yet.`,
                    `Add an access point in the dashboard: ${getEnv().APP_PUBLIC_URL.replace(/\/$/, '')}/app/access-points`,
                  ].join('\n\n'),
                });
                continue;
              }

              // Check if it's a direct command
              const isClose = body.includes('close');
              const isOpen = body.includes('open');
              const isHelp = body === 'hi' || body === 'hello' || body === 'help' || body === 'menu';

              if ((isOpen || isClose) && !isHelp) {
                const command = isClose ? 'close' : 'open';
                const mentionedLocation = findMentionedLocation(body, locations);
                const locationFiltered = mentionedLocation
                  ? allGrants.filter((g) => g.loc_id === mentionedLocation.id)
                  : allGrants;
                let target = findMentionedGate(body, locationFiltered);

                if (!target && mentionedLocation && locationFiltered.length === 1) {
                  target = locationFiltered[0]!;
                } else if (!target && locations.length === 1 && allGrants.length === 1) {
                  target = allGrants[0]!;
                }

                if (target) {
                  await pushAccessCommandResult(tx, replies, msg.from, chat.id, from, target.ap_id, target.ap_name, command);
                  continue;
                }

                if (mentionedLocation) {
                  pushGateMenu(replies, msg.from, chat.id, mentionedLocation.name, locationFiltered);
                  continue;
                }

                if (locations.length > 1) {
                  pushLocationMenu(replies, msg.from, chat.id, locations);
                  continue;
                }

                pushGateMenu(replies, msg.from, chat.id, locations[0]!.name, allGrants);
                continue;
              }

              if (isHelp) {
                if (locations.length > 1) {
                  pushLocationMenu(replies, msg.from, chat.id, locations);
                } else {
                  pushGateMenu(replies, msg.from, chat.id, locations[0]!.name, allGrants);
                }
                continue;
              }

              // Fallback: Show welcome menu
              if (locations.length === 1) {
                pushGateMenu(replies, msg.from, chat.id, locations[0]!.name, allGrants);
              } else {
                pushLocationMenu(replies, msg.from, chat.id, locations);
              }
            } else if (msg.type === 'interactive') {
              const reply = msg.interactive?.list_reply || msg.interactive?.button_reply;
              if (reply) {
                const parts = reply.id.split(':');
                const rawCommand = parts.length > 1 ? parts[0] : 'open';
                if (rawCommand === 'select_loc') {
                  const locId = parts[1];
                  const allGrants = await getAvailableAccessPoints(tx, { phoneE164: from });
                  const locGates = allGrants.filter((g) => g.loc_id === locId);
                  if (locGates.length === 0) {
                    replies.push({
                      type: 'text',
                      to: msg.from,
                      chatId: chat.id,
                      body: 'That location has no active gates or doors ready yet.',
                    });
                  } else {
                    pushGateMenu(replies, msg.from, chat.id, locGates[0]!.loc_name, locGates);
                  }
                  continue;
                }
                const command = rawCommand.startsWith('close') ? 'close' : 'open';
                const apId = parts.length > 1 ? parts[1]! : reply.id;
                const allGrants = await getAvailableAccessPoints(tx, { phoneE164: from });
                const gate = allGrants.find((g) => g.ap_id === apId);
                const gateName = gate?.ap_name ?? reply.title.replace(/^(Open|Close) /, '');
                await pushAccessCommandResult(tx, replies, msg.from, chat.id, from, apId, gateName, command);
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
