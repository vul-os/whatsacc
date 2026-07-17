// Adversarial tests for the instance-admin system: every /admin surface is
// fail-closed for non-admins (with denial audit rows), account-level roles
// cannot escalate, tenant RLS stays intact around the new helpers, disabled
// users are dead on arrival, and suspended accounts cannot open via any
// channel.

import { assert, assertEquals } from '../helpers/assert.ts';
import { resetEnvCache } from '@/lib/env.ts';
import { withRLS } from '@/lib/db.ts';
import { bootTestApp, type AppHandle } from '../helpers/app.ts';
import { resetData, setupTestDb } from '../helpers/db.ts';
import {
  makePlatformAdmin,
  registerUser,
  seedLocationWithAccessPoint,
  type RegisteredUser,
} from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';

async function openAp(app: AppHandle, u: RegisteredUser, apId: string, source = 'web') {
  return await app.request('POST', `/access/access-points/${apId}/open`, {
    token: u.access_token,
    json: { source },
  });
}

const FAKE_ID = '00000000-0000-4000-8000-000000000000';

/** Every admin-gated endpoint (method, path, body). */
function adminSurface(): Array<{
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  json?: unknown;
}> {
  return [
    { method: 'GET', path: '/admin/overview' },
    { method: 'GET', path: '/admin/accounts' },
    { method: 'GET', path: `/admin/accounts/${FAKE_ID}` },
    { method: 'PATCH', path: `/admin/accounts/${FAKE_ID}`, json: { status: 'suspended' } },
    { method: 'GET', path: '/admin/users' },
    { method: 'PATCH', path: `/admin/users/${FAKE_ID}`, json: { status: 'disabled' } },
    { method: 'POST', path: `/admin/users/${FAKE_ID}/platform-admin`, json: { grant: true } },
    { method: 'GET', path: '/admin/limits' },
    { method: 'PATCH', path: '/admin/limits', json: { opens_per_hour: 1 } },
    { method: 'GET', path: '/admin/audit' },
    { method: 'GET', path: '/admin/audit/actions' },
  ];
}

dbTest('security: every /admin route is 403 for non-admins + denial audit rows', async () => {
  await resetData();
  const app = await bootTestApp();
  const owner = await registerUser(app); // account OWNER — still not platform admin

  const surface = adminSurface();
  for (const ep of surface) {
    const res = await app.request(ep.method, ep.path, {
      token: owner.access_token,
      ...(ep.json !== undefined ? { json: ep.json } : {}),
    });
    assertEquals(res.status, 403, `${ep.method} ${ep.path} must be 403 for non-admin`);
    assertEquals(
      (res.body as { error: string }).error,
      'not_platform_admin',
      `${ep.method} ${ep.path} error code`,
    );
  }

  // Unauthenticated → 401 everywhere (never a different failure mode).
  for (const ep of surface) {
    const res = await app.request(ep.method, ep.path, {
      ...(ep.json !== undefined ? { json: ep.json } : {}),
    });
    assertEquals(res.status, 401, `${ep.method} ${ep.path} must be 401 unauthenticated`);
  }

  // One denial audit row per authenticated denied attempt. (Raw superuser
  // read: admin_audit_log is admin-only under RLS and the forged-GUC "fake
  // admin" context no longer unlocks it — by design.)
  const { sql } = await setupTestDb();
  const denials = await sql<{ actor_user_id: string | null; target_id: string | null }[]>`
    select actor_user_id, target_id from admin_audit_log
    where action = 'admin_access_denied' and allowed = false
  `;
  assertEquals(denials.length, surface.length);
  assert(denials.every((d) => d.actor_user_id === owner.user_id));
});

dbTest('security: account roles (owner/admin/member) cannot escalate to platform admin', async () => {
  await resetData();
  const app = await bootTestApp();
  const owner = await registerUser(app);
  const acctAdmin = await registerUser(app);
  const member = await registerUser(app);
  await withRLS({ user_id: '', account_id: null, is_platform_admin: true }, async (tx) => {
    await tx`
      insert into account_members (account_id, user_id, role, status)
      values (${owner.account_id}, ${acctAdmin.user_id}, 'admin', 'active'),
             (${owner.account_id}, ${member.user_id}, 'member', 'active')
      on conflict (account_id, user_id) do update set role = excluded.role
    `;
  });

  for (const u of [owner, acctAdmin, member]) {
    // Direct self-grant via the admin API → 403.
    const grant = await app.request('POST', `/admin/users/${u.user_id}/platform-admin`, {
      token: u.access_token,
      json: { grant: true },
    });
    assertEquals(grant.status, 403);

    // Rate-limit override attempt → 403.
    const limits = await app.request('PATCH', '/admin/limits', {
      token: u.access_token,
      json: { opens_per_hour: 0 },
    });
    assertEquals(limits.status, 403);
  }

  // The SQL seam is fail-closed too: instance_setting_set raises without the
  // platform-admin RLS context, and claim_platform_admin returns false for
  // users once the instance has an admin... but here no admin exists yet, so
  // verify the token gate instead: with NO ADMIN_CLAIM_TOKEN, HTTP claiming
  // is impossible for all of them.
  delete process.env.ADMIN_CLAIM_TOKEN;
  resetEnvCache();
  for (const u of [owner, acctAdmin, member]) {
    const res = await app.request('POST', '/admin/claim', {
      token: u.access_token,
      json: { token: 'guess' },
    });
    assertEquals(res.status, 403);
  }

  // instance_setting_set under a non-admin RLS context must raise.
  let raised = false;
  try {
    await withRLS(
      { user_id: member.user_id, account_id: null, is_platform_admin: false },
      async (tx) => {
        await tx`select app.instance_setting_set('rate_limits', '{"opens_per_hour":0}'::jsonb, ${member.user_id}::uuid)`;
      },
    );
  } catch {
    raised = true;
  }
  assert(raised, 'instance_setting_set must fail without platform-admin context');

  // Nobody became an admin.
  const admins = await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => await tx<{ n: number }[]>`select count(*)::int as n from users where is_platform_admin`,
  );
  assertEquals(Number(admins[0]!.n), 0);
});

dbTest('security: internal tables are invisible to tenant contexts (RLS probe)', async () => {
  await resetData();
  const app = await bootTestApp();
  const admin = await registerUser(app);
  await makePlatformAdmin(admin.user_id);
  const tenant = await registerUser(app);

  // Seed one setting + one audit row.
  await withRLS(
    { user_id: admin.user_id, account_id: null, is_platform_admin: true },
    async (tx) => {
      await tx`select app.instance_setting_set('rate_limits', '{"opens_per_hour":9}'::jsonb, ${admin.user_id}::uuid)`;
      await tx`select app.admin_audit_write(${admin.user_id}::uuid, 'limits_update', 'instance', 'rate_limits', true, '{}'::jsonb)`;
    },
  );

  // Tenant context: direct selects come back EMPTY (no policies / admin-only
  // policy), even though the rows exist.
  await withRLS(
    { user_id: tenant.user_id, account_id: null, is_platform_admin: false },
    async (tx) => {
      const settings = await tx<unknown[]>`select * from instance_settings`;
      assertEquals(settings.length, 0);
      const audit = await tx<unknown[]>`select * from admin_audit_log`;
      assertEquals(audit.length, 0);
      // Direct INSERT into the audit log is impossible for tenants.
      let raised = false;
      try {
        await tx.savepoint(async (stx) => {
          await stx`
            insert into admin_audit_log (actor_user_id, action, allowed)
            values (${tenant.user_id}, 'forged', true)
          `;
        });
      } catch {
        raised = true;
      }
      assert(raised, 'tenant INSERT into admin_audit_log must be denied');
    },
  );

  // Admin context sees them.
  await withRLS(
    { user_id: admin.user_id, account_id: null, is_platform_admin: true },
    async (tx) => {
      const audit = await tx<unknown[]>`select * from admin_audit_log`;
      assertEquals(audit.length, 1);
    },
  );
});

dbTest('security: admin sees cross-tenant, normal users stay tenant-scoped', async () => {
  await resetData();
  const app = await bootTestApp();
  const admin = await registerUser(app);
  await makePlatformAdmin(admin.user_id);
  const t1 = await registerUser(app);
  const t2 = await registerUser(app);
  const s1 = await seedLocationWithAccessPoint(t1.account_id, { withAccessPoint: true });
  const s2 = await seedLocationWithAccessPoint(t2.account_id, { withAccessPoint: true });
  assertEquals((await openAp(app, t1, s1.access_point_id!)).status, 200);
  assertEquals((await openAp(app, t2, s2.access_point_id!)).status, 200);

  // Admin: cross-account view via the admin surface.
  const audit = await app.request('GET', '/admin/audit', { token: admin.access_token });
  const auditBody = audit.body as { entries: Array<{ account_id: string | null }>; total: number };
  assertEquals(auditBody.total, 2);
  const seen = new Set(auditBody.entries.map((e) => e.account_id));
  assert(seen.has(t1.account_id) && seen.has(t2.account_id));

  // Normal user t1: the same underlying table stays tenant-scoped under
  // their RLS context — t2's rows are invisible.
  await withRLS(
    { user_id: t1.user_id, account_id: null, is_platform_admin: false },
    async (tx) => {
      const mine = await tx<{ account_id: string }[]>`
        select account_id from access_logs
      `;
      assert(mine.length >= 1);
      assert(
        mine.every((r) => r.account_id === t1.account_id),
        'tenant must only see own access_logs',
      );
      // Probing t2's account row directly is empty too.
      const other = await tx<unknown[]>`select id from accounts where id = ${t2.account_id}`;
      assertEquals(other.length, 0);
    },
  );

  // And t1 cannot use the tenant-facing analytics API on t2's account.
  const probe = await app.request('GET', `/analytics/accounts/${t2.account_id}/summary`, {
    token: t1.access_token,
  });
  assertEquals(probe.status, 404);
});

dbTest('security: disabled user cannot use an existing access token anywhere', async () => {
  await resetData();
  const app = await bootTestApp();
  const admin = await registerUser(app);
  await makePlatformAdmin(admin.user_id);
  const victim = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(victim.account_id, { withAccessPoint: true });

  // Works before...
  assertEquals((await openAp(app, victim, seeded.access_point_id!)).status, 200);

  await app.request('PATCH', `/admin/users/${victim.user_id}`, {
    token: admin.access_token,
    json: { status: 'disabled' },
  });

  // ...the very same (still unexpired) token is now dead on every surface.
  assertEquals((await app.request('GET', '/auth/me', { token: victim.access_token })).status, 403);
  assertEquals((await openAp(app, victim, seeded.access_point_id!)).status, 403);
  assertEquals(
    (await app.request('GET', '/access/access-points', { token: victim.access_token })).status,
    403,
  );
  const refresh = await app.request('POST', '/auth/refresh', {
    json: { refresh_token: victim.refresh_token },
  });
  assertEquals(refresh.status, 401);
});

dbTest('security: suspended account is denied opens on every channel, incl. API tokens', async () => {
  await resetData();
  const app = await bootTestApp();
  const admin = await registerUser(app);
  await makePlatformAdmin(admin.user_id);
  const tenant = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(tenant.account_id, { withAccessPoint: true });
  const apId = seeded.access_point_id!;

  await app.request('PATCH', `/admin/accounts/${tenant.account_id}`, {
    token: admin.access_token,
    json: { status: 'suspended' },
  });

  // Web portal, API-sourced bearer call, and WhatsApp-style path all denied
  // at the single logAccess choke point.
  for (const source of ['web', 'api', 'whatsapp'] as const) {
    const res = await openAp(app, tenant, apId, source);
    assertEquals(res.status, 403, `open via source=${source} must be denied`);
    assertEquals((res.body as { error: string }).error, 'account_suspended');
  }

  // Every denial is audited with the distinct reason.
  const logs = await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) =>
      await tx<{ error: string | null }[]>`
        select error from access_logs
        where access_point_id = ${apId} and success = false
      `,
  );
  assertEquals(logs.length, 3);
  assert(logs.every((l) => l.error === 'account_suspended'));

  // Login is still allowed so members can see the state.
  const login = await app.request('POST', '/auth/login', {
    json: { email: tenant.email, password: tenant.password },
  });
  assertEquals(login.status, 200);
});
