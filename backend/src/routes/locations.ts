import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { JSONValue } from '../lib/db.ts';
import { requireAuth, getUser, type AppEnv } from '../middleware/auth.ts';
import { withUserDb, withAnonDb } from '../middleware/rls.ts';
import { Forbidden, NotFound } from '../lib/errors.ts';
import { bootstrapPersonalAccount, makeLocationSlug } from './auth.ts';
import { DAY_S, fixedWindowStart } from '../lib/rate-limit.ts';

const createLocationSchema = z
  .object({
    parent_location_id: z.string().uuid().nullable().optional(),
    type: z.enum(['house', 'complex', 'building', 'other']),
    name: z.string().min(1).max(120),
    slug: z.string().min(1).max(120).optional(),
    address: z.record(z.unknown()).optional(),
    lat: z.number().optional(),
    long: z.number().optional(),
  })
  .strict();

// New top-level create: locations are first-class. Each one gets a fresh
// account (1:1) so its members are isolated from any other location the
// same user owns.
const createTopLevelLocationSchema = z
  .object({
    name: z.string().min(1).max(120),
    type: z.enum(['house', 'complex', 'building', 'other']).default('house'),
    country_code: z
      .string()
      .length(2)
      .transform((v) => v.toUpperCase())
      .default('ZA'),
    address: z.record(z.unknown()).optional(),
    lat: z.number().optional(),
    long: z.number().optional(),
  })
  .strict();

// Abuse-protection quotas (NOT billing — whatsacc has none). NULL clears a
// cap (= unlimited); omitted fields are left unchanged.
const patchLimitsSchema = z
  .object({
    max_opens_per_member_per_day: z.number().int().min(1).max(100_000).nullable().optional(),
    max_opens_per_location_per_day: z.number().int().min(1).max(1_000_000).nullable().optional(),
  })
  .strict();

const patchLocationSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    address: z.record(z.unknown()).optional(),
    lat: z.number().optional(),
    long: z.number().optional(),
    status: z.string().optional(),
  })
  .strict();

function locationsRouter() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth());

  app.get('/accounts/:accountId/locations', async (c) => {
    const accountId = c.req.param('accountId');
    const rows = await withUserDb(c, async (tx) => {
      return await tx<{
        id: string;
        parent_location_id: string | null;
        type: string;
        name: string;
        slug: string | null;
        status: string;
        address: unknown;
        access_point_count: string;
        member_count: string;
        last_opened_at: Date | null;
      }[]>`
        select
          l.id, l.parent_location_id, l.type, l.name, l.slug, l.status, l.address,
          (select count(*)::text from access_points ap where ap.location_id = l.id) as access_point_count,
          (select count(*)::text from location_members lm where lm.location_id = l.id) as member_count,
          (select max(al.ts) from access_logs al
             where al.location_id = l.id and al.command = 'open' and al.success = true) as last_opened_at
        from locations l
        where l.account_id = ${accountId}
        order by l.created_at asc
      `;
    });
    return c.json({
      locations: rows.map((r) => ({
        id: r.id,
        parent_location_id: r.parent_location_id,
        type: r.type,
        name: r.name,
        slug: r.slug,
        status: r.status,
        address: r.address,
        access_point_count: Number(r.access_point_count),
        member_count: Number(r.member_count),
        last_opened_at: r.last_opened_at,
      })),
    });
  });

  app.post(
    '/accounts/:accountId/locations',
    zValidator('json', createLocationSchema),
    async (c) => {
      const user = getUser(c);
      const accountId = c.req.param('accountId');
      const body = c.req.valid('json');
      const result = await withUserDb(c, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          insert into locations
            (account_id, parent_location_id, type, name, slug, address, lat, long, status)
          values
            (${accountId}, ${body.parent_location_id ?? null}, ${body.type},
             ${body.name}, ${body.slug ?? makeLocationSlug(body.name)}, ${tx.json((body.address ?? {}) as JSONValue)},
             ${body.lat ?? null}, ${body.long ?? null}, 'active')
          returning id
        `;
        await tx`
          insert into location_members (location_id, user_id, role)
          values (${rows[0]!.id}, ${user.sub}, 'owner')
          on conflict (location_id, user_id) do update set role = excluded.role, updated_at = now()
        `;
        return rows[0]!;
      });
      return c.json(result, 201);
    },
  );

  // -------------------------------------------------------------------------
  // Abuse-protection quotas ("limits") + usage. GET is member-visible so the
  // portal can show "3 of 4 opens used"; PATCH is admin-only. Usage is
  // computed from access_logs over the same UTC day window the enforcement
  // counters use, so what the UI shows matches what the limiter counts.
  // -------------------------------------------------------------------------

  app.get('/:id/limits', async (c) => {
    const id = c.req.param('id');
    const user = getUser(c);
    const dayStart = fixedWindowStart(new Date(), DAY_S);
    const data = await withUserDb(c, async (tx) => {
      const loc = await tx<{ id: string; account_id: string }[]>`
        select id, account_id from locations where id = ${id}
      `;
      if (!loc[0]) throw NotFound('location_not_found');

      const settings = await tx<
        { max_opens_per_member_per_day: number | null; max_opens_per_location_per_day: number | null }[]
      >`
        select max_opens_per_member_per_day, max_opens_per_location_per_day
        from location_settings where location_id = ${id}
      `;

      const totals = await tx<{ location_opens_today: string; my_opens_today: string }[]>`
        select
          count(*) filter (where success = true and command = 'open')::text as location_opens_today,
          count(*) filter (
            where success = true and command = 'open' and user_id = ${user.sub}
          )::text as my_opens_today
        from access_logs
        where location_id = ${id} and ts >= ${dayStart}
      `;

      // Per-member breakdown for the admin UI. Email is left-joined under
      // the caller's RLS — other users' rows resolve to null email, which
      // the frontend maps via the members list.
      const members = await tx<{ user_id: string | null; email: string | null; opens_today: string }[]>`
        select al.user_id, u.email::text as email, count(*)::text as opens_today
        from access_logs al
        left join users u on u.id = al.user_id
        where al.location_id = ${id}
          and al.success = true
          and al.command = 'open'
          and al.ts >= ${dayStart}
        group by al.user_id, u.email
        order by count(*) desc
        limit 50
      `;

      return {
        quotas: {
          max_opens_per_member_per_day: settings[0]?.max_opens_per_member_per_day ?? null,
          max_opens_per_location_per_day: settings[0]?.max_opens_per_location_per_day ?? null,
        },
        usage: {
          day_start: dayStart.toISOString(),
          location_opens_today: Number(totals[0]?.location_opens_today ?? 0),
          my_opens_today: Number(totals[0]?.my_opens_today ?? 0),
          members: members.map((m) => ({
            user_id: m.user_id,
            email: m.email,
            opens_today: Number(m.opens_today),
          })),
        },
      };
    });
    return c.json({ location_id: id, ...data });
  });

  app.patch('/:id/limits', zValidator('json', patchLimitsSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const hasMember = 'max_opens_per_member_per_day' in body;
    const hasLocation = 'max_opens_per_location_per_day' in body;
    const memberVal = body.max_opens_per_member_per_day ?? null;
    const locationVal = body.max_opens_per_location_per_day ?? null;

    const quotas = await withUserDb(c, async (tx) => {
      // Pre-check admin so the caller gets a clean 403/404 instead of an
      // RLS-shaped 500 on the location_settings upsert.
      const loc = await tx<{ id: string; admin: boolean }[]>`
        select l.id, app.is_account_admin(l.account_id) as admin
        from locations l where l.id = ${id}
      `;
      if (!loc[0]) throw NotFound('location_not_found');
      if (!loc[0].admin) throw Forbidden('not_account_admin');

      const rows = await tx<
        { max_opens_per_member_per_day: number | null; max_opens_per_location_per_day: number | null }[]
      >`
        insert into location_settings
          (location_id, max_opens_per_member_per_day, max_opens_per_location_per_day)
        values (${id}, ${memberVal}, ${locationVal})
        on conflict (location_id) do update set
          max_opens_per_member_per_day = case
            when ${hasMember} then ${memberVal}::int
            else location_settings.max_opens_per_member_per_day end,
          max_opens_per_location_per_day = case
            when ${hasLocation} then ${locationVal}::int
            else location_settings.max_opens_per_location_per_day end,
          updated_at = now()
        returning max_opens_per_member_per_day, max_opens_per_location_per_day
      `;
      return rows[0]!;
    });
    return c.json({ location_id: id, quotas });
  });

  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const data = await withUserDb(c, async (tx) => {
      const rows = await tx<{
        id: string;
        account_id: string;
        parent_location_id: string | null;
        type: string;
        name: string;
        slug: string | null;
        address: unknown;
        lat: number | null;
        long: number | null;
        status: string;
      }[]>`
        select id, account_id, parent_location_id, type, name, slug, address, lat, long, status
        from locations where id = ${id}
      `;
      return rows[0] ?? null;
    });
    if (!data) throw NotFound('location_not_found');
    return c.json(data);
  });

  // Top-level POST /locations — creates a fresh account + location pair
  // owned by the caller. Used when a user adds a NEW location ("invite my
  // cleaner to a different house"); each one gets isolated members. The
  // caller is added as 'owner' of the new account.
  app.post('/', zValidator('json', createTopLevelLocationSchema), async (c) => {
    const user = getUser(c);
    const body = c.req.valid('json');
    const result = await withAnonDb(async (tx) => {
      const accountId = await bootstrapPersonalAccount(tx, {
        userId: user.sub,
        name: body.name,
        countryCode: body.country_code,
      });
      const rows = await tx<{ id: string }[]>`
        insert into locations
          (account_id, type, name, slug, address, lat, long, status)
        values (
          ${accountId},
          ${body.type},
          ${body.name},
          ${makeLocationSlug(body.name)},
          ${tx.json((body.address ?? {}) as JSONValue)},
          ${body.lat ?? null},
          ${body.long ?? null},
          'active'
        )
        returning id
      `;
      await tx`
        insert into location_members (location_id, user_id, role)
        values (${rows[0]!.id}, ${user.sub}, 'owner')
        on conflict (location_id, user_id) do update set role = excluded.role, updated_at = now()
      `;
      return { id: rows[0]!.id, account_id: accountId };
    });
    return c.json(result, 201);
  });

  // DELETE /locations/:id — drops the location and (since 1:1) its parent
  // account if no sibling locations remain. The cascade chain handles
  // members, devices, access_points etc. RLS guarantees only an owner/admin
  // of the parent account can do this.
  app.delete('/:id', async (c) => {
    const result = await withUserDb(c, async (tx) => {
      const found = await tx<{ id: string; account_id: string }[]>`
        select id, account_id from locations where id = ${c.req.param('id')}
      `;
      if (!found[0]) throw NotFound('location_not_found');
      const accountId = found[0].account_id;
      await tx`delete from locations where id = ${found[0].id}`;
      // If this account has no other locations, drop the account too so
      // the user isn't left with an orphaned tenant.
      const remaining = await tx<{ count: string }[]>`
        select count(*)::text from locations where account_id = ${accountId}
      `;
      if (remaining[0] && Number(remaining[0].count) === 0) {
        await tx`delete from accounts where id = ${accountId}`;
      }
      return { deleted: found[0].id, account_dropped: Number(remaining[0]?.count ?? 1) === 0 };
    });
    return c.json(result);
  });

  app.patch('/:id', zValidator('json', patchLocationSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    // TODO: build dynamic update; for now do a single set with COALESCEs.
    // Use RETURNING to detect when RLS filtered the update to zero rows
    // (caller is not a member of the owning account) — without this we'd
    // return 204 even though nothing changed, which leaks "the row exists"
    // and confuses the caller into thinking their PATCH applied.
    await withUserDb(c, async (tx) => {
      const updated = await tx<{ id: string }[]>`
        update locations set
          name = coalesce(${body.name ?? null}, name),
          address = coalesce(${tx.json((body.address ?? null) as JSONValue)}, address),
          lat = coalesce(${body.lat ?? null}, lat),
          long = coalesce(${body.long ?? null}, long),
          status = coalesce(${body.status ?? null}, status),
          updated_at = now()
        where id = ${id}
        returning id
      `;
      if (updated.length === 0) throw NotFound('location_not_found');
    });
    return c.body(null, 204);
  });

  return app;
}

export const locationsRoutes = locationsRouter();
