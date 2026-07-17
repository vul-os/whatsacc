// Adversarial tests for the 2026-07-17 admin-hardening review:
//
//   1. Disabled users must lose CHAT access too (WhatsApp/Slack resolve
//      members by phone / Slack ID, without a JWT): opens denied + audited
//      at the logAccess choke point, menus stop, visitor grants (no user)
//      unaffected, re-enable restores.
//   2. The caller-settable GUC app.is_platform_admin is no longer trusted:
//      app.is_platform_admin() derives from the users table, so forging the
//      GUC under a tenant identity unlocks nothing.

import { assert, assertEquals, assertStringIncludes } from '../helpers/assert.ts';
import { resetEnvCache } from '@/lib/env.ts';
import { withRLS } from '@/lib/db.ts';
import { chatDenialMessage } from '@/lib/rate-limit.ts';
import { logAccess } from '@/routes/access.ts';
import { bootTestApp, type AppHandle } from '../helpers/app.ts';
import { resetData, setupTestDb } from '../helpers/db.ts';
import {
  makePlatformAdmin,
  registerUser,
  seedLocationWithAccessPoint,
} from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';

const WA_SECRET = 'test-wa-secret';

function setWhatsAppSecret(value: string | undefined): void {
  if (value === undefined) delete process.env.WHATSAPP_APP_SECRET;
  else process.env.WHATSAPP_APP_SECRET = value;
  resetEnvCache();
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

let waMsgSeq = 0;

/** POST a signed WhatsApp text-message webhook from `fromNoPlus`. */
async function postWhatsAppText(app: AppHandle, fromNoPlus: string, text: string): Promise<number> {
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
                  id: `wamid.hardening-${Date.now()}-${waMsgSeq}`,
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

async function successfulOpens(apId: string): Promise<number> {
  const { sql } = await setupTestDb();
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count from access_logs
    where access_point_id = ${apId} and command = 'open' and success = true
  `;
  return Number(rows[0]!.count);
}

dbTest('sec: disabled user cannot open via WhatsApp — denied, audited, menus stop; visitor + re-enable fine', async () => {
  await resetData();
  const app = await bootTestApp();
  const { sql } = await setupTestDb();
  setWhatsAppSecret(WA_SECRET);
  try {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    await sql`
      insert into account_members (account_id, user_id, role, status)
      values (${owner.account_id}, ${member.user_id}, 'member', 'active')
    `;
    const seeded = await seedLocationWithAccessPoint(owner.account_id, { withAccessPoint: true });
    const apId = seeded.access_point_id!;
    const memberPhone = '27831230001';
    await sql`
      insert into profile_phone_numbers (profile_id, phone_e164, verified_at, is_primary)
      values (${member.user_id}, ${'+' + memberPhone}, now(), true)
    `;

    // Baseline: the linked member opens via WhatsApp.
    assertEquals(await postWhatsAppText(app, memberPhone, 'open'), 200);
    assertEquals(await successfulOpens(apId), 1, 'member open should work before disable');

    // Operator disables the member.
    await sql`update users set status = 'disabled' where id = ${member.user_id}`;

    // WhatsApp open: webhook still 200s (no retry amplification) but the
    // gate does NOT open.
    assertEquals(await postWhatsAppText(app, memberPhone, 'open'), 200);
    assertEquals(await successfulOpens(apId), 1, 'disabled member must not open via chat');

    // Menus stop: the bot no longer offers gate buttons to the disabled user.
    assertEquals(await postWhatsAppText(app, memberPhone, 'menu'), 200);
    const outbound = await sql<{ body: unknown }[]>`
      select m.body from whatsapp_messages m
      join whatsapp_chats c on c.id = m.chat_id
      where c.phone_e164 = ${'+' + memberPhone} and m.direction = 'out'
      order by m.ts desc limit 2
    `;
    for (const row of outbound) {
      const text = JSON.stringify(row.body ?? '');
      assert(!text.includes('open_ap:'), `disabled user must not receive gate menus, got: ${text}`);
    }

    // Choke point (defense-in-depth): a direct logAccess with the disabled
    // user's id is denied with the distinct audited reason, and the chat
    // denial copy is honest.
    const verdict = await withRLS(null, async (tx) =>
      await logAccess(tx, {
        user_id: member.user_id,
        access_point_id: apId,
        command: 'open',
        source: 'whatsapp',
        phone_e164: `+${memberPhone}`,
      }),
    );
    assert(!verdict.allowed, 'logAccess must deny a disabled user');
    if (!verdict.allowed) {
      assertEquals(verdict.reason, 'user_disabled');
      assertStringIncludes(chatDenialMessage(verdict).toLowerCase(), 'disabled');
    }
    const audited = await sql<{ count: string }[]>`
      select count(*)::text as count from access_logs
      where access_point_id = ${apId} and success = false and error = 'user_disabled'
    `;
    assertEquals(Number(audited[0]!.count), 1, 'the denial must be audited as user_disabled');

    // Visitor grants carry no user_id — they keep working.
    const visitorPhone = '27835550002';
    const grant = await app.request('POST', '/access/grants', {
      token: owner.access_token,
      json: {
        phone_e164: `+${visitorPhone}`,
        ends_at: new Date(Date.now() + 3600_000).toISOString(),
        access_point_ids: [apId],
      },
    });
    assertEquals(grant.status, 201);
    assertEquals(await postWhatsAppText(app, visitorPhone, 'open'), 200);
    assertEquals(await successfulOpens(apId), 2, 'visitor grant must be unaffected');

    // Re-enable restores the member's chat access.
    await sql`update users set status = 'active' where id = ${member.user_id}`;
    assertEquals(await postWhatsAppText(app, memberPhone, 'open'), 200);
    assertEquals(await successfulOpens(apId), 3, 're-enabled member opens again');
  } finally {
    setWhatsAppSecret(undefined);
  }
});

dbTest('sec: forged app.is_platform_admin GUC unlocks nothing (table-derived admin)', async () => {
  await resetData();
  const app = await bootTestApp();
  const { sql } = await setupTestDb();
  const a = await registerUser(app);
  const b = await registerUser(app);

  // Seed one admin-audit row so "invisible" is provable.
  await sql`
    insert into admin_audit_log (actor_user_id, action, allowed)
    values (${a.user_id}, 'seed_for_test', true)
  `;

  // Tenant A's session forges the GUC (empirically settable by the request
  // role) and then probes. Every probe must stay tenant-scoped.
  await withRLS(
    { user_id: a.user_id, account_id: a.account_id, is_platform_admin: false },
    async (tx) => {
      await tx`select set_config('app.is_platform_admin', 'true', true)`;

      // Cross-tenant read: B's account must stay invisible.
      const other = await tx<unknown[]>`select id from accounts where id = ${b.account_id}`;
      assertEquals(other.length, 0, 'forged GUC must not unlock cross-tenant reads');

      // Admin-only audit log must stay invisible.
      const audit = await tx<unknown[]>`select * from admin_audit_log`;
      assertEquals(audit.length, 0, 'forged GUC must not unlock admin_audit_log');

      // instance_setting_set must raise.
      let raised = false;
      try {
        await tx.savepoint(async (stx) => {
          await stx`select app.instance_setting_set('rate_limits', '{"opens_per_hour":1}'::jsonb, ${a.user_id}::uuid)`;
        });
      } catch {
        raised = true;
      }
      assert(raised, 'forged GUC must not unlock instance_setting_set');
    },
  );

  // The legit admin path still works: a REAL platform admin (users row) gets
  // cross-tenant RLS and the settings seam under the same machinery.
  await makePlatformAdmin(a.user_id);
  await withRLS(
    { user_id: a.user_id, account_id: null, is_platform_admin: true },
    async (tx) => {
      const other = await tx<unknown[]>`select id from accounts where id = ${b.account_id}`;
      assertEquals(other.length, 1, 'real admin must see cross-tenant');
      const audit = await tx<unknown[]>`select * from admin_audit_log`;
      assert(audit.length >= 1, 'real admin must read admin_audit_log');
      await tx`select app.instance_setting_set('rate_limits', '{}'::jsonb, ${a.user_id}::uuid)`;
    },
  );
});
