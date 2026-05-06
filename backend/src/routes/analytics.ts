import { Hono } from 'hono';
import { requireAuth, type AppEnv } from '../middleware/auth.ts';
import { withUserDb } from '../middleware/rls.ts';

function analyticsRouter() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth());

  app.get('/locations/:id/summary', async (c) => {
    const id = c.req.param('id');
    const data = await withUserDb(c, async (tx) => {
      const rows = await tx<{ opens: number; closes: number; total: number }[]>`
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

  app.get('/accounts/:id/summary', async (c) => {
    const id = c.req.param('id');
    const data = await withUserDb(c, async (tx) => {
      const counts = await tx<{
        opens_today: string;
        opens_yesterday: string;
        location_count: string;
        member_count: string;
      }[]>`
        select
          (select count(*) from access_logs
            where account_id = ${id} and command = 'open' and success = true
              and ts >= date_trunc('day', now()))::text as opens_today,
          (select count(*) from access_logs
            where account_id = ${id} and command = 'open' and success = true
              and ts >= date_trunc('day', now()) - interval '1 day'
              and ts <  date_trunc('day', now()))::text as opens_yesterday,
          (select count(*) from locations where account_id = ${id})::text as location_count,
          (select count(*) from account_members where account_id = ${id})::text as member_count
      `;
      const recent = await tx<{
        id: string;
        ts: Date;
        command: string;
        success: boolean;
        source: string | null;
        access_point_name: string | null;
        location_name: string | null;
        actor_email: string | null;
      }[]>`
        select al.id, al.ts, al.command, al.success, al.source,
               ap.name as access_point_name, l.name as location_name,
               u.email::text as actor_email
        from access_logs al
        left join access_points ap on ap.id = al.access_point_id
        left join locations l on l.id = al.location_id
        left join users u on u.id = al.user_id
        where al.account_id = ${id}
        order by al.ts desc
        limit 25
      `;
      return {
        opens_today: Number(counts[0]?.opens_today ?? 0),
        opens_yesterday: Number(counts[0]?.opens_yesterday ?? 0),
        location_count: Number(counts[0]?.location_count ?? 0),
        member_count: Number(counts[0]?.member_count ?? 0),
        recent_activity: recent,
      };
    });
    return c.json({ account_id: id, ...data });
  });

  return app;
}

export const analyticsRoutes = analyticsRouter();
