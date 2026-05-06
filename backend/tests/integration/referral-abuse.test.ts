// Adversarial coverage for the referral programme. These tests focus on
// fraud-prevention invariants: attribution stickiness, earning idempotency,
// payout race protection, and that earnings only flow from the intended
// payment kinds.
//
// Plain happy-path coverage lives in tests/integration/referrals.test.ts and
// tests/integration/billing.test.ts — this file is for the "what if a user
// tries to game the system" cases.

import { assert, assertEquals, assertExists } from '@std/assert';
import postgres from 'postgres';
import { withRLS } from '@/lib/db.ts';
import { bootTestApp } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { completeKyc, registerUser, seedReferralEarning, signPaystackBody } from '../helpers/fixtures.ts';
import { installPaystackStub } from '../helpers/paystack-mock.ts';
import { dbTest } from '../helpers/test.ts';

const SECRET = 'sk_test_dummy';

// ---------------------------------------------------------------------------
// Attribution stickiness
// ---------------------------------------------------------------------------

dbTest('abuse: re-registering with the same email is rejected (no double attribution)', async () => {
  await resetData();
  const app = await bootTestApp();
  const referrer = await registerUser(app);
  assertExists(referrer.referral_slug);

  const refereeEmail = 'sticky-attrib@test.local';
  await registerUser(app, { email: refereeEmail, referral_slug: referrer.referral_slug! });

  // Same email tries again with a different (no) referrer — must be 409.
  const dupe = await app.request('POST', '/auth/register', {
    json: {
      email: refereeEmail,
      password: 'Pa55word_test',
      display_name: 'Imposter',
      country_code: 'ZA',
    },
  });
  assertEquals(dupe.status, 409);
  assertEquals((dupe.body as { error: string }).error, 'email_taken');
});

dbTest(
  'abuse: attribution row is unique per referee — second insert with a different referrer is a no-op',
  async () => {
    await resetData();
    const app = await bootTestApp();
    const r1 = await registerUser(app);
    const r2 = await registerUser(app);
    assertExists(r1.referral_slug);
    assertExists(r2.referral_slug);
    const referee = await registerUser(app, { referral_slug: r1.referral_slug! });

    // Try to insert a second attribution row pointing at r2 (simulating a
    // bug or attempted bypass of the application code). The unique
    // constraint on referee_user_id must prevent any row from leaking
    // through with a different referrer.
    await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) => {
        await tx`
          insert into referral_attributions (referrer_user_id, referee_user_id, via_slug)
          values (${r2.user_id}, ${referee.user_id}, ${r2.referral_slug!})
          on conflict (referee_user_id) do nothing
        `;
      },
    );

    // Attribution still points at the original referrer.
    const rows = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) => await tx<{ referrer_user_id: string }[]>`
        select referrer_user_id from referral_attributions
        where referee_user_id = ${referee.user_id}
      `,
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.referrer_user_id, r1.user_id);
  },
);

dbTest('abuse: changing slug after referrals exist preserves earnings on the referrer', async () => {
  await resetData();
  const app = await bootTestApp();
  const referrer = await registerUser(app);
  const referee = await registerUser(app);
  await seedReferralEarning(referrer.user_id, referee.user_id, 75_000);

  // Change slug — must not orphan past earnings.
  const newSlug = 'ref-after-rename';
  const r = await app.request('PUT', '/referrals/slug', {
    token: referrer.access_token,
    json: { slug: newSlug },
  });
  assertEquals(r.status, 200);

  const me = await app.request('GET', '/referrals/me', { token: referrer.access_token });
  assertEquals(me.status, 200);
  const meBody = me.body as { slug: string; balance: { earned_cents: number } };
  assertEquals(meBody.slug, newSlug);
  assertEquals(meBody.balance.earned_cents, 75_000);
});

// ---------------------------------------------------------------------------
// Earning trigger correctness — only credit the right intents, exactly once
// ---------------------------------------------------------------------------

dbTest('abuse: a user with no referrer earns nobody anything when topping up', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const u = await registerUser(app); // no referral_slug — no referrer
    const init = await app.request('POST', '/billing/wallet/topup', {
      token: u.access_token,
      json: { account_id: u.account_id, amount_cents: 500_00 },
    });
    const ref = (init.body as { reference: string }).reference;
    const v = await app.request('GET', '/billing/wallet/verify', {
      token: u.access_token,
      query: { reference: ref },
    });
    assertEquals(v.status, 200);

    const earnings = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) => await tx<{ count: string }[]>`select count(*)::text as count from referral_earnings`,
    );
    assertEquals(Number(earnings[0]!.count), 0);
  } finally {
    stub.restore();
  }
});

dbTest('abuse: webhook replay does not double-credit referral earnings', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const referrer = await registerUser(app);
    assertExists(referrer.referral_slug);
    const referee = await registerUser(app, { referral_slug: referrer.referral_slug! });

    const init = await app.request('POST', '/billing/wallet/topup', {
      token: referee.access_token,
      json: { account_id: referee.account_id, amount_cents: 200_00 },
    });
    const ref = (init.body as { reference: string }).reference;

    // Send the same charge.success webhook three times. event_id stays
    // identical, so the dedupe layer takes over after the first hit.
    const eventBody = JSON.stringify({
      event: 'charge.success',
      data: { id: 88_888, reference: ref, status: 'success' },
    });
    const sig = await signPaystackBody(SECRET, eventBody);
    for (let i = 0; i < 3; i++) {
      const wh = await app.request('POST', '/webhooks/paystack', {
        rawBody: eventBody,
        contentType: 'application/json',
        headers: { 'x-paystack-signature': sig },
      });
      assertEquals(wh.status, 200);
    }

    // Then verify via the user-facing endpoint twice — also idempotent.
    for (let i = 0; i < 2; i++) {
      const v = await app.request('GET', '/billing/wallet/verify', {
        token: referee.access_token,
        query: { reference: ref },
      });
      assertEquals(v.status, 200);
    }

    // Exactly one earning row, exactly 10% of the topup.
    const earnings = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) => await tx<{ count: string; sum: string }[]>`
        select count(*)::text as count,
               coalesce(sum(amount_zar_cents), 0)::text as sum
        from referral_earnings where referrer_user_id = ${referrer.user_id}
      `,
    );
    assertEquals(Number(earnings[0]!.count), 1);
    assertEquals(Number(earnings[0]!.sum), 20_00); // 10% of R 200 = R 20
  } finally {
    stub.restore();
  }
});

dbTest('abuse: only succeeded wallet_topup intents trigger earnings — failed/abandoned do not', async () => {
  await resetData();
  const app = await bootTestApp();
  const referrer = await registerUser(app);
  assertExists(referrer.referral_slug);
  const referee = await registerUser(app, { referral_slug: referrer.referral_slug! });

  await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      // Insert a failed intent + an abandoned intent for the referee.
      await tx`
        insert into payment_intents
          (account_id, initiated_by, provider, provider_reference, purpose,
           amount_cents, currency, status)
        values
          (${referee.account_id}, ${referee.user_id}, 'paystack', 'ref-fail-1',
           'wallet_topup', 100_00, 'ZAR', 'failed'),
          (${referee.account_id}, ${referee.user_id}, 'paystack', 'ref-aban-1',
           'wallet_topup', 100_00, 'ZAR', 'abandoned')
      `;
      // Flip them through every status that ISN'T succeeded — the trigger
      // also has to ignore non-terminal updates.
      await tx`
        update payment_intents set status = 'failed'
        where provider_reference = 'ref-fail-1'
      `;
      await tx`
        update payment_intents set status = 'abandoned'
        where provider_reference = 'ref-aban-1'
      `;
    },
  );

  const earnings = await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => await tx<{ count: string }[]>`
      select count(*)::text as count from referral_earnings
      where referrer_user_id = ${referrer.user_id}
    `,
  );
  assertEquals(Number(earnings[0]!.count), 0);
});

// ---------------------------------------------------------------------------
// Payout race protection
// ---------------------------------------------------------------------------

dbTest(
  'abuse: two simultaneous payout requests cannot drain past the available balance',
  async () => {
    await resetData();
    const app = await bootTestApp();
    const u = await registerUser(app);
    const ref = await registerUser(app);
    await seedReferralEarning(u.user_id, ref.user_id, 80_000); // R 800
    await completeKyc(u.user_id);

    // Fire two concurrent requests — each for the FULL balance. If the
    // balance check isn't serialised, both could insert pending payouts
    // totalling > available.
    const [a, b] = await Promise.all([
      app.request('POST', '/referrals/payouts', {
        token: u.access_token,
        json: { amount_zar_cents: 80_000 },
      }),
      app.request('POST', '/referrals/payouts', {
        token: u.access_token,
        json: { amount_zar_cents: 80_000 },
      }),
    ]);

    const codes = [a.status, b.status].sort();
    // Exactly one must succeed; the other must be rejected for insufficient
    // balance. Anything that lets both through is a fraud vector.
    assertEquals(codes, [201, 400], 'concurrent payouts drained past available balance');

    const losing = a.status === 400 ? a : b;
    assertEquals((losing.body as { error: string }).error, 'insufficient_balance');

    // Sanity: total pending+approved is exactly one R 800 row.
    const pending = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) => await tx<{ count: string; sum: string }[]>`
        select count(*)::text as count,
               coalesce(sum(amount_zar_cents), 0)::text as sum
        from payout_requests
        where user_id = ${u.user_id} and status in ('pending','approved')
      `,
    );
    assertEquals(Number(pending[0]!.count), 1);
    assertEquals(Number(pending[0]!.sum), 80_000);
  },
);

dbTest(
  'abuse: route holds an advisory lock — payout create blocks while another tx holds the user\'s lock',
  async () => {
    await resetData();
    const app = await bootTestApp();
    const u = await registerUser(app);
    const ref = await registerUser(app);
    await seedReferralEarning(u.user_id, ref.user_id, 80_000);
    await completeKyc(u.user_id);

    // Open a SECOND postgres connection — the app's pool is max:1 so we
    // can't actually run two transactions in parallel through it, but a
    // dedicated client can hold the advisory lock while the route tries
    // to acquire it on the shared client.
    const url = Deno.env.get('DATABASE_URL')!;
    const holder = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
    try {
      // Acquire the same xact-lock the route uses, on a separate connection.
      const locked = holder.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended('payout:' || ${u.user_id}, 0))`;
        // Hold the lock for ~600ms so the route's attempt has to wait.
        await new Promise((r) => setTimeout(r, 600));
      });

      // Race: request a payout while the lock is held.
      const tStart = Date.now();
      const [_, payout] = await Promise.all([
        locked,
        app.request('POST', '/referrals/payouts', {
          token: u.access_token,
          json: { amount_zar_cents: 80_000 },
        }),
      ]);
      const elapsed = Date.now() - tStart;

      assertEquals(payout.status, 201);
      // The request can't have completed before the holder released — it
      // had to wait for the advisory lock. ~500ms is the floor.
      assert(
        elapsed >= 500,
        `payout returned in ${elapsed}ms, expected ≥500ms (lock not enforced?)`,
      );
    } finally {
      await holder.end({ timeout: 5 });
    }
  },
);

dbTest('abuse: cancelling a non-pending payout (paid/cancelled) is rejected', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const ref = await registerUser(app);
  await seedReferralEarning(u.user_id, ref.user_id, 100_000);
  await completeKyc(u.user_id);

  const created = await app.request('POST', '/referrals/payouts', {
    token: u.access_token,
    json: { amount_zar_cents: 60_000 },
  });
  const payoutId = (created.body as { id: string }).id;

  // First cancel succeeds.
  const c1 = await app.request('POST', `/referrals/payouts/${payoutId}/cancel`, {
    token: u.access_token,
  });
  assertEquals(c1.status, 204);

  // Second cancel on the same id returns the not-cancellable error.
  const c2 = await app.request('POST', `/referrals/payouts/${payoutId}/cancel`, {
    token: u.access_token,
  });
  assertEquals(c2.status, 404);
  assertEquals((c2.body as { error: string }).error, 'payout_not_cancellable');

  // Manually flip a separate request to 'paid' and confirm it can't be cancelled.
  const created2 = await app.request('POST', '/referrals/payouts', {
    token: u.access_token,
    json: { amount_zar_cents: 60_000 },
  });
  const paidId = (created2.body as { id: string }).id;
  await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      await tx`update payout_requests set status = 'paid', processed_at = now() where id = ${paidId}`;
    },
  );
  const c3 = await app.request('POST', `/referrals/payouts/${paidId}/cancel`, {
    token: u.access_token,
  });
  assertEquals(c3.status, 404);
  assertEquals((c3.body as { error: string }).error, 'payout_not_cancellable');
});

dbTest(
  'abuse: cross-user payout cancel — cannot cancel another user\'s payout even by id',
  async () => {
    await resetData();
    const app = await bootTestApp();
    const owner = await registerUser(app);
    const stranger = await registerUser(app);
    const ref = await registerUser(app);
    await seedReferralEarning(owner.user_id, ref.user_id, 100_000);
    await completeKyc(owner.user_id);

    const created = await app.request('POST', '/referrals/payouts', {
      token: owner.access_token,
      json: { amount_zar_cents: 60_000 },
    });
    const payoutId = (created.body as { id: string }).id;

    const cross = await app.request('POST', `/referrals/payouts/${payoutId}/cancel`, {
      token: stranger.access_token,
    });
    assertEquals(cross.status, 404);

    // The owner can still cancel their own.
    const own = await app.request('POST', `/referrals/payouts/${payoutId}/cancel`, {
      token: owner.access_token,
    });
    assertEquals(own.status, 204);
  },
);
