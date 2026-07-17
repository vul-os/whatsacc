// Security tests for the abuse-protection rate-limit/quota system:
//
//   1. Cross-tenant isolation — account A exhausting its limits neither
//      affects account B nor lets B inspect/exhaust A's counters.
//   2. The counters table is internal: invisible and unwritable through the
//      user-facing RLS surface, even for authenticated members.
//   3. Chat flood throttle silences the bot but still returns 200 to Meta
//      (no retry amplification).
//   4. No quota bypass via alternate open paths — portal, WhatsApp and API
//      share one enforcement point.

import { assert, assertEquals } from '../helpers/assert.ts';
import { withRLS } from '@/lib/db.ts';
import { resetEnvCache } from '@/lib/env.ts';
import { bootTestApp, type AppHandle } from '../helpers/app.ts';
import { resetData, setupTestDb } from '../helpers/db.ts';
import { registerUser, seedLocationWithAccessPoint, type RegisteredUser } from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';

const WA_SECRET = 'test-wa-secret';

const RATE_KEYS = [
  'RATE_OPEN_COOLDOWN_S',
  'RATE_OPENS_PER_HOUR',
  'RATE_CHAT_MSGS_PER_MIN',
  'RATE_ACCOUNT_OPENS_PER_HOUR',
] as const;

function setRate(overrides: Partial<Record<(typeof RATE_KEYS)[number], string>>): () => void {
  const prior: Record<string, string | undefined> = {};
  for (const k of RATE_KEYS) prior[k] = process.env[k];
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  resetEnvCache();
  return () => {
    for (const k of RATE_KEYS) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
    resetEnvCache();
  };
}

async function signWhatsAppBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return `sha256=${hex}`;
}

function setWhatsAppSecret(value: string | undefined): void {
  if (value === undefined) delete process.env.WHATSAPP_APP_SECRET;
  else process.env.WHATSAPP_APP_SECRET = value;
  resetEnvCache();
}

let waMsgSeq = 0;

/** POST a signed WhatsApp text-message webhook from `fromNoPlus`. */
async function postWhatsAppText(
  app: AppHandle,
  fromNoPlus: string,
  text: string,
): Promise<number> {
  waMsgSeq += 1;
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              messages: [
                {
                  id: `wamid.test-${Date.now()}-${waMsgSeq}`,
                  from: fromNoPlus,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const sig = await signWhatsAppBody(WA_SECRET, payload);
  const r = await app.request('POST', '/webhooks/whatsapp', {
    rawBody: payload,
    contentType: 'application/json',
    headers: { 'X-Hub-Signature-256': sig },
  });
  return r.status;
}

async function adminSql<T>(fn: (tx: Parameters<Parameters<typeof withRLS>[1]>[0]) => Promise<T>) {
  return await withRLS({ user_id: '', account_id: null, is_platform_admin: true }, fn);
}

async function linkVerifiedPhone(userId: string, phoneE164: string): Promise<void> {
  await adminSql(async (tx) => {
    await tx`
      insert into profile_phone_numbers (profile_id, phone_e164, verified_at, is_primary)
      values (${userId}, ${phoneE164}, now(), true)
    `;
  });
}

async function successfulOpens(apId: string): Promise<number> {
  const rows = await adminSql(
    async (tx) =>
      await tx<{ count: string }[]>`
        select count(*)::text as count from access_logs
        where access_point_id = ${apId} and command = 'open' and success = true
      `,
  );
  return Number(rows[0]!.count);
}

async function openAp(app: AppHandle, u: RegisteredUser, apId: string, source = 'web') {
  return await app.request('POST', `/access/access-points/${apId}/open`, {
    token: u.access_token,
    json: { source },
  });
}

// ---------------------------------------------------------------------------

dbTest('sec: account A exhausting its ceiling does not throttle account B', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setRate({ RATE_OPEN_COOLDOWN_S: '0', RATE_ACCOUNT_OPENS_PER_HOUR: '1' });
  try {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const apA = (await seedLocationWithAccessPoint(a.account_id, { withAccessPoint: true }))
      .access_point_id!;
    const apB = (await seedLocationWithAccessPoint(b.account_id, { withAccessPoint: true }))
      .access_point_id!;

    assertEquals((await openAp(app, a, apA)).status, 200);
    const aBlocked = await openAp(app, a, apA);
    assertEquals(aBlocked.status, 429);

    // Account B has fully independent counters — nothing A did affects it.
    assertEquals((await openAp(app, b, apB)).status, 200);
  } finally {
    restore();
  }
});

dbTest('sec: counters are invisible and unwritable through the user RLS surface', async () => {
  await resetData();
  const app = await bootTestApp();
  const { sql } = await setupTestDb();
  const a = await registerUser(app);
  const b = await registerUser(app);
  const apA = (await seedLocationWithAccessPoint(a.account_id, { withAccessPoint: true }))
    .access_point_id!;
  assertEquals((await openAp(app, a, apA)).status, 200);

  // Counters exist (superuser view)...
  const raw = await sql<{ count: string }[]>`select count(*)::text as count from rate_limit_counters`;
  assert(Number(raw[0]!.count) > 0, 'expected counter rows after an open');

  // ...but through the request-role RLS surface (FORCEd RLS, zero policies)
  // neither the owner nor another tenant sees a single row.
  for (const user of [a, b]) {
    const visible = await withRLS(
      { user_id: user.user_id, account_id: user.account_id, is_platform_admin: false },
      async (tx) =>
        await tx<{ count: string }[]>`select count(*)::text as count from rate_limit_counters`,
    );
    assertEquals(visible[0]!.count, '0', 'rate_limit_counters must be internal-only');
  }

  // Direct writes are rejected outright — user B cannot reset or forge
  // counters (e.g. to exhaust A's budget or clear their own).
  let writeFailed = false;
  try {
    await withRLS(
      { user_id: b.user_id, account_id: b.account_id, is_platform_admin: false },
      async (tx) => {
        await tx`
          insert into rate_limit_counters (scope, subject, window_start, count)
          values ('acct_opens_1h', ${'acct:' + a.account_id}, now(), 999999)
        `;
      },
    );
  } catch {
    writeFailed = true;
  }
  assert(writeFailed, 'direct insert into rate_limit_counters must be denied');
});

dbTest('sec: chat flood throttle goes quiet but still 200s to Meta', async () => {
  await resetData();
  const app = await bootTestApp();
  setWhatsAppSecret(WA_SECRET);
  const restore = setRate({ RATE_CHAT_MSGS_PER_MIN: '2' });
  try {
    const phone = '27831110001';
    // Unlinked phone: each message normally draws a signup-link reply.
    for (let i = 0; i < 4; i++) {
      const status = await postWhatsAppText(app, phone, 'hi there');
      assertEquals(status, 200, 'webhook must 200 even when throttled (no retry amplification)');
    }
    // Only the first 2 messages got replies; the rest were silenced.
    const outbound = await adminSql(
      async (tx) =>
        await tx<{ count: string }[]>`
          select count(*)::text as count
          from whatsapp_messages m
          join whatsapp_chats c on c.id = m.chat_id
          where c.phone_e164 = ${'+' + phone} and m.direction = 'out'
        `,
    );
    assertEquals(outbound[0]!.count, '2');
    // All 4 inbound messages were still recorded (dedupe/audit unaffected).
    const inbound = await adminSql(
      async (tx) =>
        await tx<{ count: string }[]>`
          select count(*)::text as count
          from whatsapp_messages m
          join whatsapp_chats c on c.id = m.chat_id
          where c.phone_e164 = ${'+' + phone} and m.direction = 'in'
        `,
    );
    assertEquals(inbound[0]!.count, '4');
  } finally {
    restore();
    setWhatsAppSecret(undefined);
  }
});

dbTest('sec: no quota bypass via alternate open paths (portal → whatsapp → api)', async () => {
  await resetData();
  const app = await bootTestApp();
  setWhatsAppSecret(WA_SECRET);
  try {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    await adminSql(async (tx) => {
      await tx`
        insert into account_members (account_id, user_id, role, status)
        values (${owner.account_id}, ${member.user_id}, 'member', 'active')
      `;
    });
    const seeded = await seedLocationWithAccessPoint(owner.account_id, { withAccessPoint: true });
    const apId = seeded.access_point_id!;
    const phone = '27831110002';
    await linkVerifiedPhone(member.user_id, `+${phone}`);

    const patch = await app.request('PATCH', `/locations/${seeded.location_id}/limits`, {
      token: owner.access_token,
      json: { max_opens_per_member_per_day: 1 },
    });
    assertEquals(patch.status, 200);

    // 1 of 1: the member's single daily open, via the portal.
    assertEquals((await openAp(app, member, apId)).status, 200);
    assertEquals(await successfulOpens(apId), 1);

    // WhatsApp path: same member (linked phone), same central enforcement.
    // The webhook 200s but the gate does NOT open — the bot answers with the
    // honest daily-limit message instead.
    assertEquals(await postWhatsAppText(app, phone, 'open'), 200);
    assertEquals(await successfulOpens(apId), 1, 'whatsapp must not bypass the quota');
    const lastOut = await adminSql(
      async (tx) =>
        await tx<{ body: unknown }[]>`
          select m.body from whatsapp_messages m
          join whatsapp_chats c on c.id = m.chat_id
          where c.phone_e164 = ${'+' + phone} and m.direction = 'out'
          order by m.ts desc limit 1
        `,
    );
    const lastOutText = JSON.stringify(lastOut[0]?.body ?? '');
    assert(
      lastOutText.includes('Daily limit reached'),
      `bot should reply honestly about the quota, got: ${lastOutText}`,
    );

    // API path: same enforcement, expressed as 429 + reason code.
    const viaApi = await openAp(app, member, apId, 'api');
    assertEquals(viaApi.status, 429);
    assertEquals((viaApi.body as { error: string }).error, 'quota_exceeded');
    assertEquals(await successfulOpens(apId), 1, 'api must not bypass the quota');

    // The two denials are audited with the distinct reason code.
    const denied = await adminSql(
      async (tx) =>
        await tx<{ count: string }[]>`
          select count(*)::text as count from access_logs
          where access_point_id = ${apId} and success = false and error = 'quota_exceeded'
        `,
    );
    assertEquals(denied[0]!.count, '2');
  } finally {
    setWhatsAppSecret(undefined);
  }
});
