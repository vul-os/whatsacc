import { Hono } from 'hono';
import { getSql } from './lib/db.ts';
import { getEnv } from './lib/env.ts';
import type { AppEnv } from './middleware/auth.ts';
import { errorHandler } from './middleware/error.ts';
import { authRoutes } from './routes/auth.ts';
import { referenceRoutes } from './routes/reference.ts';
import { accountsRoutes } from './routes/accounts.ts';
import { locationsRoutes } from './routes/locations.ts';
import { accessRoutes } from './routes/access.ts';
import { devicesRoutes } from './routes/devices.ts';
import { phonesRoutes } from './routes/phones.ts';
import { whatsappRoutes } from './routes/whatsapp.ts';
import { billingRoutes, paystackWebhookRoutes } from './routes/billing.ts';
import { analyticsRoutes } from './routes/analytics.ts';
import { referralsRoutes } from './routes/referrals.ts';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.get('/', (c) => c.text('whatsacc'));

  app.get('/health', async (c) => {
    try {
      const sql = getSql();
      const rows = await sql<{ now: string }[]>`select now()`;
      return c.json({ ok: true, env: getEnv().APP_ENV, db_now: rows[0]?.now });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.route('/auth', authRoutes);
  app.route('/reference', referenceRoutes);
  app.route('/accounts', accountsRoutes);
  app.route('/locations', locationsRoutes);
  app.route('/access', accessRoutes);
  app.route('/devices', devicesRoutes);
  app.route('/phones', phonesRoutes);
  app.route('/billing', billingRoutes);
  app.route('/analytics', analyticsRoutes);
  app.route('/referrals', referralsRoutes);
  app.route('/', whatsappRoutes); // mounts /webhooks/whatsapp at root
  app.route('/', paystackWebhookRoutes); // mounts /webhooks/paystack at root

  return app;
}

export type AppType = ReturnType<typeof createApp>;
