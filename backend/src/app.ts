import { Hono } from 'hono';
import { cors } from 'hono/cors';
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

  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return origin;
        if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return origin;
        if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return origin;
        // Firebase Hosting — deployed sites + preview channels
        if (origin === 'https://whats-acc.web.app') return origin;
        if (origin === 'https://whats-acc-dev.web.app') return origin;
        if (/^https:\/\/whats-acc(-dev)?--[a-z0-9-]+\.web\.app$/.test(origin)) return origin;
        // Custom domains
        if (origin === 'https://whatsacc.com') return origin;
        if (origin === 'https://www.whatsacc.com') return origin;
        return null;
      },
      credentials: true,
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 86400,
    }),
  );

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
