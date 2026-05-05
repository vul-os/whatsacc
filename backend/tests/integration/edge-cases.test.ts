// Edge-case + concurrency tests across surfaces. These run alongside the
// per-area integration suites and target failure modes the happy-path
// tests don't exercise.

import { assert, assertEquals, assertExists, assertNotEquals } from '@std/assert';
import { withRLS } from '@/lib/db.ts';
import { runMonthlyPayouts } from '@/lib/payouts.ts';
import { bootTestApp } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import {
  completeKyc,
  registerUser,
  seedLocationWithAccessPoint,
  seedReferralEarning,
  signPaystackBody,
} from '../helpers/fixtures.ts';
import { installPaystackStub } from '../helpers/paystack-mock.ts';
import { dbTest } from '../helpers/test.ts';

const SECRET = 'sk_test_dummy';

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
// billing: edge cases
// ===========================================================================

dbTest('billing: webhook with unrelated event_type is acknowledged but does nothing', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const u = await registerUser(app);

    const event = JSON.stringify({
      event: 'customeridentification.success',
      data: { id: 999_888 },
    });
    const sig = await signPaystackBody(SECRET, event);
    const wh = await app.request('POST', '/webhooks/paystack', {
      rawBody: event,
      contentType: 'application/json',
      headers: { 'x-paystack-signature': sig },
    });
    assertEquals(wh.status, 200);

    const billing = await app.request('GET', `/billing/accounts/${u.account_id}/billing`, {
      token: u.access_token,
    });
    const b = billing.body as { wallet: { balance_cents: number } | null };
    assertEquals(b.wallet?.balance_cents ?? 0, 0);
  } finally {
    stub.restore();
  }
});

dbTest('billing: topup amount must be positive (zero rejected)', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const u = await registerUser(app);
    const r = await app.request('POST', '/billing/wallet/topup', {
      token: u.access_token,
      json: { account_id: u.account_id, amount_cents: 0 },
    });
    assertEquals(r.status, 400);
    assertEquals(stub.initializeCount(), 0);
  } finally {
    stub.restore();
  }
});

dbTest('billing: verify with unknown reference returns 404', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const u = await registerUser(app);
    const r = await app.request('GET', '/billing/wallet/verify', {
      token: u.access_token,
      query: { reference: 'wt_does_not_exist_12345' },
    });
    assertEquals(r.status, 404);
  } finally {
    stub.restore();
  }
});

dbTest('billing: charge.failed webhook flips a pending intent to failed', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const u = await registerUser(app);
    const init = await app.request('POST', '/billing/wallet/topup', {
      token: u.access_token,
      json: { account_id: u.account_id, amount_cents: 75_00 },
    });
    const ref = (init.body as { reference: string }).reference;

    const event = JSON.stringify({
      event: 'charge.failed',
      data: { id: 4242, reference: ref, status: 'failed' },
    });
    const sig = await signPaystackBody(SECRET, event);
    const wh = await app.request('POST', '/webhooks/paystack', {
      rawBody: event,
      contentType: 'application/json',
      headers: { 'x-paystack-signature': sig },
    });
    assertEquals(wh.status, 200);

    const rows = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) =>
        await tx<{ status: string }[]>`
          select status from payment_intents where provider_reference = ${ref}
        `,
    );
    assertEquals(rows[0]!.status, 'failed');
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// referrals: edge cases
// ===========================================================================

dbTest('referrals: slug uppercase input is normalised to lowercase', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  const r = await app.request('PUT', '/referrals/slug', {
    token: u.access_token,
    json: { slug: 'YuSuF-AdAmS' },
  });
  assertEquals(r.status, 200);
  assertEquals((r.body as { slug: string }).slug, 'yusuf-adams');
});

dbTest('referrals: signing up with the OWN slug does NOT self-attribute', async () => {
  await resetData();
  const app = await bootTestApp();
  const me = await registerUser(app);

  // Register a second user using their OWN slug (after being told it).
  // This is a self-referral attempt.
  const second = await app.request('POST', '/auth/register', {
    json: {
      email: 'self@test.local',
      password: 'Pa55word_test',
      display_name: 'Self',
      country_code: 'ZA',
      referral_slug: me.referral_slug,
    },
  });
  assertEquals(second.status, 201);

  // me.referral counts should still be 0 (self-referral suppressed).
  const dash = await app.request('GET', '/referrals/me', { token: me.access_token });
  const body = dash.body as { counts: { referees_total: number } };
  assertEquals(body.counts.referees_total, 1, 'attribution row was written for the second user');
  // …but the referrer is NOT the second user themselves; verify by reading the
  // attribution row directly.
  const attr = await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) =>
      await tx<{ referrer_user_id: string; referee_user_id: string }[]>`
        select referrer_user_id, referee_user_id from referral_attributions
      `,
  );
  assertEquals(attr.length, 1);
  assertEquals(attr[0]!.referrer_user_id, me.user_id);
  assertNotEquals(attr[0]!.referee_user_id, attr[0]!.referrer_user_id);
});

dbTest('referrals: payout request can be cancelled then a new one created', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const ref = await registerUser(app);
  await seedReferralEarning(u.user_id, ref.user_id, 100_000);
  await completeKyc(u.user_id);

  const c1 = await app.request('POST', '/referrals/payouts', {
    token: u.access_token,
    json: { amount_zar_cents: 50_000 },
  });
  assertEquals(c1.status, 201);
  const id = (c1.body as { id: string }).id;
  const cancel = await app.request('POST', `/referrals/payouts/${id}/cancel`, {
    token: u.access_token,
  });
  assertEquals(cancel.status, 204);

  // Available balance restored — can request again.
  const c2 = await app.request('POST', '/referrals/payouts', {
    token: u.access_token,
    json: { amount_zar_cents: 50_000 },
  });
  assertEquals(c2.status, 201);
});

dbTest('referrals: KYC partial update preserves existing fields (COALESCE merge)', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  await app.request('PUT', '/referrals/kyc', {
    token: u.access_token,
    json: {
      full_name: 'A. Person',
      cellphone: '+27821234567',
      bank_name: 'FNB',
    },
  });
  await app.request('PUT', '/referrals/kyc', {
    token: u.access_token,
    json: { bank_account_number: '62123456789' },
  });

  const r = await app.request('GET', '/referrals/kyc', { token: u.access_token });
  const body = r.body as {
    kyc: {
      full_name: string | null;
      cellphone: string | null;
      bank_name: string | null;
      bank_account_number: string | null;
    } | null;
  };
  assertEquals(body.kyc?.full_name, 'A. Person');
  assertEquals(body.kyc?.cellphone, '+27821234567');
  assertEquals(body.kyc?.bank_name, 'FNB');
  assertEquals(body.kyc?.bank_account_number, '62123456789');
});

// ===========================================================================
// payouts cron: edge cases
// ===========================================================================

dbTest('cron: zero eligible candidates → no Paystack calls, all counters zero', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const r = await runMonthlyPayouts({ period: '2026-05' });
    assertEquals(r.processed, 0);
    assertEquals(r.dispatched, 0);
    assertEquals(stub.transferCount(), 0);
    assertEquals(stub.recipientCount(), 0);
  } finally {
    stub.restore();
  }
});

dbTest('cron: mixed batch — eligible + ineligible users, only the eligible get paid', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();

    // Eligible: KYC complete + R 600 balance
    const A = await registerUser(app);
    const refA = await registerUser(app);
    await seedReferralEarning(A.user_id, refA.user_id, 60_000);
    await completeKyc(A.user_id);

    // Eligible: KYC complete + R 1000 balance
    const B = await registerUser(app);
    const refB = await registerUser(app);
    await seedReferralEarning(B.user_id, refB.user_id, 100_000);
    await completeKyc(B.user_id);

    // Below min: only R 100, KYC complete (filtered by SQL)
    const C = await registerUser(app);
    const refC = await registerUser(app);
    await seedReferralEarning(C.user_id, refC.user_id, 10_000);
    await completeKyc(C.user_id);

    // No KYC: enough balance but no profile rows
    const D = await registerUser(app);
    const refD = await registerUser(app);
    await seedReferralEarning(D.user_id, refD.user_id, 80_000);

    const r = await runMonthlyPayouts({ period: '2026-05' });
    assertEquals(r.dispatched, 2, 'A and B should be paid');
    assertEquals(r.failed, 0);
    assertEquals(stub.transferCount(), 2);
  } finally {
    stub.restore();
  }
});

dbTest('cron: dry-run never calls Paystack and creates no payout rows', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const A = await registerUser(app);
    const ref = await registerUser(app);
    await seedReferralEarning(A.user_id, ref.user_id, 60_000);
    await completeKyc(A.user_id);

    const r = await runMonthlyPayouts({ period: '2026-05', dryRun: true });
    assertEquals(r.dispatched, 1);
    assertEquals(stub.transferCount(), 0, 'dry-run should not call Paystack');

    const rows = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) =>
        await tx<{ count: string }[]>`select count(*)::text as count from payout_requests`,
    );
    assertEquals(rows[0]!.count, '0', 'dry-run should not write payout rows');
  } finally {
    stub.restore();
  }
});

dbTest('cron: separate periods can both be dispatched in sequence', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const A = await registerUser(app);
    const ref = await registerUser(app);
    await seedReferralEarning(A.user_id, ref.user_id, 60_000);
    await completeKyc(A.user_id);

    const r1 = await runMonthlyPayouts({ period: '2026-04' });
    assertEquals(r1.dispatched, 1);

    // Add more earnings, then run for May — should pay again.
    await seedReferralEarning(A.user_id, ref.user_id, 60_000);
    const r2 = await runMonthlyPayouts({ period: '2026-05' });
    assertEquals(r2.dispatched, 1);
    assertEquals(stub.transferCount(), 2);

    const rows = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) =>
        await tx<{ payout_period: string }[]>`
          select payout_period from payout_requests order by payout_period
        `,
    );
    assertEquals(rows.map((r) => r.payout_period), ['2026-04', '2026-05']);
  } finally {
    stub.restore();
  }
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
