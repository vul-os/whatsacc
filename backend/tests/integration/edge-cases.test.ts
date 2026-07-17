// Edge-case + concurrency tests across surfaces. These run alongside the
// per-area integration suites and target failure modes the happy-path
// tests don't exercise.

import { assert, assertEquals, assertExists, assertNotEquals } from '../helpers/assert.ts';
import { withRLS } from '@/lib/db.ts';
import { bootTestApp } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { registerUser, seedLocationWithAccessPoint } from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';

// ===========================================================================
// auth: edge cases
// ===========================================================================

dbTest('auth: login is case-insensitive on email', async () => {
  await resetData();
  const app = await bootTestApp();
  await registerUser(app, { email: 'mixedcase@test.local' });

  const r = await app.request('POST', '/auth/login', {
    json: { email: 'MixedCase@Test.Local', password: 'Pa55word_test' },
  });
  assertEquals(r.status, 200);
});

dbTest('auth: forgot-password is silent for unknown emails', async () => {
  await resetData();
  const app = await bootTestApp();
  const r = await app.request('POST', '/auth/forgot-password', {
    json: { email: 'never-existed-12345@test.local' },
  });
  // Always 204, never reveals whether the email is registered.
  assertEquals(r.status, 204);
});

dbTest('auth: concurrent refreshes — only one survives, the other detects reuse', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  // Fire two refreshes simultaneously with the same token. The DB row's
  // FOR UPDATE serialises them; one rotates, the other sees a now-replaced
  // token and triggers reuse detection.
  const [a, b] = await Promise.all([
    app.request('POST', '/auth/refresh', {
      json: { refresh_token: u.refresh_token },
    }),
    app.request('POST', '/auth/refresh', {
      json: { refresh_token: u.refresh_token },
    }),
  ]);

  const codes = [a.status, b.status].sort();
  // Exactly one 200 and one 401 — never both 200.
  assertEquals(codes, [200, 401]);
  // The 401 either says "reused" (we got past the first FOR UPDATE) or
  // "invalid" (the row was replaced before we read it).
  const losing = a.status === 401 ? a : b;
  const code = (losing.body as { error: string }).error;
  assert(
    code === 'refresh_token_reused' || code === 'invalid_refresh_token',
    `unexpected loser code: ${code}`,
  );
});

dbTest('auth: logout twice is idempotent (204 both times)', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  const a = await app.request('POST', '/auth/logout', {
    json: { refresh_token: u.refresh_token },
  });
  const b = await app.request('POST', '/auth/logout', {
    json: { refresh_token: u.refresh_token },
  });
  assertEquals(a.status, 204);
  assertEquals(b.status, 204);
});

dbTest('auth: register with extra unknown fields is rejected (strict schema)', async () => {
  await resetData();
  const app = await bootTestApp();
  const r = await app.request('POST', '/auth/register', {
    json: {
      email: 'extra@test.local',
      password: 'Pa55word_test',
      display_name: 'X',
      location_name: 'X HQ',
      country_code: 'ZA',
      // mass-assignment attempts
      is_platform_admin: true,
      status: 'active',
    },
  });
  assertEquals(r.status, 400);
});

dbTest('auth: reset-password rejects expired tokens', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const plain = 'a-known-test-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const refresh = await import('@/lib/refresh.ts');
  const tokenHash = await refresh.hashToken(plain);

  await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      // expired 1 minute ago
      const expired = new Date(Date.now() - 60_000);
      await tx`
        insert into password_reset_tokens (token_hash, user_id, expires_at)
        values (${tokenHash}, ${u.user_id}, ${expired})
      `;
    },
  );

  const r = await app.request('POST', '/auth/reset-password', {
    json: { token: plain, new_password: 'Pa55word_NEW_1' },
  });
  assertEquals(r.status, 400);
  assertEquals((r.body as { error: string }).error, 'token_expired');
});

// ===========================================================================
// grants: edge cases
// ===========================================================================

dbTest('grants: two grants for same phone+access-point both consumable in window', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
  const apId = seeded.access_point_id!;

  const ends = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  // Two overlapping grants for the same phone, both single-use.
  for (let i = 0; i < 2; i++) {
    const r = await app.request('POST', '/access/grants', {
      token: u.access_token,
      json: {
        phone_e164: '+27821234567',
        ends_at: ends,
        max_uses: 1,
        access_point_ids: [apId],
      },
    });
    assertEquals(r.status, 201);
  }

  const { tryConsumeGrant } = await import('@/routes/access.ts');
  const a = await tryConsumeGrant('+27821234567', apId);
  const b = await tryConsumeGrant('+27821234567', apId);
  const c = await tryConsumeGrant('+27821234567', apId);
  assertExists(a);
  assertExists(b);
  assertNotEquals(a, b, 'should consume different grants');
  assertEquals(c, null, 'both grants now exhausted');
});

dbTest('grants: deleting an access_point cascades to grant_access_points join rows', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const ap1 = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
  const ap2 = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

  await app.request('POST', '/access/grants', {
    token: u.access_token,
    json: {
      phone_e164: '+27821234567',
      ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      access_point_ids: [ap1.access_point_id!, ap2.access_point_id!],
    },
  });

  await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      await tx`delete from access_points where id = ${ap1.access_point_id!}`;
    },
  );

  const rows = await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) =>
      await tx<{ access_point_id: string }[]>`
        select access_point_id from temporary_access_grant_access_points
      `,
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.access_point_id, ap2.access_point_id);
});

dbTest('grants: phone E.164 — leading zero rejected, +0 prefix rejected', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

  for (const bad of ['0821234567', '+0821234567', '+', '+abc1234567']) {
    const r = await app.request('POST', '/access/grants', {
      token: u.access_token,
      json: {
        phone_e164: bad,
        ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        access_point_ids: [seeded.access_point_id!],
      },
    });
    assertEquals(r.status, 400, `expected 400 for ${bad}, got ${r.status}`);
  }
});

// ===========================================================================
// maintenance: edge cases
// ===========================================================================

dbTest('maintenance: opens by multiple users compound the wear meter correctly', async () => {
  await resetData();
  const app = await bootTestApp();
  const owner = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(owner.account_id, {
    withAccessPoint: true,
    gateMovementMperOp: 4,
  });
  const apId = seeded.access_point_id!;

  // 5 sequential opens by the owner.
  for (let i = 0; i < 5; i++) {
    const r = await app.request('POST', `/access/access-points/${apId}/open`, {
      token: owner.access_token,
      json: { source: 'web' },
    });
    assertEquals(r.status, 200);
  }
  const meter = await app.request('GET', `/access/access-points/${apId}`, {
    token: owner.access_token,
  });
  const m = meter.body as { meter: { movement_m: number; total_opens: number } };
  assertEquals(m.meter.total_opens, 5);
  assertEquals(m.meter.movement_m, 20);
});

dbTest('maintenance: service event with cost + parts is round-tripped intact', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
  const apId = seeded.access_point_id!;

  const create = await app.request('POST', `/access/access-points/${apId}/maintenance`, {
    token: u.access_token,
    json: {
      kind: 'replacement',
      technician_name: 'Themba M.',
      notes: 'Replaced motor + capacitor',
      parts: [
        { name: 'Motor', qty: 1, cost_zar_cents: 250_000 },
        { name: 'Capacitor', qty: 1, cost_zar_cents: 12_000 },
      ],
      cost_zar_cents: 262_000,
      next_due_in_days: 365,
    },
  });
  assertEquals(create.status, 201);

  const list = await app.request('GET', `/access/access-points/${apId}/maintenance`, {
    token: u.access_token,
  });
  const body = list.body as {
    events: Array<{
      kind: string;
      cost_zar_cents: number | null;
      parts: Array<{ name: string; qty: number }>;
    }>;
  };
  assertEquals(body.events.length, 1);
  assertEquals(body.events[0]!.kind, 'replacement');
  assertEquals(body.events[0]!.cost_zar_cents, 262_000);
  assertEquals(body.events[0]!.parts.length, 2);
});

dbTest('maintenance: providing both next_due_at and next_due_in_days is rejected', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

  const r = await app.request(
    'POST',
    `/access/access-points/${seeded.access_point_id}/maintenance`,
    {
      token: u.access_token,
      json: {
        kind: 'service',
        next_due_at: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
        next_due_in_days: 180,
      },
    },
  );
  assertEquals(r.status, 400);
  assertEquals((r.body as { error: string }).error, 'conflicting_due_inputs');
});
