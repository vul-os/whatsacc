import { assertEquals, assertExists } from '@std/assert';
import { withRLS } from '@/lib/db.ts';
import { runMonthlyPayouts } from '@/lib/payouts.ts';
import { bootTestApp } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import {
  completeKyc,
  registerUser,
  seedReferralEarning,
  signPaystackBody,
} from '../helpers/fixtures.ts';
import { installPaystackStub } from '../helpers/paystack-mock.ts';
import { dbTest } from '../helpers/test.ts';

const SECRET = 'sk_test_dummy';

dbTest('cron: pays eligible KYC-complete users above min, skips others', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();

    // A: eligible — KYC complete + R 800 balance
    const A = await registerUser(app);
    const refA = await registerUser(app);
    await seedReferralEarning(A.user_id, refA.user_id, 80_000);
    await completeKyc(A.user_id, { bank_account_number: '1111111111' });

    // B: balance OK but KYC incomplete (no bank fields)
    const B = await registerUser(app);
    const refB = await registerUser(app);
    await seedReferralEarning(B.user_id, refB.user_id, 60_000);

    // C: KYC complete but balance below min (R 100 < R 500)
    const C = await registerUser(app);
    const refC = await registerUser(app);
    await seedReferralEarning(C.user_id, refC.user_id, 10_000);
    await completeKyc(C.user_id);

    const r = await runMonthlyPayouts({ period: '2026-05' });
    assertEquals(r.dispatched, 1, 'only A should be paid');
    assertEquals(r.failed, 0);
    // B is filtered out by the SQL eligibility query, so it doesn't count as
    // skippedKyc — the loop's KYC re-check only runs on rows the SQL passed.
    // C is filtered the same way.

    // Paystack stub saw exactly 1 recipient + 1 transfer.
    assertEquals(stub.recipientCount(), 1);
    assertEquals(stub.transferCount(), 1);

    // Payout row was created and marked approved.
    const payouts = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) => {
        return await tx<{
          id: string;
          user_id: string;
          status: string;
          payout_period: string;
          paystack_transfer_code: string | null;
          auto_generated: boolean;
        }[]>`
          select id, user_id, status, payout_period, paystack_transfer_code, auto_generated
          from payout_requests
        `;
      },
    );
    assertEquals(payouts.length, 1);
    assertEquals(payouts[0]!.user_id, A.user_id);
    assertEquals(payouts[0]!.status, 'approved');
    assertEquals(payouts[0]!.payout_period, '2026-05');
    assertEquals(payouts[0]!.auto_generated, true);
    assertExists(payouts[0]!.paystack_transfer_code);
  } finally {
    stub.restore();
  }
});

dbTest('cron: idempotent — running twice for the same period only pays once', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const A = await registerUser(app);
    const ref = await registerUser(app);
    await seedReferralEarning(A.user_id, ref.user_id, 60_000);
    await completeKyc(A.user_id);

    const r1 = await runMonthlyPayouts({ period: '2026-05' });
    assertEquals(r1.dispatched, 1);
    assertEquals(stub.transferCount(), 1);

    // The SQL eligibility filter naturally excludes the user once a live
    // payout for the period exists (available = earnings - pending = 0).
    // dispatched + skippedAlreadyPaid both stay at 0, but crucially: no
    // additional Paystack call.
    const r2 = await runMonthlyPayouts({ period: '2026-05' });
    assertEquals(r2.dispatched, 0);
    assertEquals(r2.failed, 0);
    assertEquals(stub.transferCount(), 1, 'second run does not call Paystack');
  } finally {
    stub.restore();
  }
});

dbTest('cron: caches the Paystack recipient code on kyc_profiles after first run', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const A = await registerUser(app);
    const ref = await registerUser(app);
    await seedReferralEarning(A.user_id, ref.user_id, 60_000);
    await completeKyc(A.user_id);

    await runMonthlyPayouts({ period: '2026-05' });

    const rows = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) => {
        return await tx<{ paystack_recipient_code: string | null }[]>`
          select paystack_recipient_code from kyc_profiles where user_id = ${A.user_id}
        `;
      },
    );
    assertExists(rows[0]?.paystack_recipient_code);
    assertEquals(stub.recipientCount(), 1);

    // Run again for next period — recipient should be reused, not recreated.
    const ref2 = await registerUser(app);
    await seedReferralEarning(A.user_id, ref2.user_id, 60_000);
    await runMonthlyPayouts({ period: '2026-06' });
    assertEquals(stub.recipientCount(), 1, 'recipient cached');
    assertEquals(stub.transferCount(), 2);
  } finally {
    stub.restore();
  }
});

dbTest('cron: marks payout rejected when Paystack transfer fails', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub({
    transfer: () => {
      throw new Error('test_simulated_failure');
    },
  });
  try {
    const app = await bootTestApp();
    const A = await registerUser(app);
    const ref = await registerUser(app);
    await seedReferralEarning(A.user_id, ref.user_id, 60_000);
    await completeKyc(A.user_id);

    const r = await runMonthlyPayouts({ period: '2026-05' });
    assertEquals(r.dispatched, 0);
    assertEquals(r.failed, 1);

    const payouts = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) => {
        return await tx<{ status: string; failure_reason: string | null }[]>`
          select status, failure_reason from payout_requests where user_id = ${A.user_id}
        `;
      },
    );
    assertEquals(payouts[0]!.status, 'rejected');
  } finally {
    stub.restore();
  }
});

dbTest('webhook: transfer.success flips approved → paid', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const A = await registerUser(app);
    const ref = await registerUser(app);
    await seedReferralEarning(A.user_id, ref.user_id, 60_000);
    await completeKyc(A.user_id);

    await runMonthlyPayouts({ period: '2026-05' });

    const before = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) =>
        await tx<{ paystack_transfer_code: string; status: string }[]>`
          select paystack_transfer_code, status from payout_requests
          where user_id = ${A.user_id}
        `,
    );
    const tcode = before[0]!.paystack_transfer_code;
    assertEquals(before[0]!.status, 'approved');

    const event = JSON.stringify({
      event: 'transfer.success',
      data: { id: 999_999, transfer_code: tcode, reference: 'po_test' },
    });
    const sig = await signPaystackBody(SECRET, event);
    const wh = await app.request('POST', '/webhooks/paystack', {
      rawBody: event,
      contentType: 'application/json',
      headers: { 'x-paystack-signature': sig },
    });
    assertEquals(wh.status, 200);

    const after = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) =>
        await tx<{ status: string; processed_at: Date | null }[]>`
          select status, processed_at from payout_requests where user_id = ${A.user_id}
        `,
    );
    assertEquals(after[0]!.status, 'paid');
    assertExists(after[0]!.processed_at);
  } finally {
    stub.restore();
  }
});

dbTest('webhook: transfer.failed flips approved → rejected with reason', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const A = await registerUser(app);
    const ref = await registerUser(app);
    await seedReferralEarning(A.user_id, ref.user_id, 60_000);
    await completeKyc(A.user_id);
    await runMonthlyPayouts({ period: '2026-05' });

    const row = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) =>
        await tx<{ paystack_transfer_code: string }[]>`
          select paystack_transfer_code from payout_requests where user_id = ${A.user_id}
        `,
    );
    const tcode = row[0]!.paystack_transfer_code;

    const event = JSON.stringify({
      event: 'transfer.failed',
      data: {
        id: 12121,
        transfer_code: tcode,
        reference: 'po_test',
        reason: 'invalid_recipient',
      },
    });
    const sig = await signPaystackBody(SECRET, event);
    await app.request('POST', '/webhooks/paystack', {
      rawBody: event,
      contentType: 'application/json',
      headers: { 'x-paystack-signature': sig },
    });

    const after = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) =>
        await tx<{ status: string; failure_reason: string | null }[]>`
          select status, failure_reason from payout_requests where user_id = ${A.user_id}
        `,
    );
    assertEquals(after[0]!.status, 'rejected');
    assertEquals(after[0]!.failure_reason, 'invalid_recipient');
  } finally {
    stub.restore();
  }
});
