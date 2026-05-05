import { Hono } from 'hono';
import { requireAuth, type AppEnv } from '../middleware/auth.ts';
import { withUserDb } from '../middleware/rls.ts';

function analyticsRouter() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth());

  // TODO: real time-bucketed aggregates
  app.get('/locations/:id/summary', async (c) => {
    const id = c.req.param('id');
    const data = await withUserDb(c, async (tx) => {
      const rows = await tx<{
        opens: number;
        closes: number;
        total: number;
      }[]>`
        select
          count(*) filter (where command = 'open')::int as opens,
          count(*) filter (where command = 'close')::int as closes,
          count(*)::int as total
        from access_logs where location_id = ${id}
      `;
      return rows[0] ?? { opens: 0, closes: 0, total: 0 };
    });
    return c.json({ location_id: id, ...data });
  });

  return app;
}

export const analyticsRoutes = analyticsRouter();
