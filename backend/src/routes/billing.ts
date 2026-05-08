import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, getUser, type AppEnv } from '../middleware/auth.ts';
import { withUserDb, withAnonDb } from '../middleware/rls.ts';
import { BadRequest, Forbidden, NotFound } from '../lib/errors.ts';
import { getEnv } from '../lib/env.ts';
import {
  initializeTransaction,
  newReference,
  verifyTransaction,
  verifyWebhookSignature,
  type PaystackVerifyData,
} from '../lib/paystack.ts';
import type { JSONValue, TxSql } from '../lib/db.ts';
import { regionForCountry, REGIONS, type RegionCode } from '../lib/billing/tiers.ts';

const topupSchema = z
  .object({
    account_id: z.string().uuid(),
    amount_cents: z.number().int().positive().max(10_000_000), // ZAR 100k cap
    callback_path: z.string().regex(/^\/[\w\-/]*$/).optional(),
  })
  .strict();

const verifyQuerySchema = z.object({ reference: z.string().min(8).max(120) });

type IntentRow = {
  id: string;
  account_id: string;
  status: 'pending' | 'succeeded' | 'failed' | 'abandoned';
  amount_cents: string | number;
  currency: string;
  credited_tx_id: string | null;
};

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
  if (verifyData.customer?.customer_code) {
    await tx`
      update accounts
      set paystack_customer_code = coalesce(paystack_customer_code, ${verifyData.customer.customer_code})
      where id = ${intent.account_id}
    `;
  }
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
      const intents = await tx<{
        id: string;
        amount_cents: string;
        currency: string;
        status: string;
        created_at: Date;
        completed_at: Date | null;
        provider_reference: string;
      }[]>`
        select id, amount_cents::text as amount_cents, currency, status, created_at,
               completed_at, provider_reference
        from payment_intents
        where account_id = ${id}
        order by created_at desc
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
        recent_intents: intents.map((it) => ({
          ...it,
          amount_cents: Number(it.amount_cents),
        })),
      };
    });
    if (!data.subscription && !data.wallet) throw NotFound('account_billing_not_found');
    return c.json(data);
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

      const acctRows = await tx<{ country_code: string }[]>`
        select country_code from accounts where id = ${account_id}
      `;
      const country = acctRows[0]?.country_code ?? 'ZA';
      const region = regionForCountry(country);
      const currency = REGIONS[region].currency;

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
           'wallet_topup', ${amount_cents}, ${currency}, 'pending')
        returning id
      `;
      return { id: row!.id, email, currency };
    });

    // 2. Init the transaction with Paystack (network call after DB row exists,
    //    so reconciliation can fix orphaned intents later).
    const init = await initializeTransaction({
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
    const verifyData = await verifyTransaction(reference);

    const result = await withUserDb(c, async (tx) => {
      const rows = await tx<IntentRow[]>`
        select id, account_id, status, amount_cents, currency, credited_tx_id
        from payment_intents
        where provider = 'paystack' and provider_reference = ${reference}
        for update
      `;
      const intent = rows[0];
      if (!intent) throw NotFound('intent_not_found');

      if (verifyData.status === 'success') {
        const credited = await creditWalletForIntent(tx, intent, verifyData);
        return {
          status: 'succeeded' as const,
          intent_id: intent.id,
          account_id: intent.account_id,
          amount_cents: Number(intent.amount_cents),
          currency: intent.currency,
          already_credited: credited.already_credited,
        };
      }

      const next = verifyData.status === 'abandoned' ? 'abandoned' : 'failed';
      await tx`
        update payment_intents
        set status = ${next},
            raw_verify = ${tx.json(verifyData as unknown as JSONValue)},
            updated_at = now()
        where id = ${intent.id} and status = 'pending'
      `;
      return {
        status: next,
        intent_id: intent.id,
        account_id: intent.account_id,
        amount_cents: Number(intent.amount_cents),
        currency: intent.currency,
        already_credited: false,
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
              select id, account_id, status, amount_cents, currency, credited_tx_id
              from payment_intents
              where provider = 'paystack' and provider_reference = ${data.reference}
              for update
            `;
            const intent = intentRows[0];
            if (intent) {
              await creditWalletForIntent(tx, intent, verifyData);
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
