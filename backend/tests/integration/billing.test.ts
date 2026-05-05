import { assert, assertEquals, assertExists } from '@std/assert';
import { bootTestApp } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { registerUser, signPaystackBody } from '../helpers/fixtures.ts';
import { installPaystackStub } from '../helpers/paystack-mock.ts';
import { dbTest } from '../helpers/test.ts';

const SECRET = 'sk_test_dummy';

dbTest('billing: topup → init returns authorization_url; verify credits wallet idempotently', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const u = await registerUser(app);

    const init = await app.request('POST', '/billing/wallet/topup', {
      token: u.access_token,
      json: { account_id: u.account_id, amount_cents: 100_00 },
    });
    assertEquals(init.status, 201);
    const initBody = init.body as { reference: string; authorization_url: string };
    assert(initBody.authorization_url.startsWith('https://checkout.paystack.com/'));
    assertEquals(stub.initializeCount(), 1);

    // First verify call: should credit the wallet.
    const v1 = await app.request('GET', '/billing/wallet/verify', {
      token: u.access_token,
      query: { reference: initBody.reference },
    });
    assertEquals(v1.status, 200);
    const v1Body = v1.body as { status: string; already_credited: boolean };
    assertEquals(v1Body.status, 'succeeded');
    assertEquals(v1Body.already_credited, false);

    // Second verify call: idempotent — already credited.
    const v2 = await app.request('GET', '/billing/wallet/verify', {
      token: u.access_token,
      query: { reference: initBody.reference },
    });
    assertEquals(v2.status, 200);
    assertEquals((v2.body as { already_credited: boolean }).already_credited, true);

    // Wallet now reflects the topup.
    const billing = await app.request('GET', `/billing/accounts/${u.account_id}/billing`, {
      token: u.access_token,
    });
    assertEquals(billing.status, 200);
    const bb = billing.body as { wallet: { balance_cents: number; currency: string } };
    assertEquals(bb.wallet.balance_cents, 100_00);
    assertEquals(bb.wallet.currency, 'ZAR');
  } finally {
    stub.restore();
  }
});

dbTest('billing: webhook with valid signature credits wallet on charge.success', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const u = await registerUser(app);

    const init = await app.request('POST', '/billing/wallet/topup', {
      token: u.access_token,
      json: { account_id: u.account_id, amount_cents: 250_00 },
    });
    const ref = (init.body as { reference: string }).reference;

    const event = JSON.stringify({
      event: 'charge.success',
      data: { id: 9999, reference: ref, status: 'success' },
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
    assertEquals(
      (billing.body as { wallet: { balance_cents: number } }).wallet.balance_cents,
      250_00,
    );
  } finally {
    stub.restore();
  }
});

dbTest('billing: webhook with bad signature is rejected with 401', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const event = JSON.stringify({ event: 'charge.success', data: { id: 1 } });
    const wh = await app.request('POST', '/webhooks/paystack', {
      rawBody: event,
      contentType: 'application/json',
      headers: { 'x-paystack-signature': 'deadbeef' },
    });
    assertEquals(wh.status, 401);
  } finally {
    stub.restore();
  }
});

dbTest('billing: webhook is idempotent on duplicate event ids', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const u = await registerUser(app);
    const init = await app.request('POST', '/billing/wallet/topup', {
      token: u.access_token,
      json: { account_id: u.account_id, amount_cents: 50_00 },
    });
    const ref = (init.body as { reference: string }).reference;

    const event = JSON.stringify({
      event: 'charge.success',
      data: { id: 12345, reference: ref, status: 'success' },
    });
    const sig = await signPaystackBody(SECRET, event);
    const replay = async () =>
      app.request('POST', '/webhooks/paystack', {
        rawBody: event,
        contentType: 'application/json',
        headers: { 'x-paystack-signature': sig },
      });
    assertEquals((await replay()).status, 200);
    assertEquals((await replay()).status, 200);
    assertEquals((await replay()).status, 200);

    const billing = await app.request('GET', `/billing/accounts/${u.account_id}/billing`, {
      token: u.access_token,
    });
    assertEquals(
      (billing.body as { wallet: { balance_cents: number } }).wallet.balance_cents,
      50_00,
      'duplicate webhooks must not double-credit',
    );
  } finally {
    stub.restore();
  }
});

dbTest('billing: account billing endpoint requires authentication', async () => {
  await resetData();
  const app = await bootTestApp();
  const r = await app.request('GET', '/billing/accounts/00000000-0000-0000-0000-000000000000/billing');
  assertEquals(r.status, 401);
});

dbTest('billing: topup is admin-gated for the target account', async () => {
  await resetData();
  Deno.env.set('PAYSTACK_SECRET_KEY', SECRET);
  const stub = installPaystackStub();
  try {
    const app = await bootTestApp();
    const owner = await registerUser(app);
    const outsider = await registerUser(app);
    const r = await app.request('POST', '/billing/wallet/topup', {
      token: outsider.access_token,
      json: { account_id: owner.account_id, amount_cents: 50_00 },
    });
    assertEquals(r.status, 403);
    assertEquals((r.body as { error: string }).error, 'not_account_admin');
    assertEquals(stub.initializeCount(), 0, 'no Paystack call when authz fails');
  } finally {
    stub.restore();
  }
});

dbTest('billing: succeeded topup writes a referral_earning when referrer attribution exists', async () => {
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
      json: { account_id: referee.account_id, amount_cents: 1000_00 },
    });
    const ref = (init.body as { reference: string }).reference;
    await app.request('GET', '/billing/wallet/verify', {
      token: referee.access_token,
      query: { reference: ref },
    });

    const me = await app.request('GET', '/referrals/me', {
      token: referrer.access_token,
    });
    const meBody = me.body as {
      balance: { earned_cents: number };
      recent_earnings: Array<{ amount_zar_cents: number; rate_bps: number }>;
    };
    // 10% of R 1000 = R 100 = 10_000 cents
    assertEquals(meBody.balance.earned_cents, 100_00);
    assertEquals(meBody.recent_earnings.length, 1);
    assertEquals(meBody.recent_earnings[0]!.amount_zar_cents, 100_00);
    assertEquals(meBody.recent_earnings[0]!.rate_bps, 1000);
  } finally {
    stub.restore();
  }
});
