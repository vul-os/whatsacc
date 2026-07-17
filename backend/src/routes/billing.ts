import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, getUser, type AppEnv } from '../middleware/auth.ts';
import { withUserDb, withAnonDb } from '../middleware/rls.ts';
import { BadRequest, Forbidden, NotFound } from '../lib/errors.ts';
import { getEnv } from '../lib/env.ts';
import {
  chargeAuthorization,
  initializeTransaction,
  newReference,
  verifyTransaction,
  verifyWebhookSignature,
  type PaystackVerifyData,
} from '../lib/paystack.ts';
import type { JSONValue, TxSql } from '../lib/db.ts';
import { regionForCountry, REGIONS, type RegionCode } from '../lib/billing/tiers.ts';
import {
  buildInvoicePdf,
  createInvoice,
  vatBreakdown,
  type InvoiceRow,
} from '../lib/invoice.ts';

const topupSchema = z
  .object({
    account_id: z.string().uuid(),
    amount_cents: z.number().int().positive().max(10_000_000), // ZAR 100k cap
    callback_path: z.string().regex(/^\/[\w\-/?=&%]*$/).optional(),
  })
  .strict();

const verifyQuerySchema = z.object({ reference: z.string().min(8).max(120) });

type IntentRow = {
  id: string;
  account_id: string;
  purpose: string;
  status: 'pending' | 'succeeded' | 'failed' | 'abandoned';
  amount_cents: string | number;
  currency: string;
  credited_tx_id: string | null;
};

async function createWalletTopupInvoice(tx: TxSql, intent: IntentRow): Promise<string> {
  const total = Number(intent.amount_cents);
  const vat = vatBreakdown(total);
  return await createInvoice({
    tx,
    account_id: intent.account_id,
    kind: 'wallet_topup',
    payment_intent_id: intent.id,
    total_cents: total,
    currency: intent.currency,
    line_items: [
      {
        description: 'Wallet top-up',
        quantity: 1,
        unit_cents: vat.subtotal_cents,
        line_cents: vat.subtotal_cents,
      },
    ],
  });
}

async function creditWalletForIntent(
  tx: TxSql,
  intent: IntentRow,
  verifyData: PaystackVerifyData,
): Promise<{ wallet_tx_id: string | null; already_credited: boolean }> {
  if (intent.credited_tx_id) {
    return { wallet_tx_id: intent.credited_tx_id, already_credited: true };
  }
  await tx`
    insert into wallets (account_id, balance_cents, currency)
    values (${intent.account_id}, ${Number(intent.amount_cents)}, ${intent.currency})
    on conflict (account_id) do update set
      balance_cents = wallets.balance_cents + excluded.balance_cents,
      updated_at = now()
  `;
  const [walletTx] = await tx<{ id: string }[]>`
    insert into wallet_transactions (account_id, delta_cents, reason, reference)
    values (${intent.account_id}, ${Number(intent.amount_cents)}, 'topup', ${verifyData.reference})
    returning id
  `;
  const walletTxId = walletTx!.id;
  await tx`
    update payment_intents
    set status = 'succeeded',
        completed_at = now(),
        raw_verify = ${tx.json(verifyData as unknown as JSONValue)},
        credited_tx_id = ${walletTxId},
        updated_at = now()
    where id = ${intent.id}
  `;
  const auth = verifyData.authorization;
  await tx`
    update accounts
    set
      paystack_customer_code = coalesce(paystack_customer_code, ${verifyData.customer?.customer_code ?? null}),
      paystack_authorization_code = coalesce(
        paystack_authorization_code,
        ${auth?.reusable ? (auth.authorization_code ?? null) : null}
      ),
      card_last4 = coalesce(card_last4, ${auth?.last4 ?? null}),
      card_brand = coalesce(card_brand, ${auth?.brand ?? auth?.card_type ?? null})
    where id = ${intent.account_id}
  `;
  await createWalletTopupInvoice(tx, intent);
  return { wallet_tx_id: walletTxId, already_credited: false };
}

function billingRouter() {
  const app = new Hono<AppEnv>();

  // Public: list pricing tiers for a region (resolved from country code or
  // explicit region). Used by the marketing pricing page and the in-app upgrade
  // modal. No auth — pricing should be discoverable.
  const tiersQuerySchema = z.object({
    country: z.string().length(2).optional(),
    region: z.enum(['us-ca', 'eu-west', 'za', 'latam', 'in-sea']).optional(),
  });
  app.get('/tiers', zValidator('query', tiersQuerySchema), async (c) => {
    const { country, region: explicit } = c.req.valid('query');
    const region: RegionCode = explicit ?? regionForCountry(country ?? null);
    const r = REGIONS[region];
    return c.json({
      region: r.code,
      region_name: r.name,
      currency: r.currency,
      countries: r.countries,
      payg_open_price: r.paygOpenPriceLocal,
      tiers: r.tiers.map((t) => ({
        code: t.code,
        name: t.name,
        price: t.priceLocal,
        currency: r.currency,
        included_opens: t.opensPerMonth,
        included_residents: t.residents,
        included_devices: t.devices,
        included_locations: t.locations,
        web_portal: t.webPortal,
        blurb: t.blurb,
      })),
    });
  });

  // All other routes below require auth.
  app.use('*', requireAuth());

  app.get('/accounts/:id/billing', async (c) => {
    const id = c.req.param('id');
    const data = await withUserDb(c, async (tx) => {
      const subRows = await tx<{
        plan_code: string;
        status: string;
        current_period_start: Date | null;
        current_period_end: Date | null;
      }[]>`
        select p.code as plan_code, s.status, s.current_period_start, s.current_period_end
        from account_subscriptions s
        join plans p on p.id = s.plan_id
        where s.account_id = ${id}
      `;
      const walletRows = await tx<{ balance_cents: string; currency: string }[]>`
        select balance_cents::text as balance_cents, currency from wallets where account_id = ${id}
      `;
      const cardRows = await tx<{
        card_last4: string | null;
        card_brand: string | null;
        has_authorization: boolean;
      }[]>`
        select card_last4, card_brand,
               (paystack_authorization_code is not null) as has_authorization
        from accounts where id = ${id}
      `;
      const intents = await tx<{
        id: string;
        amount_cents: string;
        currency: string;
        status: string;
        created_at: Date;
        completed_at: Date | null;
        provider_reference: string;
        invoice_id: string | null;
      }[]>`
        select pi.id, pi.amount_cents::text as amount_cents, pi.currency, pi.status,
               pi.created_at, pi.completed_at, pi.provider_reference,
               i.id as invoice_id
        from payment_intents pi
        left join invoices i on i.payment_intent_id = pi.id
        where pi.account_id = ${id}
        order by pi.created_at desc
        limit 20
      `;
      return {
        subscription: subRows[0] ?? null,
        wallet: walletRows[0]
          ? {
              balance_cents: Number(walletRows[0].balance_cents),
              currency: walletRows[0].currency,
            }
          : null,
        payment_method: cardRows[0]
          ? {
              card_last4: cardRows[0].card_last4,
              card_brand: cardRows[0].card_brand,
              has_authorization: Boolean(cardRows[0].has_authorization),
            }
          : null,
        recent_intents: intents.map((it) => ({
          ...it,
          amount_cents: Number(it.amount_cents),
          invoice_id: it.invoice_id ?? null,
        })),
      };
    });
    if (!data.subscription && !data.wallet) throw NotFound('account_billing_not_found');
    return c.json(data);
  });

  const changePlanSchema = z.object({ plan_code: z.string().min(1) }).strict();
  const subCheckoutSchema = z.object({ plan_code: z.string().min(1) }).strict();

  // Switch plan. For paid plans the saved card is charged directly via
  // Paystack charge_authorization. Wallet is NOT touched — it is usage-only.
  app.post('/accounts/:id/plan', zValidator('json', changePlanSchema), async (c) => {
    const id = c.req.param('id');
    const { plan_code } = c.req.valid('json');
    const user = getUser(c);

    // ── Step 1: validate, reserve intent row (if paid) ──────────────────
    const ctx = await withUserDb(c, async (tx) => {
      const adminCheck = await tx<{ ok: boolean }[]>`
        select app.is_account_admin(${id}) as ok
      `;
      if (!adminCheck[0]?.ok) throw Forbidden('not_account_admin');

      const planRows = await tx<{ id: string; price_cents: number; currency: string; name: string }[]>`
        select p.id, p.price_cents::int as price_cents, p.currency, p.name
        from plans p
        join wallets w on w.currency = p.currency and w.account_id = ${id}
        where p.code = ${plan_code}
        limit 1
      `;
      if (!planRows[0]) throw BadRequest('plan_not_found', `Plan '${plan_code}' not found`);
      const plan = planRows[0];

      const subRows = await tx<{ id: string; plan_code: string }[]>`
        select s.id, p.code as plan_code
        from account_subscriptions s
        join plans p on p.id = s.plan_id
        where s.account_id = ${id}
      `;
      if (!subRows[0]) throw NotFound('subscription_not_found');
      if (subRows[0].plan_code === plan_code) throw BadRequest('already_on_plan');

      let intentId: string | null = null;
      let authCode: string | null = null;
      let reference: string | null = null;

      if (plan.price_cents > 0) {
        const cardRows = await tx<{ paystack_authorization_code: string | null }[]>`
          select paystack_authorization_code from accounts where id = ${id}
        `;
        authCode = cardRows[0]?.paystack_authorization_code ?? null;
        if (!authCode) throw BadRequest('card_required', 'No saved card. Use subscription-checkout to add one.');

        reference = newReference('sp');
        const [intentRow] = await tx<{ id: string }[]>`
          insert into payment_intents
            (account_id, initiated_by, provider, provider_reference, purpose, amount_cents, currency, status)
          values
            (${id}, ${user.sub}, 'paystack', ${reference}, 'subscription',
             ${plan.price_cents}, ${plan.currency}, 'pending')
          returning id
        `;
        intentId = intentRow!.id;
      }

      return { plan, sub: subRows[0], intentId, authCode, reference };
    });

    // ── Step 2: charge the saved card. Reuse the intent's reference +
    //          authorization_code captured in step 1 so the intent row and
    //          the Paystack record share an identifier — the webhook then
    //          reconciles by reference. Previously this minted a *new*
    //          reference here and Paystack/webhook drifted out of sync. ────
    if (ctx.intentId && ctx.plan.price_cents > 0) {
      let charge: PaystackVerifyData;
      try {
        charge = await chargeAuthorization({
          email: user.email,
          amountCents: ctx.plan.price_cents,
          authorizationCode: ctx.authCode!,
          reference: ctx.reference!,
          currency: ctx.plan.currency,
          metadata: { purpose: 'subscription', plan_code, account_id: id },
        });
      } catch (err) {
        await withUserDb(c, async (tx) => {
          await tx`update payment_intents set status='failed', updated_at=now() where id=${ctx.intentId}`;
        });
        throw BadRequest('card_charge_failed', (err as Error).message);
      }

      if (charge.status !== 'success') {
        await withUserDb(c, async (tx) => {
          await tx`update payment_intents set status='failed', updated_at=now() where id=${ctx.intentId}`;
        });
        throw BadRequest('card_declined', charge.gateway_response ?? 'Card was declined.');
      }

      // ── Step 3: record success + activate subscription ───────────────
      const periodStart = new Date();
      const periodEnd = new Date(periodStart);
      periodEnd.setMonth(periodEnd.getMonth() + 1);

      await withUserDb(c, async (tx) => {
        await tx`
          update payment_intents
          set status='succeeded', completed_at=now(),
              raw_verify=${tx.json(charge as unknown as JSONValue)},
              updated_at=now()
          where id=${ctx.intentId}
        `;
        await createInvoice({
          tx,
          account_id: id,
          kind: 'subscription',
          payment_intent_id: ctx.intentId!,
          total_cents: ctx.plan.price_cents,
          currency: ctx.plan.currency,
          line_items: [{
            description: `${ctx.plan.name} subscription — ${periodStart.toISOString().slice(0,10)} to ${periodEnd.toISOString().slice(0,10)}`,
            quantity: 1,
            unit_cents: ctx.plan.price_cents,
            line_cents: ctx.plan.price_cents,
          }],
        });
        await tx`
          update account_subscriptions
          set plan_id=${ctx.plan.id}, status='active',
              current_period_start=${periodStart},
              current_period_end=${periodEnd},
              updated_at=now()
          where id=${ctx.sub.id}
        `;
      });

      return c.json({ plan_code, price_cents: ctx.plan.price_cents }, 200);
    }

    // ── Free plan: just update subscription, no charge ───────────────────
    await withUserDb(c, async (tx) => {
      await tx`
        update account_subscriptions
        set plan_id=${ctx.plan.id}, status='active',
            current_period_start=null, current_period_end=null,
            updated_at=now()
        where id=${ctx.sub.id}
      `;
    });

    return c.json({ plan_code, price_cents: 0 }, 200);
  });

  // For users with no saved card: initiate a Paystack hosted checkout to
  // collect the card and pay the first month. On return, the verify endpoint
  // activates the plan instead of crediting the wallet.
  app.post('/accounts/:id/subscription-checkout', zValidator('json', subCheckoutSchema), async (c) => {
    const id = c.req.param('id');
    const { plan_code } = c.req.valid('json');
    const env = getEnv();
    if (!env.PAYSTACK_SECRET_KEY) throw BadRequest('paystack_not_configured');
    const user = getUser(c);

    const { plan, intentId, reference } = await withUserDb(c, async (tx) => {
      const adminCheck = await tx<{ ok: boolean }[]>`select app.is_account_admin(${id}) as ok`;
      if (!adminCheck[0]?.ok) throw Forbidden('not_account_admin');

      const planRows = await tx<{ id: string; price_cents: number; currency: string; name: string }[]>`
        select p.id, p.price_cents::int as price_cents, p.currency, p.name
        from plans p
        join wallets w on w.currency = p.currency and w.account_id = ${id}
        where p.code = ${plan_code}
        limit 1
      `;
      if (!planRows[0]) throw BadRequest('plan_not_found', `Plan '${plan_code}' not found`);
      if (planRows[0].price_cents === 0) throw BadRequest('plan_is_free', 'Free plan does not need checkout.');

      const ref = newReference('sc');
      const [intentRow] = await tx<{ id: string }[]>`
        insert into payment_intents
          (account_id, initiated_by, provider, provider_reference, purpose, amount_cents, currency, status)
        values
          (${id}, ${user.sub}, 'paystack', ${ref}, 'subscription',
           ${planRows[0].price_cents}, ${planRows[0].currency}, 'pending')
        returning id
      `;
      return { plan: planRows[0], intentId: intentRow!.id, reference: ref };
    });

    const callbackUrl = env.PAYSTACK_CALLBACK_URL ?? `${env.APP_PUBLIC_URL}/app/billing`;
    let init;
    try {
      init = await initializeTransaction({
        email: user.email,
        amountCents: plan.price_cents,
        reference,
        currency: plan.currency,
        callbackUrl,
        metadata: {
          account_id: id,
          intent_id: intentId,
          purpose: 'subscription',
          plan_code,
          initiated_by: user.sub,
        },
      });
    } catch (err) {
      // Paystack rejected the request (bad email, rate limited, dead key, etc).
      // Mark the intent failed so it doesn't dangle, and surface a clean 400
      // to the UI instead of a generic 500.
      await withAnonDb(async (tx) => {
        await tx`update payment_intents set status='failed', updated_at=now() where id=${intentId}`;
      });
      throw BadRequest(
        'payment_init_failed',
        (err as Error).message || 'Payment provider rejected the request.',
      );
    }

    await withAnonDb(async (tx) => {
      await tx`
        update payment_intents
        set authorization_url=${init.authorization_url}, access_code=${init.access_code},
            raw_init=${tx.json({ ...init } as unknown as JSONValue)}, updated_at=now()
        where id=${intentId}
      `;
    });

    // Store plan_code in sessionStorage is handled client-side; server also
    // carries it in Paystack metadata for redundancy.
    return c.json({ intent_id: intentId, reference, authorization_url: init.authorization_url, access_code: init.access_code }, 201);
  });

  app.get('/accounts/:id/invoices', async (c) => {
    const id = c.req.param('id');
    const rows = await withUserDb(c, async (tx) => {
      return await tx<InvoiceRow[]>`
        select id, account_id, number, kind, payment_intent_id, currency,
               subtotal_cents, vat_rate_bps, vat_cents, total_cents,
               bill_to, issuer, line_items, status, issued_at, paid_at
        from invoices
        where account_id = ${id}
        order by issued_at desc
        limit 50
      `;
    });
    return c.json({
      invoices: rows.map((r) => ({
        id: r.id,
        number: r.number,
        kind: r.kind,
        currency: r.currency,
        subtotal_cents: Number(r.subtotal_cents),
        vat_rate_bps: r.vat_rate_bps,
        vat_cents: Number(r.vat_cents),
        total_cents: Number(r.total_cents),
        status: r.status,
        issued_at: r.issued_at,
        paid_at: r.paid_at,
      })),
    });
  });

  app.get('/invoices/:id.pdf', async (c) => {
    const id = c.req.param('id');
    const row = await withUserDb(c, async (tx) => {
      const rows = await tx<InvoiceRow[]>`
        select id, account_id, number, kind, payment_intent_id, currency,
               subtotal_cents, vat_rate_bps, vat_cents, total_cents,
               bill_to, issuer, line_items, status, issued_at, paid_at
        from invoices
        where id = ${id}
        limit 1
      `;
      return rows[0] ?? null;
    });
    if (!row) throw NotFound('invoice_not_found');
    const pdf = await buildInvoicePdf(row);
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${row.number}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

  // Initialize a Paystack hosted-checkout payment. Returns the redirect URL.
  app.post('/wallet/topup', zValidator('json', topupSchema), async (c) => {
    const env = getEnv();
    if (!env.PAYSTACK_SECRET_KEY) throw BadRequest('paystack_not_configured');

    const user = getUser(c);
    const { account_id, amount_cents, callback_path } = c.req.valid('json');
    const reference = newReference('wt');

    const callbackUrl =
      env.PAYSTACK_CALLBACK_URL ??
      `${env.APP_PUBLIC_URL}${callback_path ?? '/app/billing'}`;

    // 1. Authorize + reserve an intent row under the user's RLS context.
    //    Currency follows the account's region (us-ca → USD, za → ZAR, etc.).
    const intent = await withUserDb(c, async (tx) => {
      const ok = await tx<{ ok: boolean }[]>`
        select app.is_account_admin(${account_id}) as ok
      `;
      if (!ok[0]?.ok) throw Forbidden('not_account_admin');

      const emailRows = await tx<{ email: string }[]>`
        select email from users where id = ${user.sub}
      `;
      const email = emailRows[0]?.email;
      if (!email) throw NotFound('user_email_missing');

      const [row] = await tx<{ id: string }[]>`
        insert into payment_intents
          (account_id, initiated_by, provider, provider_reference,
           purpose, amount_cents, currency, status)
        values
          (${account_id}, ${user.sub}, 'paystack', ${reference},
           'wallet_topup', ${amount_cents}, 'ZAR', 'pending')
        returning id
      `;
      return { id: row!.id, email, currency: 'ZAR' };
    });

    // 2. Init the transaction with Paystack (network call after DB row exists,
    //    so reconciliation can fix orphaned intents later). Wrap so a
    //    provider rejection (bad email, dead key, rate-limit) surfaces as a
    //    400 with detail rather than a generic 500.
    let init;
    try {
      init = await initializeTransaction({
        email: intent.email,
        amountCents: amount_cents,
        reference,
        currency: intent.currency,
        callbackUrl,
        metadata: {
          account_id,
          intent_id: intent.id,
          purpose: 'wallet_topup',
          initiated_by: user.sub,
        },
      });
    } catch (err) {
      await withAnonDb(async (tx) => {
        await tx`update payment_intents set status='failed', updated_at=now() where id=${intent.id}`;
      });
      throw BadRequest(
        'payment_init_failed',
        (err as Error).message || 'Payment provider rejected the request.',
      );
    }

    await withAnonDb(async (tx) => {
      await tx`
        update payment_intents
        set authorization_url = ${init.authorization_url},
            access_code = ${init.access_code},
            raw_init = ${tx.json({ ...init } as unknown as JSONValue)},
            updated_at = now()
        where id = ${intent.id}
      `;
    });

    return c.json(
      {
        intent_id: intent.id,
        reference,
        authorization_url: init.authorization_url,
        access_code: init.access_code,
      },
      201,
    );
  });

  // Verify on redirect-back. Idempotent: runs the same credit path as the
  // webhook and short-circuits if already credited.
  app.get('/wallet/verify', zValidator('query', verifyQuerySchema), async (c) => {
    const { reference } = c.req.valid('query');
    let verifyData: PaystackVerifyData;
    try {
      verifyData = await verifyTransaction(reference);
    } catch (err) {
      // Paystack rejected the verify call (unknown reference, network blip,
      // dead key). Surface a 400 with the underlying message so the UI can
      // tell the user "payment not confirmed" instead of a blank 500.
      throw BadRequest(
        'verify_failed',
        (err as Error).message || 'Could not verify the payment.',
      );
    }

    const result = await withUserDb(c, async (tx) => {
      const rows = await tx<IntentRow[]>`
        select id, account_id, purpose, status, amount_cents, currency, credited_tx_id
        from payment_intents
        where provider = 'paystack' and provider_reference = ${reference}
        for update
      `;
      const intent = rows[0];
      if (!intent) throw NotFound('intent_not_found');

      if (verifyData.status !== 'success') {
        const next = verifyData.status === 'abandoned' ? 'abandoned' : 'failed';
        await tx`
          update payment_intents
          set status = ${next},
              raw_verify = ${tx.json(verifyData as unknown as JSONValue)},
              updated_at = now()
          where id = ${intent.id} and status = 'pending'
        `;
        return {
          status: next as 'failed' | 'abandoned',
          intent_id: intent.id,
          account_id: intent.account_id,
          amount_cents: Number(intent.amount_cents),
          currency: intent.currency,
          already_credited: false,
          plan_activated: null as string | null,
        };
      }

      // ── Subscription checkout: activate plan, save card, no wallet credit ──
      if (intent.purpose === 'subscription') {
        if (intent.credited_tx_id) {
          return {
            status: 'succeeded' as const,
            intent_id: intent.id,
            account_id: intent.account_id,
            amount_cents: Number(intent.amount_cents),
            currency: intent.currency,
            already_credited: true,
            plan_activated: null as string | null,
          };
        }

        const planCode = verifyData.metadata?.plan_code as string | undefined;
        if (!planCode) throw BadRequest('plan_code_missing', 'plan_code not found in Paystack metadata');

        const planRows = await tx<{ id: string; price_cents: number; name: string }[]>`
          select p.id, p.price_cents::int, p.name
          from plans p
          join wallets w on w.currency = p.currency and w.account_id = ${intent.account_id}
          where p.code = ${planCode}
          limit 1
        `;
        if (!planRows[0]) throw BadRequest('plan_not_found');

        const periodStart = new Date();
        const periodEnd = new Date(periodStart);
        periodEnd.setMonth(periodEnd.getMonth() + 1);

        // Mark intent succeeded (use credited_tx_id as an idempotency sentinel
        // even though no wallet transaction is created — we reuse the column
        // to store the subscription_id instead).
        await tx`
          update payment_intents
          set status='succeeded', completed_at=now(),
              raw_verify=${tx.json(verifyData as unknown as JSONValue)},
              updated_at=now()
          where id=${intent.id}
        `;

        // Save card details
        const auth = verifyData.authorization;
        await tx`
          update accounts
          set
            paystack_customer_code = coalesce(paystack_customer_code, ${verifyData.customer?.customer_code ?? null}),
            paystack_authorization_code = coalesce(paystack_authorization_code,
              ${auth?.reusable ? (auth.authorization_code ?? null) : null}),
            card_last4 = coalesce(card_last4, ${auth?.last4 ?? null}),
            card_brand = coalesce(card_brand, ${auth?.brand ?? auth?.card_type ?? null})
          where id=${intent.account_id}
        `;

        // Activate subscription
        await tx`
          update account_subscriptions
          set plan_id=${planRows[0].id}, status='active',
              current_period_start=${periodStart},
              current_period_end=${periodEnd},
              updated_at=now()
          where account_id=${intent.account_id}
        `;

        await createInvoice({
          tx,
          account_id: intent.account_id,
          kind: 'subscription',
          payment_intent_id: intent.id,
          total_cents: Number(intent.amount_cents),
          currency: intent.currency,
          line_items: [{
            description: `${planRows[0].name} subscription — ${periodStart.toISOString().slice(0,10)} to ${periodEnd.toISOString().slice(0,10)}`,
            quantity: 1,
            unit_cents: Number(intent.amount_cents),
            line_cents: Number(intent.amount_cents),
          }],
        });

        return {
          status: 'succeeded' as const,
          intent_id: intent.id,
          account_id: intent.account_id,
          amount_cents: Number(intent.amount_cents),
          currency: intent.currency,
          already_credited: false,
          plan_activated: planCode,
        };
      }

      // ── Wallet topup: credit wallet as before ───────────────────────────
      const credited = await creditWalletForIntent(tx, intent, verifyData);
      return {
        status: 'succeeded' as const,
        intent_id: intent.id,
        account_id: intent.account_id,
        amount_cents: Number(intent.amount_cents),
        currency: intent.currency,
        already_credited: credited.already_credited,
        plan_activated: null as string | null,
      };
    });

    return c.json(result);
  });

  return app;
}

export const billingRoutes = billingRouter();

// ---------------------------------------------------------------------------
// Webhook (mounted at /webhooks/paystack — anon, raw-body verification).
// ---------------------------------------------------------------------------
function webhookRouter() {
  const app = new Hono<AppEnv>();

  app.post('/webhooks/paystack', async (c) => {
    if (!getEnv().PAYSTACK_SECRET_KEY) {
      return c.json({ ok: false, error: 'paystack_not_configured' }, 503);
    }

    const signature = c.req.header('x-paystack-signature') ?? '';
    const raw = await c.req.text();
    const ok = await verifyWebhookSignature(raw, signature);
    if (!ok) return c.json({ ok: false, error: 'invalid_signature' }, 401);

    let body: { event?: string; data?: PaystackVerifyData & { id?: number } } = {};
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return c.json({ ok: false, error: 'invalid_json' }, 400);
    }

    const event = body.event ?? 'unknown';
    const data = body.data;
    if (!data) return c.json({ ok: false, error: 'missing_data' }, 400);

    const eventId = data.id ? String(data.id) : await sha256Hex(raw);

    await withAnonDb(async (tx) => {
      // 1. Insert dedupe row. If we've seen this event id, do nothing.
      const inserted = await tx<{ id: string }[]>`
        insert into webhook_events (provider, event_id, event_type, signature, payload)
        values ('paystack', ${eventId}, ${event}, ${signature}, ${tx.json(body as unknown as JSONValue)})
        on conflict (provider, event_id) do nothing
        returning id
      `;
      if (inserted.length === 0) return;

      const webhookRowId = inserted[0]!.id;

      try {
        if (event === 'charge.success' && data.reference) {
          // Re-verify against Paystack as defense-in-depth (forged-payload safety).
          const verifyData = await verifyTransaction(data.reference);
          if (verifyData.status === 'success') {
            const intentRows = await tx<IntentRow[]>`
              select id, account_id, purpose, status, amount_cents, currency, credited_tx_id
              from payment_intents
              where provider = 'paystack' and provider_reference = ${data.reference}
              for update
            `;
            const intent = intentRows[0];
            if (intent) {
              // Wallet credit applies only to wallet_topup intents. Subscription
              // intents are activated by the synchronous handler or the redirect
              // verify endpoint — crediting the wallet for those would be a
              // duplicate credit on top of the already-charged subscription.
              if (intent.purpose === 'wallet_topup') {
                await creditWalletForIntent(tx, intent, verifyData);
              } else if (intent.purpose === 'subscription') {
                // Just mark the intent succeeded for audit; the
                // verify-on-redirect path already activated the plan.
                await tx`
                  update payment_intents
                  set status = 'succeeded',
                      completed_at = coalesce(completed_at, now()),
                      raw_verify = ${tx.json(verifyData as unknown as JSONValue)},
                      updated_at = now()
                  where id = ${intent.id} and status = 'pending'
                `;
              }
            }
          }
        } else if (
          (event === 'charge.failed' || event === 'transaction.failed') &&
          data.reference
        ) {
          await tx`
            update payment_intents
            set status = 'failed',
                raw_verify = ${tx.json(body as unknown as JSONValue)},
                updated_at = now()
            where provider = 'paystack' and provider_reference = ${data.reference}
              and status = 'pending'
          `;
        } else if (event.startsWith('transfer.')) {
          // Settle the matching payout_request. Match by transfer_code (preferred)
          // then transfer id then reference.
          const transferData = data as unknown as {
            transfer_code?: string;
            id?: number;
            reference?: string;
            reason?: string;
          };
          const tcode = transferData.transfer_code ?? null;
          const tid = transferData.id ? String(transferData.id) : null;
          const tref = transferData.reference ?? null;

          let nextStatus: 'paid' | 'rejected' | 'pending' = 'pending';
          if (event === 'transfer.success') nextStatus = 'paid';
          else if (event === 'transfer.failed' || event === 'transfer.reversed') {
            nextStatus = 'rejected';
          }

          if (nextStatus !== 'pending') {
            await tx`
              update payout_requests
              set status = ${nextStatus},
                  processed_at = now(),
                  paystack_transfer_id = coalesce(paystack_transfer_id, ${tid}),
                  paystack_transfer_code = coalesce(paystack_transfer_code, ${tcode}),
                  failure_reason = case
                    when ${nextStatus} = 'rejected' then ${transferData.reason ?? event}
                    else failure_reason
                  end
              where (
                (${tcode}::text is not null and paystack_transfer_code = ${tcode})
                or (${tid}::text is not null and paystack_transfer_id = ${tid})
                or (${tref}::text is not null and ${tref} like 'po_%' and id::text = right(${tref}, 36))
              )
              and status in ('pending', 'approved')
            `;
          }
        }

        await tx`update webhook_events set processed_at = now() where id = ${webhookRowId}`;
      } catch (err) {
        await tx`
          update webhook_events
          set processed_at = now(), error = ${(err as Error).message}
          where id = ${webhookRowId}
        `;
        throw err;
      }
    });

    return c.json({ ok: true });
  });

  return app;
}

export const paystackWebhookRoutes = webhookRouter();

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
