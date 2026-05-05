import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, getUser, type AppEnv } from '../middleware/auth.ts';
import { withUserDb } from '../middleware/rls.ts';
import { NotFound } from '../lib/errors.ts';

const topupSchema = z
  .object({
    account_id: z.string().uuid(),
    amount_cents: z.number().int().positive(),
    reference: z.string().min(1).max(120).optional(),
  })
  .strict();

function billingRouter() {
  const app = new Hono<AppEnv>();
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
      const walletRows = await tx<{ balance_cents: number; currency: string }[]>`
        select balance_cents, currency from wallets where account_id = ${id}
      `;
      return {
        subscription: subRows[0] ?? null,
        wallet: walletRows[0] ?? null,
      };
    });
    if (!data.subscription && !data.wallet) throw NotFound('account_billing_not_found');
    return c.json(data);
  });

  // TODO: integrate Stripe checkout / payment intents. This stub credits the wallet directly.
  app.post('/wallet/topup', zValidator('json', topupSchema), async (c) => {
    const user = getUser(c);
    const { account_id, amount_cents, reference } = c.req.valid('json');
    const result = await withUserDb(c, async (tx) => {
      await tx`
        insert into wallets (account_id, balance_cents, currency)
        values (${account_id}, ${amount_cents}, 'USD')
        on conflict (account_id) do update set
          balance_cents = wallets.balance_cents + excluded.balance_cents,
          updated_at = now()
      `;
      const [tx_row] = await tx<{ id: string }[]>`
        insert into wallet_transactions (account_id, delta_cents, reason, reference)
        values (${account_id}, ${amount_cents}, 'topup', ${reference ?? user.sub})
        returning id
      `;
      return { id: tx_row!.id };
    });
    return c.json(result, 201);
  });

  return app;
}

export const billingRoutes = billingRouter();
