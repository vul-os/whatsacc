// Integration tests for the instance-admin (gateway operator) system:
// one-time claim bootstrap, overview/accounts/users surfaces, account
// suspension, user disable, last-admin protections, and runtime rate-limit
// overrides actually driving the limiter.

import { assert, assertEquals, assertExists, assertStringIncludes } from '../helpers/assert.ts';
import { resetEnvCache } from '@/lib/env.ts';
import { withRLS } from '@/lib/db.ts';
import { chatDenialMessage } from '@/lib/rate-limit.ts';
import { logAccess } from '@/routes/access.ts';
import { bootTestApp, type AppHandle } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import {
  makePlatformAdmin,
  registerUser,
  seedLocationWithAccessPoint,
  type RegisteredUser,
} from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';

/** Set/unset ADMIN_CLAIM_TOKEN for one test; returns a restore function. */
function setClaimToken(token: string | undefined): () => void {
  const prior = process.env.ADMIN_CLAIM_TOKEN;
  if (token === undefined) delete process.env.ADMIN_CLAIM_TOKEN;
  else process.env.ADMIN_CLAIM_TOKEN = token;
  resetEnvCache();
  return () => {
    if (prior === undefined) delete process.env.ADMIN_CLAIM_TOKEN;
    else process.env.ADMIN_CLAIM_TOKEN = prior;
    resetEnvCache();
  };
}

async function openAp(app: AppHandle, u: RegisteredUser, apId: string, source = 'web') {
  return await app.request('POST', `/access/access-points/${apId}/open`, {
    token: u.access_token,
    json: { source },
  });
}

async function adminAuditRows(action?: string) {
  return await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) =>
      await tx<{ action: string; allowed: boolean; actor_user_id: string | null; detail: unknown }[]>`
        select action, allowed, actor_user_id, detail from admin_audit_log
        where (${action ?? null}::text is null or action = ${action ?? null}::text)
        order by created_at asc
      `,
  );
}

// ---------------------------------------------------------------------------
// Claim flow
// ---------------------------------------------------------------------------

dbTest('claim: unset token → 403 for claim AND /admin/* stays fail-closed', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setClaimToken(undefined);
  try {
    const u = await registerUser(app);

    // No admin exists + no token: claiming is disabled...
    const claim = await app.request('POST', '/admin/claim', {
      token: u.access_token,
      json: { token: 'anything' },
    });
    assertEquals(claim.status, 403);
    assertEquals((claim.body as { error: string }).error, 'claim_disabled');

    // ...and every /admin route is 403 for everyone (fail-closed).
    const overview = await app.request('GET', '/admin/overview', { token: u.access_token });
    assertEquals(overview.status, 403);
    assertEquals((overview.body as { error: string }).error, 'not_platform_admin');

    // Claim status reflects the lock-out.
    const status = await app.request('GET', '/admin/claim', { token: u.access_token });
    assertEquals(status.status, 200);
    assertEquals(status.body, { claimed: false, claimable: false });
  } finally {
    restore();
  }
});

dbTest('claim: succeeds once, burns forever, wrong tokens rejected + audited', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setClaimToken('sekrit-claim-token');
  try {
    const u1 = await registerUser(app);
    const u2 = await registerUser(app);

    const statusBefore = await app.request('GET', '/admin/claim', { token: u1.access_token });
    assertEquals(statusBefore.body, { claimed: false, claimable: true });

    // Wrong token → 403 with a distinct code.
    const bad = await app.request('POST', '/admin/claim', {
      token: u1.access_token,
      json: { token: 'wrong-token' },
    });
    assertEquals(bad.status, 403);
    assertEquals((bad.body as { error: string }).error, 'invalid_claim_token');

    // Correct token → the claimant becomes platform admin, immediately —
    // the SAME access token now passes the admin gate (live DB flag).
    const ok = await app.request('POST', '/admin/claim', {
      token: u1.access_token,
      json: { token: 'sekrit-claim-token' },
    });
    assertEquals(ok.status, 200);
    assertEquals(ok.body, { ok: true, user_id: u1.user_id, is_platform_admin: true });
    const overview = await app.request('GET', '/admin/overview', { token: u1.access_token });
    assertEquals(overview.status, 200);

    // /auth/me exposes the flag.
    const me = await app.request('GET', '/auth/me', { token: u1.access_token });
    assertEquals((me.body as { user: { is_platform_admin: boolean } }).user.is_platform_admin, true);

    // Second claim — even with the CORRECT token — is dead forever.
    const again = await app.request('POST', '/admin/claim', {
      token: u2.access_token,
      json: { token: 'sekrit-claim-token' },
    });
    assertEquals(again.status, 403);
    assertEquals((again.body as { error: string }).error, 'claim_closed');
    const statusAfter = await app.request('GET', '/admin/claim', { token: u2.access_token });
    assertEquals(statusAfter.body, { claimed: true, claimable: false });

    // Audit trail: denied bad-token attempt, the successful claim, and the
    // denied post-claim attempt.
    const audit = await adminAuditRows('admin_claim');
    assertEquals(audit.length, 3);
    assertEquals(audit[0]!.allowed, false); // invalid_claim_token
    assertEquals(audit[1]!.allowed, true); // the claim
    assertEquals(audit[1]!.actor_user_id, u1.user_id);
    assertEquals(audit[2]!.allowed, false); // claim_closed
  } finally {
    restore();
  }
});

dbTest('claim: 403 when an admin already exists, even with the right token', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setClaimToken('sekrit-claim-token');
  try {
    const admin = await registerUser(app);
    await makePlatformAdmin(admin.user_id);
    const u = await registerUser(app);

    const res = await app.request('POST', '/admin/claim', {
      token: u.access_token,
      json: { token: 'sekrit-claim-token' },
    });
    assertEquals(res.status, 403);
    assertEquals((res.body as { error: string }).error, 'claim_closed');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Overview / accounts / users shapes
// ---------------------------------------------------------------------------

dbTest('overview: instance totals, opens, denials and recent signups', async () => {
  await resetData();
  const app = await bootTestApp();
  const admin = await registerUser(app);
  await makePlatformAdmin(admin.user_id);
  const tenant = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(tenant.account_id, { withAccessPoint: true });

  assertEquals((await openAp(app, tenant, seeded.access_point_id!)).status, 200);

  const res = await app.request('GET', '/admin/overview', { token: admin.access_token });
  assertEquals(res.status, 200);
  const body = res.body as {
    totals: { users: number; accounts: number; locations: number; devices: number; access_points: number };
    opens: { today: number; last_7d: number };
    denials_today: {
      total: number;
      rate_limited: number;
      quota_exceeded: number;
      account_suspended: number;
      other: number;
    };
    recent_signups: Array<{ id: string; email: string; status: string; created_at: string }>;
  };
  assertEquals(body.totals.users, 2);
  assertEquals(body.totals.accounts, 2);
  // registerUser creates 1 location each; the seeded location adds a third.
  assertEquals(body.totals.locations, 3);
  assertEquals(body.totals.access_points, 1);
  assertEquals(body.opens.today, 1);
  assertEquals(body.opens.last_7d, 1);
  assertEquals(body.denials_today.total, 0);
  assertEquals(body.recent_signups.length, 2);
  assertEquals(body.recent_signups[0]!.email, tenant.email); // newest first
});

dbTest('accounts: list/search with counts + detail with members/locations/logs', async () => {
  await resetData();
  const app = await bootTestApp();
  const admin = await registerUser(app);
  await makePlatformAdmin(admin.user_id);
  const tenant = await registerUser(app, { location_name: 'Sunset Villas' });
  const seeded = await seedLocationWithAccessPoint(tenant.account_id, { withAccessPoint: true });
  assertEquals((await openAp(app, tenant, seeded.access_point_id!)).status, 200);

  // List (all).
  const list = await app.request('GET', '/admin/accounts', { token: admin.access_token });
  assertEquals(list.status, 200);
  const listBody = list.body as {
    accounts: Array<{
      id: string;
      name: string;
      status: string;
      member_count: number;
      location_count: number;
      opens_7d: number;
      created_at: string;
    }>;
    total: number;
    limit: number;
    offset: number;
  };
  assertEquals(listBody.total, 2);
  const t = listBody.accounts.find((a) => a.id === tenant.account_id);
  assertExists(t);
  assertEquals(t!.status, 'active');
  assertEquals(t!.member_count, 1);
  assertEquals(t!.location_count, 2);
  assertEquals(t!.opens_7d, 1);

  // Search narrows.
  const search = await app.request('GET', '/admin/accounts', {
    token: admin.access_token,
    query: { query: 'Sunset' },
  });
  const searchBody = search.body as { accounts: Array<{ id: string }>; total: number };
  assertEquals(searchBody.total, 1);
  assertEquals(searchBody.accounts[0]!.id, tenant.account_id);

  // Detail.
  const detail = await app.request('GET', `/admin/accounts/${tenant.account_id}`, {
    token: admin.access_token,
  });
  assertEquals(detail.status, 200);
  const detailBody = detail.body as {
    account: { id: string; name: string; status: string };
    members: Array<{ user_id: string; email: string; role: string }>;
    locations: Array<{ id: string; name: string }>;
    recent_access_logs: Array<{ command: string; success: boolean; user_email: string | null }>;
  };
  assertEquals(detailBody.account.id, tenant.account_id);
  assertEquals(detailBody.members.length, 1);
  assertEquals(detailBody.members[0]!.email, tenant.email);
  assertEquals(detailBody.members[0]!.role, 'owner');
  assertEquals(detailBody.locations.length, 2);
  assertEquals(detailBody.recent_access_logs.length, 1);
  assertEquals(detailBody.recent_access_logs[0]!.success, true);

  // Unknown id → 404.
  const missing = await app.request('GET', `/admin/accounts/${crypto.randomUUID()}`, {
    token: admin.access_token,
  });
  assertEquals(missing.status, 404);
});

dbTest('users: list/search with accounts + last activity', async () => {
  await resetData();
  const app = await bootTestApp();
  const admin = await registerUser(app);
  await makePlatformAdmin(admin.user_id);
  const tenant = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(tenant.account_id, { withAccessPoint: true });
  assertEquals((await openAp(app, tenant, seeded.access_point_id!)).status, 200);

  const list = await app.request('GET', '/admin/users', { token: admin.access_token });
  assertEquals(list.status, 200);
  const listBody = list.body as {
    users: Array<{
      id: string;
      email: string;
      status: string;
      is_platform_admin: boolean;
      accounts: Array<{ account_id: string; name: string; role: string }>;
      last_access_at: string | null;
      created_at: string;
    }>;
    total: number;
  };
  assertEquals(listBody.total, 2);
  const a = listBody.users.find((u) => u.id === admin.user_id);
  const t = listBody.users.find((u) => u.id === tenant.user_id);
  assertExists(a);
  assertExists(t);
  assertEquals(a!.is_platform_admin, true);
  assertEquals(t!.is_platform_admin, false);
  assertEquals(t!.status, 'active');
  assertEquals(t!.accounts.length, 1);
  assertEquals(t!.accounts[0]!.role, 'owner');
  assertExists(t!.last_access_at); // opened a gate above
  assertEquals(a!.last_access_at, null);

  const search = await app.request('GET', '/admin/users', {
    token: admin.access_token,
    query: { query: tenant.email },
  });
  const searchBody = search.body as { users: Array<{ id: string }>; total: number };
  assertEquals(searchBody.total, 1);
  assertEquals(searchBody.users[0]!.id, tenant.user_id);
});

// ---------------------------------------------------------------------------
// Account suspension
// ---------------------------------------------------------------------------

dbTest('suspend: opens denied with account_suspended + honest chat verdict; unsuspend restores', async () => {
  await resetData();
  const app = await bootTestApp();
  const admin = await registerUser(app);
  await makePlatformAdmin(admin.user_id);
  const tenant = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(tenant.account_id, { withAccessPoint: true });
  const apId = seeded.access_point_id!;

  assertEquals((await openAp(app, tenant, apId)).status, 200);

  // Suspend.
  const patch = await app.request('PATCH', `/admin/accounts/${tenant.account_id}`, {
    token: admin.access_token,
    json: { status: 'suspended' },
  });
  assertEquals(patch.status, 200);
  assertEquals((patch.body as { account: { status: string } }).account.status, 'suspended');

  // Portal/API open → 403 with the distinct code.
  const denied = await openAp(app, tenant, apId);
  assertEquals(denied.status, 403);
  assertEquals((denied.body as { error: string }).error, 'account_suspended');

  // The denial is audit-logged with the distinct reason.
  const logs = await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) =>
      await tx<{ success: boolean; error: string | null }[]>`
        select success, error from access_logs
        where access_point_id = ${apId} and command = 'open'
        order by ts asc
      `,
  );
  assertEquals(logs.length, 2);
  assertEquals(logs[1]!.success, false);
  assertEquals(logs[1]!.error, 'account_suspended');

  // Chat channels get the same verdict from the central logAccess choke
  // point, and the reply copy is honest about the suspension.
  const verdict = await withRLS(
    { user_id: tenant.user_id, account_id: null, is_platform_admin: false },
    async (tx) =>
      await logAccess(tx, {
        user_id: tenant.user_id,
        access_point_id: apId,
        command: 'open',
        source: 'whatsapp',
      }),
  );
  assert(!verdict.allowed);
  if (!verdict.allowed) {
    assertEquals(verdict.reason, 'account_suspended');
    assertStringIncludes(chatDenialMessage(verdict).toLowerCase(), 'suspended');
  }

  // Close is still allowed (safe direction).
  const close = await app.request('POST', `/access/access-points/${apId}/close`, {
    token: tenant.access_token,
    json: { source: 'web' },
  });
  assertEquals(close.status, 200);

  // Login still works so members can see the state.
  const login = await app.request('POST', '/auth/login', {
    json: { email: tenant.email, password: tenant.password },
  });
  assertEquals(login.status, 200);
  const me = await app.request('GET', '/auth/me', { token: tenant.access_token });
  assertEquals(me.status, 200);
  const meAccounts = (me.body as { accounts: Array<{ account_id: string }> }).accounts;
  assertEquals(meAccounts.length, 1);

  // Unsuspend restores opens.
  const unsuspend = await app.request('PATCH', `/admin/accounts/${tenant.account_id}`, {
    token: admin.access_token,
    json: { status: 'active' },
  });
  assertEquals(unsuspend.status, 200);
  assertEquals((await openAp(app, tenant, apId)).status, 200);

  // Both admin actions are in the action audit.
  const actions = await adminAuditRows('account_status');
  assertEquals(actions.length, 2);
  assert(actions.every((r) => r.allowed && r.actor_user_id === admin.user_id));
});

// ---------------------------------------------------------------------------
// User disable
// ---------------------------------------------------------------------------

dbTest('disable: login 401, refresh rejected, existing token dead; re-enable restores', async () => {
  await resetData();
  const app = await bootTestApp();
  const admin = await registerUser(app);
  await makePlatformAdmin(admin.user_id);
  const victim = await registerUser(app);

  const patch = await app.request('PATCH', `/admin/users/${victim.user_id}`, {
    token: admin.access_token,
    json: { status: 'disabled' },
  });
  assertEquals(patch.status, 200);
  assertEquals((patch.body as { user: { status: string } }).user.status, 'disabled');

  // Login → 401 with a distinct code.
  const login = await app.request('POST', '/auth/login', {
    json: { email: victim.email, password: victim.password },
  });
  assertEquals(login.status, 401);
  assertEquals((login.body as { error: string }).error, 'user_disabled');

  // Refresh → rejected (families were revoked on disable).
  const refresh = await app.request('POST', '/auth/refresh', {
    json: { refresh_token: victim.refresh_token },
  });
  assertEquals(refresh.status, 401);

  // Existing access token → rejected by the live gate.
  const me = await app.request('GET', '/auth/me', { token: victim.access_token });
  assertEquals(me.status, 403);
  assertEquals((me.body as { error: string }).error, 'user_disabled');

  // Re-enable → login works again.
  const enable = await app.request('PATCH', `/admin/users/${victim.user_id}`, {
    token: admin.access_token,
    json: { status: 'active' },
  });
  assertEquals(enable.status, 200);
  const login2 = await app.request('POST', '/auth/login', {
    json: { email: victim.email, password: victim.password },
  });
  assertEquals(login2.status, 200);
});

dbTest('protections: cannot disable yourself; cannot disable/revoke the last admin', async () => {
  await resetData();
  const app = await bootTestApp();
  const admin = await registerUser(app);
  await makePlatformAdmin(admin.user_id);
  const other = await registerUser(app);

  // Cannot disable yourself.
  const self = await app.request('PATCH', `/admin/users/${admin.user_id}`, {
    token: admin.access_token,
    json: { status: 'disabled' },
  });
  assertEquals(self.status, 400);
  assertEquals((self.body as { error: string }).error, 'cannot_disable_self');

  // Cannot revoke the last platform admin (yourself included).
  const revokeSelf = await app.request('POST', `/admin/users/${admin.user_id}/platform-admin`, {
    token: admin.access_token,
    json: { grant: false },
  });
  assertEquals(revokeSelf.status, 400);
  assertEquals((revokeSelf.body as { error: string }).error, 'cannot_revoke_last_admin');

  // Grant a second admin — takes effect immediately for their existing token.
  const grant = await app.request('POST', `/admin/users/${other.user_id}/platform-admin`, {
    token: admin.access_token,
    json: { grant: true },
  });
  assertEquals(grant.status, 200);
  assertEquals((grant.body as { user: { is_platform_admin: boolean } }).user.is_platform_admin, true);
  assertEquals((await app.request('GET', '/admin/overview', { token: other.access_token })).status, 200);

  // With a second admin, revoking the first is fine...
  const revoke = await app.request('POST', `/admin/users/${admin.user_id}/platform-admin`, {
    token: other.access_token,
    json: { grant: false },
  });
  assertEquals(revoke.status, 200);
  // ...and the revoked admin loses /admin immediately (live flag).
  assertEquals((await app.request('GET', '/admin/overview', { token: admin.access_token })).status, 403);

  // 'other' is now the last admin again.
  const revokeLast = await app.request('POST', `/admin/users/${other.user_id}/platform-admin`, {
    token: other.access_token,
    json: { grant: false },
  });
  assertEquals(revokeLast.status, 400);
  assertEquals((revokeLast.body as { error: string }).error, 'cannot_revoke_last_admin');

  // cannot_disable_last_admin: a second admin whose status is not 'active'
  // (pending) may still call /admin — they must not be able to disable the
  // last ACTIVE admin.
  await makePlatformAdmin(admin.user_id);
  await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      await tx`update users set status = 'pending' where id = ${admin.user_id}`;
    },
  );
  const disableLast = await app.request('PATCH', `/admin/users/${other.user_id}`, {
    token: admin.access_token,
    json: { status: 'disabled' },
  });
  assertEquals(disableLast.status, 400);
  assertEquals((disableLast.body as { error: string }).error, 'cannot_disable_last_admin');
});

// ---------------------------------------------------------------------------
// Runtime rate-limit overrides
// ---------------------------------------------------------------------------

dbTest('limits: override persists and the limiter actually uses it (db > env)', async () => {
  await resetData();
  const app = await bootTestApp();
  const admin = await registerUser(app);
  await makePlatformAdmin(admin.user_id);
  const tenant = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(tenant.account_id, { withAccessPoint: true });
  const apId = seeded.access_point_id!;

  // Defaults: no overrides; effective mirrors env (harness neutralizes to
  // huge values so unrelated tests never trip limits).
  const before = await app.request('GET', '/admin/limits', { token: admin.access_token });
  assertEquals(before.status, 200);
  const beforeBody = before.body as {
    defaults: Record<string, number>;
    env: Record<string, number>;
    overrides: Record<string, number | null>;
    effective: Record<string, number>;
  };
  assertEquals(beforeBody.overrides, {
    open_cooldown_s: null,
    opens_per_hour: null,
    chat_msgs_per_min: null,
    account_opens_per_hour: null,
  });
  assertEquals(beforeBody.effective.opens_per_hour, beforeBody.env.opens_per_hour);
  assertEquals(beforeBody.defaults.opens_per_hour, 30);

  // Override opens/hour to 1. Env says 100000 — the db value must win.
  const patch = await app.request('PATCH', '/admin/limits', {
    token: admin.access_token,
    json: { opens_per_hour: 1 },
  });
  assertEquals(patch.status, 200);
  const patchBody = patch.body as {
    overrides: Record<string, number | null>;
    effective: Record<string, number>;
  };
  assertEquals(patchBody.overrides.opens_per_hour, 1);
  assertEquals(patchBody.effective.opens_per_hour, 1);

  // First open passes, second trips the persisted override.
  assertEquals((await openAp(app, tenant, apId)).status, 200);
  const second = await openAp(app, tenant, apId);
  assertEquals(second.status, 429);
  assertEquals((second.body as { error: string }).error, 'rate_limited');

  // The override persists (fresh GET reads it back from the DB).
  const after = await app.request('GET', '/admin/limits', { token: admin.access_token });
  assertEquals((after.body as { overrides: { opens_per_hour: number } }).overrides.opens_per_hour, 1);

  // Clearing with null restores the env value.
  const clear = await app.request('PATCH', '/admin/limits', {
    token: admin.access_token,
    json: { opens_per_hour: null },
  });
  assertEquals(clear.status, 200);
  const clearBody = clear.body as {
    overrides: Record<string, number | null>;
    effective: Record<string, number>;
    env: Record<string, number>;
  };
  assertEquals(clearBody.overrides.opens_per_hour, null);
  assertEquals(clearBody.effective.opens_per_hour, clearBody.env.opens_per_hour);
  assertEquals((await openAp(app, tenant, apId)).status, 200);

  // Validation: bad values rejected.
  const bad = await app.request('PATCH', '/admin/limits', {
    token: admin.access_token,
    json: { opens_per_hour: -1 },
  });
  assertEquals(bad.status, 400);
  const empty = await app.request('PATCH', '/admin/limits', {
    token: admin.access_token,
    json: {},
  });
  assertEquals(empty.status, 400);

  // The updates are audited.
  const actions = await adminAuditRows('limits_update');
  assertEquals(actions.length, 2);
});

// ---------------------------------------------------------------------------
// Audit surfaces
// ---------------------------------------------------------------------------

dbTest('audit: cross-account entries with kind filters + admin action trail', async () => {
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

  // Suspend t2 and produce a denial.
  await app.request('PATCH', `/admin/accounts/${t2.account_id}`, {
    token: admin.access_token,
    json: { status: 'suspended' },
  });
  assertEquals((await openAp(app, t2, s2.access_point_id!)).status, 403);

  // Admin sees BOTH accounts' entries.
  const all = await app.request('GET', '/admin/audit', { token: admin.access_token });
  assertEquals(all.status, 200);
  const allBody = all.body as {
    entries: Array<{
      account_id: string | null;
      account_name: string | null;
      success: boolean;
      error: string | null;
      user_email: string | null;
    }>;
    total: number;
  };
  assertEquals(allBody.total, 3);
  const accountIds = new Set(allBody.entries.map((e) => e.account_id));
  assert(accountIds.has(t1.account_id) && accountIds.has(t2.account_id));
  assertExists(allBody.entries.find((e) => e.user_email === t1.email));

  // kind=denied narrows to the suspension denial.
  const denied = await app.request('GET', '/admin/audit', {
    token: admin.access_token,
    query: { kind: 'denied' },
  });
  const deniedBody = denied.body as { entries: Array<{ error: string | null }>; total: number };
  assertEquals(deniedBody.total, 1);
  assertEquals(deniedBody.entries[0]!.error, 'account_suspended');

  // kind=account_suspended matches the same row; kind=rate_limited none.
  const byReason = await app.request('GET', '/admin/audit', {
    token: admin.access_token,
    query: { kind: 'account_suspended' },
  });
  assertEquals((byReason.body as { total: number }).total, 1);
  const rl = await app.request('GET', '/admin/audit', {
    token: admin.access_token,
    query: { kind: 'rate_limited' },
  });
  assertEquals((rl.body as { total: number }).total, 0);

  // Pagination.
  const page = await app.request('GET', '/admin/audit', {
    token: admin.access_token,
    query: { limit: 1, offset: 1 },
  });
  const pageBody = page.body as { entries: unknown[]; total: number; limit: number; offset: number };
  assertEquals(pageBody.entries.length, 1);
  assertEquals(pageBody.total, 3);

  // Admin action trail includes the suspension.
  const actions = await app.request('GET', '/admin/audit/actions', { token: admin.access_token });
  assertEquals(actions.status, 200);
  const actionsBody = actions.body as {
    actions: Array<{ action: string; allowed: boolean; actor_email: string | null }>;
    total: number;
  };
  const suspension = actionsBody.actions.find((a) => a.action === 'account_status');
  assertExists(suspension);
  assertEquals(suspension!.allowed, true);
  assertEquals(suspension!.actor_email, admin.email);
});
