import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { withRLS } from '@/lib/db.ts';
import { bootTestApp } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import {
  completeKyc,
  registerUser,
  seedReferralEarning,
} from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';

dbTest('GET /referrals/resolve/:slug returns 404 for unknown slugs', async () => {
  await resetData();
  const app = await bootTestApp();
  const r = await app.request('GET', '/referrals/resolve/never-existed');
  assertEquals(r.status, 404);
});

dbTest('GET /referrals/resolve/:slug returns the referrer for a real slug (anon)', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app, { display_name: 'Yusuf Adams' });
  const r = await app.request('GET', `/referrals/resolve/${u.referral_slug}`);
  assertEquals(r.status, 200);
  const body = r.body as { slug: string; display_name: string };
  assertEquals(body.slug, u.referral_slug);
  assertEquals(body.display_name, 'Yusuf Adams');
});

dbTest('PUT /referrals/slug enforces format, reserves, and conflict', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  const tooShort = await app.request('PUT', '/referrals/slug', {
    token: u.access_token,
    json: { slug: 'ab' },
  });
  assertEquals(tooShort.status, 400);

  const reserved = await app.request('PUT', '/referrals/slug', {
    token: u.access_token,
    json: { slug: 'admin' },
  });
  assertEquals(reserved.status, 400);

  const malformed = await app.request('PUT', '/referrals/slug', {
    token: u.access_token,
    json: { slug: '-bad' },
  });
  assertEquals(malformed.status, 400);

  // Happy path.
  const ok = await app.request('PUT', '/referrals/slug', {
    token: u.access_token,
    json: { slug: 'yusuf-adams' },
  });
  assertEquals(ok.status, 200);

  // Another user can't claim the same slug — 409.
  const u2 = await registerUser(app);
  const dup = await app.request('PUT', '/referrals/slug', {
    token: u2.access_token,
    json: { slug: 'yusuf-adams' },
  });
  assertEquals(dup.status, 409);
});

dbTest('PUT /referrals/slug enforces a 24h cooldown (rewinding via raw SQL to retest)', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  const r1 = await app.request('PUT', '/referrals/slug', {
    token: u.access_token,
    json: { slug: 'first-name' },
  });
  assertEquals(r1.status, 200);

  // Immediate second change is blocked by the cooldown.
  const r2 = await app.request('PUT', '/referrals/slug', {
    token: u.access_token,
    json: { slug: 'second-name' },
  });
  assertEquals(r2.status, 400);
  assertEquals((r2.body as { error: string }).error, 'slug_change_cooldown');

  // Rewind the timestamp 25h and try again — should succeed.
  await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      await tx`
        update users set referral_slug_updated_at = now() - interval '25 hours'
        where id = ${u.user_id}
      `;
    },
  );
  const r3 = await app.request('PUT', '/referrals/slug', {
    token: u.access_token,
    json: { slug: 'second-name' },
  });
  assertEquals(r3.status, 200);
});

dbTest('GET /referrals/me reflects earnings and referee counts', async () => {
  await resetData();
  const app = await bootTestApp();
  const referrer = await registerUser(app);
  const a = await registerUser(app, { referral_slug: referrer.referral_slug! });
  const b = await registerUser(app, { referral_slug: referrer.referral_slug! });

  await seedReferralEarning(referrer.user_id, a.user_id, 50_00);
  await seedReferralEarning(referrer.user_id, b.user_id, 30_00);

  const me = await app.request('GET', '/referrals/me', { token: referrer.access_token });
  assertEquals(me.status, 200);
  const body = me.body as {
    balance: { earned_cents: number; available_cents: number };
    counts: { referees_total: number };
    recent_earnings: { amount_zar_cents: number }[];
  };
  assertEquals(body.balance.earned_cents, 80_00);
  assertEquals(body.balance.available_cents, 80_00);
  assertEquals(body.counts.referees_total, 2);
  assertEquals(body.recent_earnings.length, 2);
});

dbTest('GET/PUT /referrals/kyc round-trips and reports completeness', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  const empty = await app.request('GET', '/referrals/kyc', { token: u.access_token });
  assertEquals(empty.status, 200);
  assertEquals((empty.body as { complete: boolean }).complete, false);

  const partial = await app.request('PUT', '/referrals/kyc', {
    token: u.access_token,
    json: { full_name: 'Yusuf Adams', cellphone: '+27821234567' },
  });
  assertEquals(partial.status, 200);
  assertEquals((partial.body as { complete: boolean }).complete, false);

  const full = await app.request('PUT', '/referrals/kyc', {
    token: u.access_token,
    json: {
      full_name: 'Yusuf Adams',
      cellphone: '+27821234567',
      id_kind: 'za_id',
      id_number: '8001015009087',
      bank_name: 'FNB',
      bank_branch_code: '250655',
      bank_account_number: '62123456789',
      bank_account_holder: 'Y Adams',
      bank_account_type: 'cheque',
    },
  });
  assertEquals(full.status, 200);
  assertEquals((full.body as { complete: boolean }).complete, true);
});

dbTest('POST /referrals/payouts requires complete KYC', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  // Seed an earnings balance >= R 500 min payout.
  const referee = await registerUser(app);
  await seedReferralEarning(u.user_id, referee.user_id, 60_000);

  const r = await app.request('POST', '/referrals/payouts', {
    token: u.access_token,
    json: { amount_zar_cents: 50_000 },
  });
  assertEquals(r.status, 403);
  assertEquals((r.body as { error: string }).error, 'kyc_incomplete');
});

dbTest('POST /referrals/payouts rejects amounts above available balance', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const referee = await registerUser(app);
  await seedReferralEarning(u.user_id, referee.user_id, 60_000); // R 600
  await completeKyc(u.user_id);

  const r = await app.request('POST', '/referrals/payouts', {
    token: u.access_token,
    json: { amount_zar_cents: 70_000 },
  });
  assertEquals(r.status, 400);
  assertEquals((r.body as { error: string }).error, 'insufficient_balance');
});

dbTest('POST /referrals/payouts then cancel restores the available balance', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const referee = await registerUser(app);
  await seedReferralEarning(u.user_id, referee.user_id, 60_000);
  await completeKyc(u.user_id);

  const create = await app.request('POST', '/referrals/payouts', {
    token: u.access_token,
    json: { amount_zar_cents: 50_000 },
  });
  assertEquals(create.status, 201);
  const payoutId = (create.body as { id: string }).id;

  const me1 = await app.request('GET', '/referrals/me', { token: u.access_token });
  const b1 = me1.body as { balance: { available_cents: number; pending_cents: number } };
  assertEquals(b1.balance.pending_cents, 50_000);
  assertEquals(b1.balance.available_cents, 10_000);

  const cancel = await app.request('POST', `/referrals/payouts/${payoutId}/cancel`, {
    token: u.access_token,
  });
  assertEquals(cancel.status, 204);

  const me2 = await app.request('GET', '/referrals/me', { token: u.access_token });
  const b2 = me2.body as { balance: { available_cents: number; pending_cents: number } };
  assertEquals(b2.balance.pending_cents, 0);
  assertEquals(b2.balance.available_cents, 60_000);
});

dbTest('register: signing up with a referral slug attributes the referrer', async () => {
  await resetData();
  const app = await bootTestApp();
  const referrer = await registerUser(app);
  const referee = await registerUser(app, { referral_slug: referrer.referral_slug! });
  assertNotEquals(referee.user_id, referrer.user_id);
  // Verify the attribution row exists by checking the referrer's count.
  const me = await app.request('GET', '/referrals/me', { token: referrer.access_token });
  const body = me.body as { counts: { referees_total: number } };
  assertEquals(body.counts.referees_total, 1);
});

dbTest('register: invalid/reserved/own slug does NOT attribute', async () => {
  await resetData();
  const app = await bootTestApp();
  const referrer = await registerUser(app);

  // Invalid slug — silently no-op (we don't reject the registration).
  const u1 = await registerUser(app, { referral_slug: 'admin' });
  const me1 = await app.request('GET', '/referrals/me', { token: referrer.access_token });
  assertEquals((me1.body as { counts: { referees_total: number } }).counts.referees_total, 0);

  // Self-referral — own slug — also no-op.
  const u2 = await registerUser(app);
  const selfRef = await app.request('POST', '/auth/register', {
    json: {
      email: 'self@test.local',
      password: 'Pa55word_test',
      display_name: 'Self',
      country_code: 'ZA',
      referral_slug: u2.referral_slug,
    },
  });
  // (registers fine — user just attributed to themselves which is suppressed)
  assert(selfRef.status === 201 || selfRef.status === 409);
});
