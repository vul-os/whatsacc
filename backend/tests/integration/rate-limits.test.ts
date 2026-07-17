// Integration tests for the abuse-protection rate limits + admin quotas.
//
// Rate limits are env-tunable; the test harness neutralizes them by default
// (tests/helpers/app.ts), so each test here sets explicit values via
// setRate() and restores them afterwards.

import { assert, assertEquals, assertExists } from '../helpers/assert.ts';
import { resetEnvCache } from '@/lib/env.ts';
import { withRLS } from '@/lib/db.ts';
import { bootTestApp, type AppHandle } from '../helpers/app.ts';
import { resetData, setupTestDb } from '../helpers/db.ts';
import { registerUser, seedLocationWithAccessPoint, type RegisteredUser } from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';

const RATE_KEYS = [
  'RATE_OPEN_COOLDOWN_S',
  'RATE_OPENS_PER_HOUR',
  'RATE_CHAT_MSGS_PER_MIN',
  'RATE_ACCOUNT_OPENS_PER_HOUR',
] as const;

/** Set rate-limit env for one test; returns a restore function. */
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

async function addMember(accountId: string, userId: string, role: 'member' | 'admin' = 'member') {
  await withRLS({ user_id: '', account_id: null, is_platform_admin: true }, async (tx) => {
    await tx`
      insert into account_members (account_id, user_id, role, status)
      values (${accountId}, ${userId}, ${role}, 'active')
      on conflict (account_id, user_id) do update set role = excluded.role, status = 'active'
    `;
  });
}

async function openAp(app: AppHandle, u: RegisteredUser, apId: string, source = 'web') {
  return await app.request('POST', `/access/access-points/${apId}/open`, {
    token: u.access_token,
    json: { source },
  });
}

async function accessLogRows(apId: string) {
  return await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) =>
      await tx<{ success: boolean; error: string | null; user_id: string | null }[]>`
        select success, error, user_id from access_logs
        where access_point_id = ${apId} and command = 'open'
        order by ts asc
      `,
  );
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

dbTest('rate: second open within the cooldown is denied 429 + Retry-After and audited', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setRate({ RATE_OPEN_COOLDOWN_S: '10' });
  try {
    const u = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const apId = seeded.access_point_id!;

    const first = await openAp(app, u, apId);
    assertEquals(first.status, 200);

    const second = await openAp(app, u, apId);
    assertEquals(second.status, 429);
    const body = second.body as { error: string; retry_after_s: number };
    assertEquals(body.error, 'rate_limited');
    const retryAfter = Number(second.headers.get('Retry-After'));
    assert(retryAfter >= 1 && retryAfter <= 10, `Retry-After should be 1..10s, got ${retryAfter}`);
    assertEquals(body.retry_after_s, retryAfter);

    // The denial is audit-logged with the distinct reason code.
    const logs = await accessLogRows(apId);
    assertEquals(logs.length, 2);
    assertEquals(logs[0]!.success, true);
    assertEquals(logs[1]!.success, false);
    assertEquals(logs[1]!.error, 'rate_limited');
  } finally {
    restore();
  }
});

dbTest('rate: hourly per-member cap trips exactly at the boundary', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setRate({ RATE_OPEN_COOLDOWN_S: '0', RATE_OPENS_PER_HOUR: '3' });
  try {
    const u = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const apId = seeded.access_point_id!;

    for (let i = 0; i < 3; i++) {
      const r = await openAp(app, u, apId);
      assertEquals(r.status, 200, `open ${i + 1} of 3 should pass`);
    }
    const fourth = await openAp(app, u, apId);
    assertEquals(fourth.status, 429);
    assertEquals((fourth.body as { error: string }).error, 'rate_limited');
    const retryAfter = Number(fourth.headers.get('Retry-After'));
    assert(retryAfter >= 1 && retryAfter <= 3600, `Retry-After within the hour, got ${retryAfter}`);
  } finally {
    restore();
  }
});

dbTest('rate: per-account hourly ceiling caps runaway integrations across members', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setRate({ RATE_OPEN_COOLDOWN_S: '0', RATE_ACCOUNT_OPENS_PER_HOUR: '2' });
  try {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await addMember(a.account_id, b.user_id, 'member');
    const seeded = await seedLocationWithAccessPoint(a.account_id, { withAccessPoint: true });
    const apId = seeded.access_point_id!;

    assertEquals((await openAp(app, a, apId, 'api')).status, 200);
    assertEquals((await openAp(app, b, apId, 'api')).status, 200);
    // Third open on the same ACCOUNT (any member) trips the ceiling.
    const third = await openAp(app, b, apId, 'api');
    assertEquals(third.status, 429);
    assertEquals((third.body as { error: string }).error, 'rate_limited');
  } finally {
    restore();
  }
});

dbTest('rate: counter-store failure fails OPEN with a rate_limit_check_failed audit tag', async () => {
  await resetData();
  const app = await bootTestApp();
  const { sql } = await setupTestDb();
  const restore = setRate({ RATE_OPEN_COOLDOWN_S: '10', RATE_OPENS_PER_HOUR: '1' });
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
  const apId = seeded.access_point_id!;

  await sql.unsafe('ALTER TABLE rate_limit_counters RENAME TO rate_limit_counters_broken');
  try {
    // Even with a 1/h cap configured, both opens succeed: the counter store
    // is down and a gate is physical access — availability wins.
    assertEquals((await openAp(app, u, apId)).status, 200);
    assertEquals((await openAp(app, u, apId)).status, 200);

    // ...but visibility is preserved: the success rows carry the audit tag.
    const logs = await accessLogRows(apId);
    assertEquals(logs.length, 2);
    for (const row of logs) {
      assertEquals(row.success, true);
      assertEquals(row.error, 'rate_limit_check_failed');
    }
  } finally {
    await sql.unsafe('ALTER TABLE rate_limit_counters_broken RENAME TO rate_limit_counters');
    restore();
  }
});

dbTest('rate: 10 concurrent opens against cap=1 admit exactly one (atomic consume)', async () => {
  await resetData();
  const app = await bootTestApp();
  const { sql } = await setupTestDb();
  const restore = setRate({ RATE_OPEN_COOLDOWN_S: '0', RATE_OPENS_PER_HOUR: '1' });
  try {
    const u = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const apId = seeded.access_point_id!;

    // Old check-then-increment would let several concurrent requests all
    // pass at count < cap. The atomic increment-if-under-cap admits EXACTLY
    // one, no matter the concurrency.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => openAp(app, u, apId)),
    );
    const okCount = results.filter((r) => r.status === 200).length;
    const deniedCount = results.filter((r) => r.status === 429).length;
    assertEquals(okCount, 1, 'exactly one concurrent open may pass a cap of 1');
    assertEquals(deniedCount, 9);

    // Counters equal successful opens: denials handed their consume back.
    const counter = await sql<{ count: number }[]>`
      select count from rate_limit_counters
      where scope = 'opens_1h' and subject = ${'user:' + u.user_id}
    `;
    assertEquals(Number(counter[0]!.count), 1);

    // Audit trail: 1 success + 9 distinct denials.
    const logs = await accessLogRows(apId);
    assertEquals(logs.filter((l) => l.success).length, 1);
    assertEquals(logs.filter((l) => !l.success && l.error === 'rate_limited').length, 9);
  } finally {
    restore();
  }
});

dbTest('rate: concurrent opens cannot all pass the cooldown (atomic sentinel claim)', async () => {
  await resetData();
  const app = await bootTestApp();
  const { sql } = await setupTestDb();
  const restore = setRate({ RATE_OPEN_COOLDOWN_S: '30' });
  try {
    const u = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const apId = seeded.access_point_id!;

    // All start before any sentinel exists, so the read-only fast-path lets
    // everyone through — only the atomic UPDATE ... WHERE updated_at <=
    // now() - cooldown claim decides, and exactly one can win it.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => openAp(app, u, apId)),
    );
    assertEquals(results.filter((r) => r.status === 200).length, 1);
    assertEquals(results.filter((r) => r.status === 429).length, 9);

    // Denied attempts handed back their hourly consume.
    const counter = await sql<{ count: number }[]>`
      select count from rate_limit_counters
      where scope = 'opens_1h' and subject = ${'user:' + u.user_id}
    `;
    assertEquals(Number(counter[0]!.count), 1);
  } finally {
    restore();
  }
});

dbTest('rate: stale cooldown sentinels get pruned, fresh ones survive', async () => {
  await resetData();
  await bootTestApp();
  const { sql } = await setupTestDb();

  // Seed one stale sentinel (no successful open for 2 days — it can no
  // longer influence any cooldown decision) and one fresh sentinel.
  await sql`
    insert into rate_limit_counters (scope, subject, window_start, count, updated_at)
    values
      ('open_cd', 'user:stale|ap:a', to_timestamp(0), 3, now() - interval '2 days'),
      ('open_cd', 'user:fresh|ap:b', to_timestamp(0), 3, now())
  `;

  // A claim for a brand-new subject (insert path) triggers the opportunistic
  // sentinel prune. Run it through the request role like production does.
  const claimed = await withRLS(null, async (tx) => {
    const rows = await tx<{ ok: boolean }[]>`
      select app.rate_limit_claim_cooldown('user:new|ap:c', 10) as ok
    `;
    return rows[0]!.ok;
  });
  assertEquals(claimed, true);

  const remaining = await sql<{ subject: string }[]>`
    select subject from rate_limit_counters
    where scope = 'open_cd' order by subject
  `;
  const subjects = remaining.map((r) => r.subject);
  assert(!subjects.includes('user:stale|ap:a'), 'stale sentinel must be pruned');
  assert(subjects.includes('user:fresh|ap:b'), 'fresh sentinel must survive');
  assert(subjects.includes('user:new|ap:c'), 'newly claimed sentinel must exist');
});

// ---------------------------------------------------------------------------
// Quotas (admin policy, off by default)
// ---------------------------------------------------------------------------

dbTest('quota: per-location daily cap trips for members and resets the next day', async () => {
  await resetData();
  const app = await bootTestApp();
  const { sql } = await setupTestDb();
  const a = await registerUser(app);
  const b = await registerUser(app);
  await addMember(a.account_id, b.user_id, 'member');
  const seeded = await seedLocationWithAccessPoint(a.account_id, { withAccessPoint: true });
  const apId = seeded.access_point_id!;
  const locId = seeded.location_id;

  // Admin configures the cap through the portal API.
  const patch = await app.request('PATCH', `/locations/${locId}/limits`, {
    token: a.access_token,
    json: { max_opens_per_location_per_day: 2 },
  });
  assertEquals(patch.status, 200);
  assertEquals(
    (patch.body as { quotas: { max_opens_per_location_per_day: number } }).quotas
      .max_opens_per_location_per_day,
    2,
  );

  assertEquals((await openAp(app, b, apId)).status, 200);
  assertEquals((await openAp(app, b, apId)).status, 200);
  const third = await openAp(app, b, apId);
  assertEquals(third.status, 429);
  const body = third.body as { error: string };
  assertEquals(body.error, 'quota_exceeded');
  const retryAfter = Number(third.headers.get('Retry-After'));
  assert(retryAfter >= 1 && retryAfter <= 86400, `Retry-After within the day, got ${retryAfter}`);

  const logsBefore = await accessLogRows(apId);
  assertEquals(logsBefore.filter((l) => !l.success && l.error === 'quota_exceeded').length, 1);

  // Next day: shift the daily counter windows back 24h (fixed windows are
  // plain rows, so time travel is a direct SQL update).
  await sql.unsafe(`
    update rate_limit_counters
    set window_start = window_start - interval '1 day'
    where scope in ('opens_1d', 'loc_opens_1d')
  `);
  assertEquals((await openAp(app, b, apId)).status, 200);
});

dbTest('quota: per-member daily cap is per member — one member capped, another still opens', async () => {
  await resetData();
  const app = await bootTestApp();
  const a = await registerUser(app);
  const b = await registerUser(app);
  const c = await registerUser(app);
  await addMember(a.account_id, b.user_id, 'member');
  await addMember(a.account_id, c.user_id, 'member');
  const seeded = await seedLocationWithAccessPoint(a.account_id, { withAccessPoint: true });
  const apId = seeded.access_point_id!;

  const patch = await app.request('PATCH', `/locations/${seeded.location_id}/limits`, {
    token: a.access_token,
    json: { max_opens_per_member_per_day: 1 },
  });
  assertEquals(patch.status, 200);

  assertEquals((await openAp(app, b, apId)).status, 200);
  const bAgain = await openAp(app, b, apId);
  assertEquals(bAgain.status, 429);
  assertEquals((bAgain.body as { error: string }).error, 'quota_exceeded');

  // A different member has their own budget.
  assertEquals((await openAp(app, c, apId)).status, 200);
});

dbTest('quota: owners/admins are exempt from quotas but NOT from rate limits', async () => {
  await resetData();
  const app = await bootTestApp();
  const a = await registerUser(app); // owner of the account
  const seeded = await seedLocationWithAccessPoint(a.account_id, { withAccessPoint: true });
  const apId = seeded.access_point_id!;

  const patch = await app.request('PATCH', `/locations/${seeded.location_id}/limits`, {
    token: a.access_token,
    json: { max_opens_per_location_per_day: 1, max_opens_per_member_per_day: 1 },
  });
  assertEquals(patch.status, 200);

  // Both caps are 1, yet the owner sails past them (quota exemption)...
  assertEquals((await openAp(app, a, apId)).status, 200);
  assertEquals((await openAp(app, a, apId)).status, 200);

  // ...but rate limits still apply to admins: with a cooldown configured the
  // next immediate open is denied as rate_limited (NOT quota_exceeded).
  const restore = setRate({ RATE_OPEN_COOLDOWN_S: '10' });
  try {
    const limited = await openAp(app, a, apId);
    assertEquals(limited.status, 429);
    assertEquals((limited.body as { error: string }).error, 'rate_limited');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Limits API + usage surfacing
// ---------------------------------------------------------------------------

dbTest('limits API: GET exposes quotas + usage; PATCH validates and is admin-only', async () => {
  await resetData();
  const app = await bootTestApp();
  const a = await registerUser(app);
  const b = await registerUser(app);
  const outsider = await registerUser(app);
  await addMember(a.account_id, b.user_id, 'member');
  const seeded = await seedLocationWithAccessPoint(a.account_id, { withAccessPoint: true });
  const apId = seeded.access_point_id!;
  const locId = seeded.location_id;

  // Defaults: no quotas configured.
  const before = await app.request('GET', `/locations/${locId}/limits`, { token: a.access_token });
  assertEquals(before.status, 200);
  const beforeBody = before.body as {
    quotas: { max_opens_per_member_per_day: null; max_opens_per_location_per_day: null };
    usage: { location_opens_today: number };
  };
  assertEquals(beforeBody.quotas.max_opens_per_member_per_day, null);
  assertEquals(beforeBody.quotas.max_opens_per_location_per_day, null);
  assertEquals(beforeBody.usage.location_opens_today, 0);

  // Plain members cannot set quotas; zod rejects out-of-range values.
  const asMember = await app.request('PATCH', `/locations/${locId}/limits`, {
    token: b.access_token,
    json: { max_opens_per_location_per_day: 5 },
  });
  assertEquals(asMember.status, 403);
  const badValue = await app.request('PATCH', `/locations/${locId}/limits`, {
    token: a.access_token,
    json: { max_opens_per_location_per_day: 0 },
  });
  assertEquals(badValue.status, 400);
  // Outsiders can't even see the location.
  const asOutsider = await app.request('GET', `/locations/${locId}/limits`, {
    token: outsider.access_token,
  });
  assertEquals(asOutsider.status, 404);

  // Admin sets both caps; PATCHing one field leaves the other unchanged;
  // null clears back to unlimited.
  const set = await app.request('PATCH', `/locations/${locId}/limits`, {
    token: a.access_token,
    json: { max_opens_per_member_per_day: 4, max_opens_per_location_per_day: 10 },
  });
  assertEquals(set.status, 200);
  const partial = await app.request('PATCH', `/locations/${locId}/limits`, {
    token: a.access_token,
    json: { max_opens_per_location_per_day: 20 },
  });
  const partialBody = partial.body as {
    quotas: { max_opens_per_member_per_day: number; max_opens_per_location_per_day: number };
  };
  assertEquals(partialBody.quotas.max_opens_per_member_per_day, 4);
  assertEquals(partialBody.quotas.max_opens_per_location_per_day, 20);
  const cleared = await app.request('PATCH', `/locations/${locId}/limits`, {
    token: a.access_token,
    json: { max_opens_per_member_per_day: null },
  });
  assertEquals(
    (cleared.body as { quotas: { max_opens_per_member_per_day: null } }).quotas
      .max_opens_per_member_per_day,
    null,
  );

  // Usage reflects successful opens (denials are excluded) per member.
  assertEquals((await openAp(app, b, apId)).status, 200);
  assertEquals((await openAp(app, a, apId)).status, 200);
  const after = await app.request('GET', `/locations/${locId}/limits`, { token: a.access_token });
  const afterBody = after.body as {
    usage: {
      location_opens_today: number;
      my_opens_today: number;
      members: Array<{ user_id: string | null; opens_today: number }>;
    };
  };
  assertEquals(afterBody.usage.location_opens_today, 2);
  assertEquals(afterBody.usage.my_opens_today, 1);
  const bRow = afterBody.usage.members.find((m) => m.user_id === b.user_id);
  assertExists(bRow);
  assertEquals(bRow!.opens_today, 1);
});

dbTest('analytics: location summary surfaces today usage vs quota for the UI', async () => {
  await resetData();
  const app = await bootTestApp();
  const a = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(a.account_id, { withAccessPoint: true });

  await app.request('PATCH', `/locations/${seeded.location_id}/limits`, {
    token: a.access_token,
    json: { max_opens_per_location_per_day: 50, max_opens_per_member_per_day: 4 },
  });
  assertEquals((await openAp(app, a, seeded.access_point_id!)).status, 200);

  const summary = await app.request('GET', `/analytics/locations/${seeded.location_id}/summary`, {
    token: a.access_token,
  });
  assertEquals(summary.status, 200);
  const body = summary.body as {
    today: {
      opens: number;
      max_opens_per_member_per_day: number | null;
      max_opens_per_location_per_day: number | null;
    };
  };
  assertEquals(body.today.opens, 1);
  assertEquals(body.today.max_opens_per_member_per_day, 4);
  assertEquals(body.today.max_opens_per_location_per_day, 50);
});
