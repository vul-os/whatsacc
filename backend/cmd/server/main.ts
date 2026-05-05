import { Hono } from 'hono';
import { getSql } from '../../src/lib/db.ts';
import { getEnv } from '../../src/lib/env.ts';
import type { AppEnv } from '../../src/middleware/auth.ts';
import { errorHandler } from '../../src/middleware/error.ts';
import { authRoutes } from '../../src/routes/auth.ts';
import { accountsRoutes } from '../../src/routes/accounts.ts';
import { locationsRoutes } from '../../src/routes/locations.ts';
import { accessRoutes } from '../../src/routes/access.ts';
import { devicesRoutes } from '../../src/routes/devices.ts';
import { phonesRoutes } from '../../src/routes/phones.ts';
import { whatsappRoutes } from '../../src/routes/whatsapp.ts';
import { billingRoutes } from '../../src/routes/billing.ts';
import { analyticsRoutes } from '../../src/routes/analytics.ts';

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
app.route('/accounts', accountsRoutes);
app.route('/locations', locationsRoutes);
app.route('/access', accessRoutes);
app.route('/devices', devicesRoutes);
app.route('/phones', phonesRoutes);
app.route('/billing', billingRoutes);
app.route('/analytics', analyticsRoutes);
app.route('/', whatsappRoutes); // mounts /webhooks/whatsapp at root

export type AppType = typeof app;
export { app };

const env = getEnv();
console.log(`whatsacc server listening on :${env.PORT} (${env.APP_ENV})`);
Deno.serve({ port: env.PORT }, app.fetch);
