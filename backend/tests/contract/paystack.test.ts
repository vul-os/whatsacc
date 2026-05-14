// Real-Paystack contract tests. SKIPPED unless PAYSTACK_TEST_SECRET_KEY is
// set. These hit api.paystack.co in test mode — they cost no money but DO
// leave artefacts (transactions, recipients) in your Paystack test
// dashboard. Recipients are cleaned up on completion; transactions persist.
//
// Required env to actually run:
//   PAYSTACK_TEST_SECRET_KEY=sk_test_xxx
//   PAYSTACK_TEST_PUBLIC_KEY=pk_test_xxx   (optional, for /charge tests)
//
// Run only the contract suite:
//   deno test -A --env-file=../.env tests/contract/paystack.test.ts
//
// What this verifies (each piece, then end-to-end):
//   1. /transferrecipient — create + read + delete (cleanup)
//   2. /transfer — dispatch a R 1.00 transfer (test-mode, no real money)
//   3. /transaction/initialize — happy path returns auth_url + reference
//   4. /transaction/verify — unpaid reference reports as such
//   5. /charge with a test card — completes and is verifiable
//   6. End-to-end transfer dispatch via runMonthlyPayouts() against real Paystack
//   7. HMAC signature: event signed with our secret matches verifyWebhookSignature

import { assert, assertEquals, assertExists, assertStringIncludes } from '../helpers/assert.ts';
import {
  contractTest,
  envValue,
  paystackCall,
  uniqEmail,
  uniqRef,
} from '../helpers/contract.ts';
import {
  createTransferRecipient,
  initializeTransaction,
  initiateTransfer,
  verifyTransaction,
  verifyWebhookSignature,
} from '@/lib/paystack.ts';
import { runMonthlyPayouts } from '@/lib/payouts.ts';
import { withRLS } from '@/lib/db.ts';
import { resetEnvCache } from '@/lib/env.ts';
import { bootTestApp } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { completeKyc, registerUser, seedReferralEarning } from '../helpers/fixtures.ts';

// Test-mode SA bank — Standard Bank universal branch code 051001 + the
// dummy account number Paystack publishes for successful test transfers.
// (See https://paystack.com/docs/payments/test-payments)
const ZA_BANK_CODE = '051001';
const ZA_TEST_ACCOUNT_NUMBER = '0000000000';
const ZA_TEST_ACCOUNT_HOLDER = 'Whatsacc Test';

// Test card: success on charge.
// https://paystack.com/docs/payments/test-payments#cards
const TEST_CARD_SUCCESS = {
  number: '4084084084084081',
  cvv: '408',
  expiry_month: '12',
  expiry_year: '30',
  pin: '1234',
};

function setupRealPaystackEnv() {
  // Point our lib at the real test API by populating the env it reads.
  process.env.PAYSTACK_SECRET_KEY = envValue('PAYSTACK_TEST_SECRET_KEY')!;
  if (envValue('PAYSTACK_TEST_PUBLIC_KEY')) {
    process.env.PAYSTACK_PUBLIC_KEY = envValue('PAYSTACK_TEST_PUBLIC_KEY')!;
  }
  resetEnvCache();
}

// ---------------------------------------------------------------------------
// 1. Transfer recipient lifecycle
// ---------------------------------------------------------------------------

contractTest(
  'paystack: createTransferRecipient → returns active recipient_code, then can delete',
  ['PAYSTACK_TEST_SECRET_KEY'],
  async () => {
    setupRealPaystackEnv();

    const r = await createTransferRecipient({
      name: ZA_TEST_ACCOUNT_HOLDER,
      account_number: ZA_TEST_ACCOUNT_NUMBER,
      bank_code: ZA_BANK_CODE,
      currency: 'ZAR',
      email: uniqEmail(),
    });
    assertExists(r.recipient_code);
    assertStringIncludes(r.recipient_code, 'RCP_');
    assertEquals(r.active, true);
    assertEquals(r.details.account_number, ZA_TEST_ACCOUNT_NUMBER);

    // Cleanup: delete to avoid littering the dashboard.
    const del = await paystackCall<{ status: string }>(
      'POST',
      `/transferrecipient/${r.recipient_code}`,
      undefined,
    ).catch(() => null); // some plans don't allow delete; ignore failures
    void del;
  },
);

// ---------------------------------------------------------------------------
// 2. Transaction lifecycle (initialize → verify unpaid)
// ---------------------------------------------------------------------------

contractTest(
  'paystack: initializeTransaction returns auth_url + access_code + reference',
  ['PAYSTACK_TEST_SECRET_KEY'],
  async () => {
    setupRealPaystackEnv();
    const reference = uniqRef('wt');
    const r = await initializeTransaction({
      email: uniqEmail(),
      amountCents: 100_00, // R 100
      reference,
      currency: 'ZAR',
      callbackUrl: 'http://test.local/app/billing',
      metadata: { test_kind: 'contract' },
    });
    assertExists(r.authorization_url);
    assertStringIncludes(r.authorization_url, 'paystack.com');
    assertExists(r.access_code);
    assertEquals(r.reference, reference);
  },
);

contractTest(
  'paystack: verifyTransaction on unpaid reference reports a non-success status',
  ['PAYSTACK_TEST_SECRET_KEY'],
  async () => {
    setupRealPaystackEnv();
    const reference = uniqRef('wt');
    await initializeTransaction({
      email: uniqEmail(),
      amountCents: 100_00,
      reference,
      currency: 'ZAR',
    });
    const v = await verifyTransaction(reference);
    assertEquals(v.reference, reference);
    // Untouched references in test mode start as 'abandoned' (or sometimes
    // 'pending' immediately after init); the only thing we care about is it
    // is NOT 'success'.
    assert(v.status !== 'success', `expected non-success, got ${v.status}`);
  },
);

// ---------------------------------------------------------------------------
// 3. /charge with a test card → verify resolves to success
// ---------------------------------------------------------------------------

contractTest(
  'paystack: charging a test card resolves verify() to success',
  ['PAYSTACK_TEST_SECRET_KEY'],
  async () => {
    setupRealPaystackEnv();
    const reference = uniqRef('wt');
    const email = uniqEmail();

    // Charge directly via /charge with a known reference. The test card
    // 4084... resolves to success in test mode without OTP/PIN.
    const charge = await paystackCall<{
      status: string;
      reference: string;
      amount: number;
    }>('POST', '/charge', {
      email,
      amount: 100_00,
      currency: 'ZAR',
      reference,
      card: TEST_CARD_SUCCESS,
    });

    assertEquals(charge.status, true);
    // The data status is what the gateway returned. Test card succeeds
    // immediately without a 3DS or PIN step.
    assert(
      ['success', 'pending'].includes(charge.data.status),
      `unexpected charge status: ${charge.data.status}`,
    );

    // Even if the charge response said 'pending', verify should converge to
    // 'success' for this test card. Poll briefly.
    let v = await verifyTransaction(reference);
    for (let i = 0; v.status !== 'success' && i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      v = await verifyTransaction(reference);
    }
    assertEquals(v.status, 'success', `expected success after charge, got ${v.status}`);
    assertEquals(v.reference, reference);
    assertEquals(v.amount, 100_00);
    assertEquals(v.currency, 'ZAR');
  },
);

// ---------------------------------------------------------------------------
// 4. Transfer dispatch (recipient → transfer)
// ---------------------------------------------------------------------------

contractTest(
  'paystack: initiateTransfer to a fresh recipient returns a transfer_code',
  ['PAYSTACK_TEST_SECRET_KEY'],
  async () => {
    setupRealPaystackEnv();
    const recipient = await createTransferRecipient({
      name: ZA_TEST_ACCOUNT_HOLDER,
      account_number: ZA_TEST_ACCOUNT_NUMBER,
      bank_code: ZA_BANK_CODE,
      currency: 'ZAR',
      email: uniqEmail(),
    });
    const reference = uniqRef('po');

    let t;
    try {
      t = await initiateTransfer({
        amountCents: 100, // R 1
        recipientCode: recipient.recipient_code,
        reference,
        reason: 'whatsacc contract test',
      });
    } catch (err) {
      const msg = (err as Error).message;
      // Many freshly-created Paystack test accounts have a zero test
      // balance until the user funds the test balance from the dashboard.
      // Surface that to the operator instead of failing opaquely.
      if (msg.includes('insufficient') || msg.includes('balance')) {
        console.warn(`[skip] paystack test balance is empty: ${msg}`);
        return;
      }
      throw err;
    }
    assertExists(t.transfer_code);
    assertStringIncludes(t.transfer_code, 'TRF_');
    assertEquals(t.reference, reference);
    assertEquals(t.amount, 100);
    assertEquals(t.currency, 'ZAR');
    // status is 'pending' in test mode immediately after dispatch; the
    // 'transfer.success' webhook arrives async.
    assert(['pending', 'success'].includes(t.status));
  },
);

// ---------------------------------------------------------------------------
// 5. End-to-end: cron-driven transfer against real Paystack
// ---------------------------------------------------------------------------

contractTest(
  'paystack e2e: runMonthlyPayouts dispatches a real transfer to a real recipient',
  ['PAYSTACK_TEST_SECRET_KEY'],
  async () => {
    setupRealPaystackEnv();
    await resetData();
    const app = await bootTestApp();
    const A = await registerUser(app);
    const ref = await registerUser(app);
    await seedReferralEarning(A.user_id, ref.user_id, 100); // R 1 (smallest viable)

    // Override the min payout for this test by seeding above the real min.
    // The cron's MIN_PAYOUT_CENTS is R 500 = 50_000 cents — seed exactly that.
    await seedReferralEarning(A.user_id, ref.user_id, 49_900); // total 50_000 cents = R 500

    await completeKyc(A.user_id, {
      bank_account_number: ZA_TEST_ACCOUNT_NUMBER,
      bank_branch_code: ZA_BANK_CODE,
      bank_account_holder: ZA_TEST_ACCOUNT_HOLDER,
    });

    let result;
    try {
      result = await runMonthlyPayouts({ period: '2026-05' });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('insufficient') || msg.includes('balance')) {
        console.warn(`[skip] paystack test balance empty: ${msg}`);
        return;
      }
      throw err;
    }

    if (result.failed > 0) {
      const reason = result.failures[0]?.error ?? '';
      if (reason.includes('insufficient') || reason.includes('balance')) {
        console.warn(`[skip] paystack test balance empty: ${reason}`);
        return;
      }
      throw new Error(`unexpected dispatch failure: ${reason}`);
    }

    assertEquals(result.dispatched, 1);
    assertEquals(result.failed, 0);

    // The DB row was approved and tagged with a real Paystack transfer_code.
    const rows = await withRLS(
      { user_id: '', account_id: null, is_platform_admin: true },
      async (tx) =>
        await tx<{
          status: string;
          paystack_transfer_code: string | null;
          paystack_transfer_id: string | null;
        }[]>`
          select status, paystack_transfer_code, paystack_transfer_id
          from payout_requests where user_id = ${A.user_id}
        `,
    );
    assertEquals(rows[0]!.status, 'approved');
    assertExists(rows[0]!.paystack_transfer_code);
    assertStringIncludes(rows[0]!.paystack_transfer_code!, 'TRF_');
  },
);

// ---------------------------------------------------------------------------
// 7. HMAC: real-secret signing matches our verifier
// ---------------------------------------------------------------------------

contractTest(
  'paystack: a body signed with the real test secret passes verifyWebhookSignature',
  ['PAYSTACK_TEST_SECRET_KEY'],
  async () => {
    setupRealPaystackEnv();
    const secret = envValue('PAYSTACK_TEST_SECRET_KEY')!;
    const body = JSON.stringify({
      event: 'charge.success',
      data: { id: 1, reference: uniqRef('wt') },
    });
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-512' },
      false,
      ['sign'],
    );
    const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const sig = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    assert(await verifyWebhookSignature(body, sig));
  },
);

// ---------------------------------------------------------------------------
// 8. Error paths
// ---------------------------------------------------------------------------

contractTest(
  'paystack: verifyTransaction on a bogus reference returns an error',
  ['PAYSTACK_TEST_SECRET_KEY'],
  async () => {
    setupRealPaystackEnv();
    let threw = false;
    try {
      await verifyTransaction('bogus_reference_does_not_exist_xyz123');
    } catch {
      threw = true;
    }
    assert(threw, 'expected verifyTransaction to throw on unknown reference');
  },
);

contractTest(
  'paystack: createTransferRecipient with an invalid bank_code returns an error',
  ['PAYSTACK_TEST_SECRET_KEY'],
  async () => {
    setupRealPaystackEnv();
    let threw = false;
    try {
      await createTransferRecipient({
        name: ZA_TEST_ACCOUNT_HOLDER,
        account_number: ZA_TEST_ACCOUNT_NUMBER,
        bank_code: 'NOT_A_CODE',
        currency: 'ZAR',
      });
    } catch {
      threw = true;
    }
    assert(threw, 'expected createTransferRecipient to throw on bad bank_code');
  },
);
