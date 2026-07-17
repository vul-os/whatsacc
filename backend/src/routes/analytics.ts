import { Hono } from 'hono';
import { requireAuth, type AppEnv } from '../middleware/auth.ts';
import { withUserDb } from '../middleware/rls.ts';
import { NotFound } from '../lib/errors.ts';
import { DAY_S, fixedWindowStart } from '../lib/rate-limit.ts';

function analyticsRouter() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth());

  app.get('/locations/:id/summary', async (c) => {
    const id = c.req.param('id');
    const dayStart = fixedWindowStart(new Date(), DAY_S);
    const data = await withUserDb(c, async (tx) => {
      // Verify the caller can actually see this location before reporting
      // any analytics — otherwise non-members get a 200 with zeroed data,
      // which is mild info-disclosure (proves the location exists).
      const loc = await tx<{ id: string }[]>`select id from locations where id = ${id}`;
      if (!loc[0]) throw NotFound('location_not_found');
      const rows = await tx<{ opens: number; closes: number; total: number }[]>`
        select
          count(*) filter (where command = 'open')::int as opens,
          count(*) filter (where command = 'close')::int as closes,
          count(*)::int as total
        from access_logs where location_id = ${id}
      `;
      // Usage vs (abuse-protection) quota so the UI can render "N of M
      // opens used today". Same UTC day window the limiter counts in.
      const today = await tx<
        {
          opens_today: number;
          max_opens_per_member_per_day: number | null;
          max_opens_per_location_per_day: number | null;
        }[]
      >`
        select
          (select count(*)::int from access_logs
            where location_id = ${id} and command = 'open' and success = true
              and ts >= ${dayStart}) as opens_today,
          ls.max_opens_per_member_per_day,
          ls.max_opens_per_location_per_day
        from (select 1) as one
        left join location_settings ls on ls.location_id = ${id}
      `;
      return {
        ...(rows[0] ?? { opens: 0, closes: 0, total: 0 }),
        today: {
          day_start: dayStart.toISOString(),
          opens: Number(today[0]?.opens_today ?? 0),
          max_opens_per_member_per_day: today[0]?.max_opens_per_member_per_day ?? null,
          max_opens_per_location_per_day: today[0]?.max_opens_per_location_per_day ?? null,
        },
      };
    });
    return c.json({ location_id: id, ...data });
  });

  app.get('/accounts/:id/insights', async (c) => {
    const id = c.req.param('id');
    const data = await withUserDb(c, async (tx) => {
      const acct = await tx<{ id: string }[]>`select id from accounts where id = ${id}`;
      if (!acct[0]) throw NotFound('account_not_found');

      const series = await tx<{ day: string; opens: number; denied: number }[]>`
        with days as (
          select generate_series(
            date_trunc('day', now()) - interval '6 days',
            date_trunc('day', now()),
            interval '1 day'
          )::date as day
        )
        select
          d.day::text as day,
          coalesce(count(*) filter (where al.success = true and al.command = 'open'), 0)::int as opens,
          coalesce(count(*) filter (where al.success = false), 0)::int as denied
        from days d
        left join access_logs al
          on al.account_id = ${id}
          and al.ts >= d.day
          and al.ts <  d.day + interval '1 day'
        group by d.day
        order by d.day
      `;

      const breakdown = await tx<{
        access_point_id: string;
        access_point_name: string | null;
        location_name: string | null;
        opens: number;
      }[]>`
        select
          ap.id   as access_point_id,
          ap.name as access_point_name,
          l.name  as location_name,
          count(*)::int as opens
        from access_logs al
        join access_points ap on ap.id = al.access_point_id
        left join locations l on l.id = al.location_id
        where al.account_id = ${id}
          and al.command = 'open'
          and al.success = true
          and al.ts >= date_trunc('day', now()) - interval '6 days'
        group by ap.id, ap.name, l.name
        order by opens desc
        limit 5
      `;

      const totals = await tx<{
        opens_7d: number;
        denied_7d: number;
        closes_7d: number;
        opens_prev_7d: number;
      }[]>`
        select
          coalesce(count(*) filter (
            where al.command = 'open' and al.success = true
              and al.ts >= date_trunc('day', now()) - interval '6 days'
          ), 0)::int as opens_7d,
          coalesce(count(*) filter (
            where al.success = false
              and al.ts >= date_trunc('day', now()) - interval '6 days'
          ), 0)::int as denied_7d,
          coalesce(count(*) filter (
            where al.command = 'close' and al.success = true
              and al.ts >= date_trunc('day', now()) - interval '6 days'
          ), 0)::int as closes_7d,
          coalesce(count(*) filter (
            where al.command = 'open' and al.success = true
              and al.ts >= date_trunc('day', now()) - interval '13 days'
              and al.ts <  date_trunc('day', now()) - interval '6 days'
          ), 0)::int as opens_prev_7d
        from access_logs al
        where al.account_id = ${id}
          and al.ts >= date_trunc('day', now()) - interval '13 days'
      `;

      const members = await tx<{ member_count: number; active_members_7d: number }[]>`
        select
          (select count(*) from account_members where account_id = ${id})::int as member_count,
          (select count(distinct al.user_id)
             from access_logs al
            where al.account_id = ${id}
              and al.user_id is not null
              and al.ts >= date_trunc('day', now()) - interval '6 days')::int as active_members_7d
      `;

      const t = totals[0] ?? { opens_7d: 0, denied_7d: 0, closes_7d: 0, opens_prev_7d: 0 };
      const m = members[0] ?? { member_count: 0, active_members_7d: 0 };

      return {
        days: series.map((r) => ({
          day: r.day,
          opens: Number(r.opens) || 0,
          denied: Number(r.denied) || 0,
        })),
        breakdown: breakdown.map((r) => ({
          access_point_id: r.access_point_id,
          access_point_name: r.access_point_name,
          location_name: r.location_name,
          opens: Number(r.opens) || 0,
        })),
        totals: {
          opens_7d: Number(t.opens_7d) || 0,
          denied_7d: Number(t.denied_7d) || 0,
          closes_7d: Number(t.closes_7d) || 0,
          opens_prev_7d: Number(t.opens_prev_7d) || 0,
        },
        members: {
          member_count: Number(m.member_count) || 0,
          active_members_7d: Number(m.active_members_7d) || 0,
        },
      };
    });
    return c.json({ account_id: id, ...data });
  });

  app.get('/accounts/:id/summary', async (c) => {
    const id = c.req.param('id');
    const data = await withUserDb(c, async (tx) => {
      // Same defence as above — block non-members from probing account
      // existence via the analytics summary.
      const acct = await tx<{ id: string }[]>`select id from accounts where id = ${id}`;
      if (!acct[0]) throw NotFound('account_not_found');
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
