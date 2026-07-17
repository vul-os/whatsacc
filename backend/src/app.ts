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
import { telegramRoutes } from './routes/telegram.ts';
import { slackRoutes } from './routes/slack.ts';
import { analyticsRoutes } from './routes/analytics.ts';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return origin;
        // Browsers will sometimes send an FQDN-form Origin (`example.com.`)
        // when the user navigated with a trailing dot. Strip it before
        // matching so we don't blackhole otherwise-valid requests.
        const o = origin.replace(/\.$/, '');
        if (/^http:\/\/localhost(:\d+)?$/.test(o)) return origin;
        if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(o)) return origin;
        // Firebase Hosting — deployed sites + preview channels
        if (o === 'https://whats-acc.web.app') return origin;
        if (o === 'https://whats-acc-dev.web.app') return origin;
        if (/^https:\/\/whats-acc(-dev)?--[a-z0-9-]+\.web\.app$/.test(o)) return origin;
        // Custom domains
        if (o === 'https://whatsacc.com') return origin;
        if (o === 'https://www.whatsacc.com') return origin;
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
  app.route('/analytics', analyticsRoutes);
  app.route('/', whatsappRoutes); // mounts /webhooks/whatsapp at root
  app.route('/', telegramRoutes); // mounts /webhooks/telegram at root
  app.route('/', slackRoutes); // mounts /webhooks/slack at root

  return app;
}

export type AppType = ReturnType<typeof createApp>;
