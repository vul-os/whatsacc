import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, getUser, type AppEnv } from '../middleware/auth.ts';
import { withUserDb } from '../middleware/rls.ts';
import { withRLS } from '../lib/db.ts';
import { BadRequest, Forbidden, NotFound } from '../lib/errors.ts';
import type { TxSql } from '../lib/db.ts';
import { sendWhatsAppText, sendWhatsAppInteractive } from '../lib/whatsapp.ts';

const opSchema = z
  .object({
    lat: z.number().optional(),
    long: z.number().optional(),
    source: z.enum(['web', 'whatsapp', 'api']).default('web'),
  })
  .strict();

const PHONE_E164 = /^\+[1-9][0-9]{6,14}$/;

const createAccessPointSchema = z
  .object({
    location_id: z.string().uuid(),
    name: z.string().min(1).max(120),
    kind: z.enum(['gate', 'door', 'barrier', 'other']),
    device_id: z.string().uuid().nullable().optional(),
    lat: z.number().optional(),
    long: z.number().optional(),
  })
  .strict();

const grantCreateSchema = z
  .object({
    phone_e164: z.string().regex(PHONE_E164, 'phone must be E.164 (+27821234567)'),
    visitor_name: z.string().min(1).max(120).optional(),
    starts_at: z.string().datetime().optional(),
    ends_at: z.string().datetime(),
    max_uses: z.number().int().min(1).max(10_000).optional(),
    access_point_ids: z.array(z.string().uuid()).min(1).max(50),
    notes: z.string().max(2000).optional(),
  })
  .strict();

const grantListQuerySchema = z
  .object({
    account_id: z.string().uuid().optional(),
    phone_e164: z.string().regex(PHONE_E164).optional(),
    status: z.enum(['active', 'revoked']).optional(),
  })
  .partial();

const maintenanceSchema = z
  .object({
    kind: z.enum(['inspection', 'service', 'repair', 'replacement']),
    performed_at: z.string().datetime().optional(),
    technician_name: z.string().min(1).max(120).optional(),
    notes: z.string().max(2000).optional(),
    parts: z
      .array(
        z.object({
          name: z.string().min(1).max(120),
          qty: z.number().int().positive().default(1),
          cost_zar_cents: z.number().int().nonnegative().optional(),
        }),
      )
      .max(50)
      .optional(),
    cost_zar_cents: z.number().int().nonnegative().optional(),
    next_due_movement_m: z.number().positive().max(1_000_000).optional(),
    next_due_at: z.string().datetime().optional(),
    next_due_in_days: z.number().int().positive().max(3650).optional(),
  })
  .strict();

export async function logAccess(
  tx: TxSql,
  args: {
    user_id: string | null;
    access_point_id: string;
    command: 'open' | 'close';
    source: string;
    lat?: number;
    long?: number;
  },
): Promise<void> {
  const apRows = await tx<{
    location_id: string;
    account_id: string;
  }[]>`
    select ap.location_id, l.account_id
    from access_points ap join locations l on l.id = ap.location_id
    where ap.id = ${args.access_point_id}
  `;
  const ap = apRows[0];
  if (!ap) throw NotFound('access_point_not_found');

  await tx`
    insert into access_logs
      (access_point_id, location_id, account_id, user_id, command, source, lat, long, success)
    values
      (${args.access_point_id}, ${ap.location_id}, ${ap.account_id}, ${args.user_id},
       ${args.command}, ${args.source}, ${args.lat ?? null}, ${args.long ?? null}, true)
  `;
  // TODO: enqueue device_command and dispatch via Durable Object.
}

type AccessPointWithMeter = {
  id: string;
  location_id: string;
  name: string;
  kind: string;
  device_id: string | null;
  status: string;
  movement_m: string | null;
  total_opens: number | null;
  total_closes: number | null;
  last_op_at: Date | null;
  last_serviced_at: Date | null;
  last_service_movement_m: string | null;
  next_due_movement_m: string | null;
  next_due_at: Date | null;
};

type MaintenanceEventRow = {
  id: string;
  access_point_id: string;
  kind: string;
  performed_at: Date;
  performed_by: string | null;
  technician_name: string | null;
  notes: string | null;
  parts: unknown;
  cost_zar_cents: string | null;
  movement_m_at_event: string | null;
  next_due_movement_m: string | null;
  next_due_at: Date | null;
  created_at: Date;
};

function shapeAccessPoint(r: AccessPointWithMeter) {
  const movement = r.movement_m === null ? 0 : Number(r.movement_m);
  const due = computeNextDue({
    movement_m: movement,
    next_due_movement_m: r.next_due_movement_m === null ? null : Number(r.next_due_movement_m),
    next_due_at: r.next_due_at,
    last_op_at: r.last_op_at,
  });
  return {
    id: r.id,
    location_id: r.location_id,
    name: r.name,
    kind: r.kind,
    device_id: r.device_id,
    status: r.status,
    meter: {
      movement_m: movement,
      total_opens: r.total_opens ?? 0,
      total_closes: r.total_closes ?? 0,
      last_op_at: r.last_op_at,
    },
    maintenance: {
      last_serviced_at: r.last_serviced_at,
      last_service_movement_m:
        r.last_service_movement_m === null ? null : Number(r.last_service_movement_m),
      next_due_movement_m:
        r.next_due_movement_m === null ? null : Number(r.next_due_movement_m),
      next_due_at: r.next_due_at,
      ...due,
    },
  };
}

function computeNextDue(opts: {
  movement_m: number;
  next_due_movement_m: number | null;
  next_due_at: Date | null;
  last_op_at: Date | null;
}): {
  due_now: boolean;
  movement_remaining_m: number | null;
  pct_used: number | null;
} {
  const remaining =
    opts.next_due_movement_m === null
      ? null
      : Math.max(0, opts.next_due_movement_m - opts.movement_m);
  const pctUsed =
    opts.next_due_movement_m === null
      ? null
      : Math.min(1, opts.movement_m / opts.next_due_movement_m);
  const calendarDue = opts.next_due_at !== null && opts.next_due_at.getTime() <= Date.now();
  const movementDue = remaining !== null && remaining <= 0;
  return {
    due_now: calendarDue || movementDue,
    movement_remaining_m: remaining,
    pct_used: pctUsed,
  };
}

type GrantRow = {
  id: string;
  account_id: string;
  granted_by_user_id: string | null;
  phone_e164: string;
  visitor_name: string | null;
  starts_at: Date;
  ends_at: Date;
  max_uses: number | null;
  uses_count: number;
  status: 'active' | 'revoked';
  revoked_at: Date | null;
  revoked_by_user_id: string | null;
  notes: string | null;
  last_used_at: Date | null;
  created_at: Date;
  access_point_ids: string[] | null;
};

type EffectiveStatus = 'pending' | 'active' | 'expired' | 'exhausted' | 'revoked';

function effectiveStatus(g: GrantRow, now: Date = new Date()): EffectiveStatus {
  if (g.status === 'revoked') return 'revoked';
  if (g.max_uses !== null && g.uses_count >= g.max_uses) return 'exhausted';
  if (g.starts_at.getTime() > now.getTime()) return 'pending';
  if (g.ends_at.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

function shapeGrant(r: GrantRow) {
  return {
    id: r.id,
    account_id: r.account_id,
    granted_by_user_id: r.granted_by_user_id,
    phone_e164: r.phone_e164,
    visitor_name: r.visitor_name,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    max_uses: r.max_uses,
    uses_count: r.uses_count,
    status: r.status,
    effective_status: effectiveStatus(r),
    revoked_at: r.revoked_at,
    notes: r.notes,
    last_used_at: r.last_used_at,
    access_point_ids: r.access_point_ids ?? [],
    created_at: r.created_at,
  };
}

function shapeEvent(r: MaintenanceEventRow) {
  return {
    id: r.id,
    access_point_id: r.access_point_id,
    kind: r.kind,
    performed_at: r.performed_at,
    performed_by: r.performed_by,
    technician_name: r.technician_name,
    notes: r.notes,
    parts: r.parts,
    cost_zar_cents: r.cost_zar_cents === null ? null : Number(r.cost_zar_cents),
    movement_m_at_event:
      r.movement_m_at_event === null ? null : Number(r.movement_m_at_event),
    next_due_movement_m:
      r.next_due_movement_m === null ? null : Number(r.next_due_movement_m),
    next_due_at: r.next_due_at,
    created_at: r.created_at,
  };
}

function accessRouter() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth());

  app.get('/access-points', async (c) => {
    // Optional ?account_id= scopes the listing to one tenant. Without it RLS
    // would still filter to "any account the user is a member of", which
    // collapses every location's APs into one view when the user owns
    // multiple locations. Frontend passes the active account id so the page
    // shows only the current location's APs.
    const accountId = c.req.query('account_id') ?? null;
    const rows = await withUserDb(c, async (tx) => {
      return await tx<AccessPointWithMeter[]>`
        select
          ap.id, ap.location_id, ap.name, ap.kind, ap.device_id, ap.status,
          m.movement_m, m.total_opens, m.total_closes, m.last_op_at,
          m.last_serviced_at, m.last_service_movement_m,
          m.next_due_movement_m, m.next_due_at
        from access_points ap
        join locations l on l.id = ap.location_id
        left join access_point_meters m on m.access_point_id = ap.id
        where ${accountId}::uuid is null or l.account_id = ${accountId}::uuid
        order by ap.created_at asc
      `;
    });
    return c.json({ access_points: rows.map(shapeAccessPoint) });
  });

  app.get('/access-points/:id', async (c) => {
    const id = c.req.param('id');
    const row = await withUserDb(c, async (tx) => {
      const rows = await tx<AccessPointWithMeter[]>`
        select
          ap.id, ap.location_id, ap.name, ap.kind, ap.device_id, ap.status,
          m.movement_m, m.total_opens, m.total_closes, m.last_op_at,
          m.last_serviced_at, m.last_service_movement_m,
          m.next_due_movement_m, m.next_due_at
        from access_points ap
        left join access_point_meters m on m.access_point_id = ap.id
        where ap.id = ${id}
      `;
      return rows[0] ?? null;
    });
    if (!row) throw NotFound('access_point_not_found');
    return c.json(shapeAccessPoint(row));
  });

  app.post('/access-points', zValidator('json', createAccessPointSchema), async (c) => {
    const body = c.req.valid('json');
    // RLS enforces admin-of-account-owning-location via the WITH CHECK on
    // access_points (see migrations/20260505070000_rls.sql). If the user
    // doesn't own the location's account, the insert raises and Hono converts
    // it to a 500 — we'd rather give a 403, so we pre-check.
    const created = await withUserDb(c, async (tx) => {
      const loc = await tx<{ id: string }[]>`
        select id from locations where id = ${body.location_id}
      `;
      if (!loc[0]) throw NotFound('location_not_found');

      if (body.device_id) {
        const dev = await tx<{ id: string }[]>`
          select id from devices where id = ${body.device_id} and location_id = ${body.location_id}
        `;
        if (!dev[0]) throw BadRequest('device_not_at_location');
      }

      const rows = await tx<AccessPointWithMeter[]>`
        with inserted as (
          insert into access_points (location_id, name, kind, device_id, lat, long, status)
          values (${body.location_id}, ${body.name}, ${body.kind},
                  ${body.device_id ?? null}, ${body.lat ?? null}, ${body.long ?? null}, 'active')
          returning id, location_id, name, kind, device_id, status
        )
        select i.id, i.location_id, i.name, i.kind, i.device_id, i.status,
               m.movement_m, m.total_opens, m.total_closes, m.last_op_at,
               m.last_serviced_at, m.last_service_movement_m,
               m.next_due_movement_m, m.next_due_at
        from inserted i
        left join access_point_meters m on m.access_point_id = i.id
      `;
      return rows[0]!;
    });
    return c.json(shapeAccessPoint(created), 201);
  });

  app.get('/access-points/:id/maintenance', async (c) => {
    const id = c.req.param('id');
    const events = await withUserDb(c, async (tx) => {
      return await tx<MaintenanceEventRow[]>`
        select id, access_point_id, kind, performed_at, performed_by,
               technician_name, notes, parts, cost_zar_cents, movement_m_at_event,
               next_due_movement_m, next_due_at, created_at
        from maintenance_events
        where access_point_id = ${id}
        order by performed_at desc
        limit 100
      `;
    });
    return c.json({ events: events.map(shapeEvent) });
  });

  app.post(
    '/access-points/:id/maintenance',
    zValidator('json', maintenanceSchema),
    async (c) => {
      const user = getUser(c);
      const id = c.req.param('id');
      const body = c.req.valid('json');

      if (body.next_due_at && body.next_due_in_days) {
        throw BadRequest('conflicting_due_inputs', 'Provide next_due_at or next_due_in_days, not both');
      }

      const performedAt = body.performed_at ? new Date(body.performed_at) : new Date();
      const nextDueAt =
        body.next_due_at !== undefined
          ? new Date(body.next_due_at)
          : body.next_due_in_days !== undefined
            ? new Date(performedAt.getTime() + body.next_due_in_days * 24 * 60 * 60 * 1000)
            : null;

      const event = await withUserDb(c, async (tx) => {
        const ok = await tx<{ ok: boolean }[]>`
          select app.is_account_admin(l.account_id) as ok
          from access_points ap
          join locations l on l.id = ap.location_id
          where ap.id = ${id}
        `;
        if (!ok[0]) throw NotFound('access_point_not_found');
        if (!ok[0].ok) throw Forbidden('not_account_admin');

        const partsJson = body.parts ?? [];
        const [row] = await tx<{ id: string }[]>`
          insert into maintenance_events
            (access_point_id, kind, performed_at, performed_by, technician_name,
             notes, parts, cost_zar_cents, next_due_movement_m, next_due_at)
          values
            (${id}, ${body.kind}, ${performedAt}, ${user.sub},
             ${body.technician_name ?? null}, ${body.notes ?? null},
             ${tx.json(partsJson)}, ${body.cost_zar_cents ?? null},
             ${body.next_due_movement_m ?? null}, ${nextDueAt})
          returning id
        `;
        const eventId = row!.id;

        const fullRows = await tx<MaintenanceEventRow[]>`
          select id, access_point_id, kind, performed_at, performed_by,
                 technician_name, notes, parts, cost_zar_cents, movement_m_at_event,
                 next_due_movement_m, next_due_at, created_at
          from maintenance_events
          where id = ${eventId}
        `;
        return fullRows[0]!;
      });

      return c.json(shapeEvent(event), 201);
    },
  );

  app.post('/access-points/:id/open', zValidator('json', opSchema), async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const body = c.req.valid('json');
    await withUserDb(c, async (tx) => {
      await logAccess(tx, {
        user_id: user.sub,
        access_point_id: id,
        command: 'open',
        source: body.source,
        lat: body.lat,
        long: body.long,
      });
    });
    return c.json({ ok: true, command: 'open' });
  });

  // -------------------------------------------------------------------------
  // Temporary access grants
  // -------------------------------------------------------------------------

  app.get('/grants', zValidator('query', grantListQuerySchema), async (c) => {
    const q = c.req.valid('query');
    const rows = await withUserDb(c, async (tx) => {
      // RLS already constrains to the user's accounts; the optional filters
      // narrow further.
      return await tx<GrantRow[]>`
        select g.id, g.account_id, g.granted_by_user_id, g.phone_e164, g.visitor_name,
               g.starts_at, g.ends_at, g.max_uses, g.uses_count, g.status,
               g.revoked_at, g.revoked_by_user_id, g.notes, g.last_used_at, g.created_at,
               array(
                 select t.access_point_id::text
                 from temporary_access_grant_access_points t
                 where t.grant_id = g.id
               ) as access_point_ids
        from temporary_access_grants g
        where (${q.account_id ?? null}::uuid is null or g.account_id = ${q.account_id ?? null}::uuid)
          and (${q.phone_e164 ?? null}::text is null or g.phone_e164 = ${q.phone_e164 ?? null}::text)
          and (${q.status ?? null}::text is null or g.status = ${q.status ?? null}::text)
        order by g.created_at desc
        limit 200
      `;
    });
    return c.json({ grants: rows.map(shapeGrant) });
  });

  app.get('/grants/:id', async (c) => {
    const id = c.req.param('id');
    const row = await withUserDb(c, async (tx) => {
      const rows = await tx<GrantRow[]>`
        select g.id, g.account_id, g.granted_by_user_id, g.phone_e164, g.visitor_name,
               g.starts_at, g.ends_at, g.max_uses, g.uses_count, g.status,
               g.revoked_at, g.revoked_by_user_id, g.notes, g.last_used_at, g.created_at,
               array(
                 select t.access_point_id::text
                 from temporary_access_grant_access_points t
                 where t.grant_id = g.id
               ) as access_point_ids
        from temporary_access_grants g
        where g.id = ${id}
      `;
      return rows[0] ?? null;
    });
    if (!row) throw NotFound('grant_not_found');
    return c.json(shapeGrant(row));
  });

  app.post('/grants', zValidator('json', grantCreateSchema), async (c) => {
    const user = getUser(c);
    const body = c.req.valid('json');

    const startsAt = body.starts_at ? new Date(body.starts_at) : new Date();
    const endsAt = new Date(body.ends_at);
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw BadRequest('invalid_window', 'ends_at must be after starts_at');
    }

    const grant = await withUserDb(c, async (tx) => {
      // 1. All access points must belong to ONE account that the user admins.
      const apRows = await tx<{ id: string; account_id: string; admin: boolean; name: string }[]>`
        select ap.id, l.account_id, app.is_account_admin(l.account_id) as admin, ap.name
        from access_points ap
        join locations l on l.id = ap.location_id
        where ap.id = any(${body.access_point_ids}::uuid[])
      `;
      if (apRows.length !== body.access_point_ids.length) {
        throw NotFound('access_point_not_found');
      }
      const accounts = new Set(apRows.map((r) => r.account_id));
      if (accounts.size !== 1) {
        throw BadRequest('cross_account_grant', 'all access points must belong to the same account');
      }
      if (!apRows.every((r) => r.admin)) throw Forbidden('not_account_admin');
      const accountId = apRows[0]!.account_id;

      // 2. Insert the grant + the join rows in one go.
      const [g] = await tx<{ id: string }[]>`
        insert into temporary_access_grants
          (account_id, granted_by_user_id, phone_e164, visitor_name,
           starts_at, ends_at, max_uses, notes)
        values
          (${accountId}, ${user.sub}, ${body.phone_e164}, ${body.visitor_name ?? null},
           ${startsAt}, ${endsAt}, ${body.max_uses ?? null}, ${body.notes ?? null})
        returning id
      `;
      const grantId = g!.id;

      for (const apId of body.access_point_ids) {
        await tx`
          insert into temporary_access_grant_access_points (grant_id, access_point_id)
          values (${grantId}, ${apId})
        `;
      }

      const fullRows = await tx<GrantRow[]>`
        select g.id, g.account_id, g.granted_by_user_id, g.phone_e164, g.visitor_name,
               g.starts_at, g.ends_at, g.max_uses, g.uses_count, g.status,
               g.revoked_at, g.revoked_by_user_id, g.notes, g.last_used_at, g.created_at,
               array(
                 select t.access_point_id::text
                 from temporary_access_grant_access_points t
                 where t.grant_id = g.id
               ) as access_point_ids
        from temporary_access_grants g where g.id = ${grantId}
      `;
      const grant = fullRows[0]!;

      // 3. Notify the visitor via WhatsApp.
      const to = grant.phone_e164.startsWith('+') ? grant.phone_e164.slice(1) : grant.phone_e164;
      const names = apRows.map((r) => r.name).join(', ');
      const message = `Hello ${grant.visitor_name ?? 'there'}! You've been granted access to: ${names}. This access is valid until ${grant.ends_at.toLocaleString()}. You can open the gate by replying to this message.`;

      if (apRows.length === 1) {
        await sendWhatsAppInteractive(to, {
          type: 'button',
          body: { text: message },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: { id: `open_ap:${apRows[0]!.id}`, title: `Open ${apRows[0]!.name}` },
              },
            ],
          },
        });
      } else {
        await sendWhatsAppInteractive(to, {
          type: 'list',
          header: { type: 'text', text: 'Access Granted' },
          body: { text: message },
          action: {
            button: 'View Gates',
            sections: [
              {
                title: 'Available Gates',
                rows: apRows.slice(0, 10).map((r) => ({
                  id: `open_ap:${r.id}`,
                  title: r.name,
                })),
              },
            ],
          },
        });
      }

      return grant;
    });

    return c.json(shapeGrant(grant), 201);
  });

  app.post('/grants/:id/revoke', async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const row = await withUserDb(c, async (tx) => {
      // Only account admins (per RLS update policy) can flip the row.
      const rows = await tx<GrantRow[]>`
        update temporary_access_grants
        set status = 'revoked',
            revoked_at = now(),
            revoked_by_user_id = ${user.sub},
            updated_at = now()
        where id = ${id} and status = 'active'
        returning id, account_id, granted_by_user_id, phone_e164, visitor_name,
                  starts_at, ends_at, max_uses, uses_count, status,
                  revoked_at, revoked_by_user_id, notes, last_used_at, created_at,
                  array(
                    select t.access_point_id::text
                    from temporary_access_grant_access_points t
                    where t.grant_id = temporary_access_grants.id
                  ) as access_point_ids
      `;
      const grant = rows[0] ?? null;

      if (grant) {
        const to = grant.phone_e164.startsWith('+') ? grant.phone_e164.slice(1) : grant.phone_e164;
        await sendWhatsAppText(
          to,
          `Your access has been revoked. If you believe this is an error, please contact the administrator.`,
        );
      }

      return grant;
    });
    if (!row) throw NotFound('grant_not_revocable');
    return c.json(shapeGrant(row));
  });

  app.post('/access-points/:id/close', zValidator('json', opSchema), async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const body = c.req.valid('json');
    await withUserDb(c, async (tx) => {
      await logAccess(tx, {
        user_id: user.sub,
        access_point_id: id,
        command: 'close',
        source: body.source,
        lat: body.lat,
        long: body.long,
      });
    });
    return c.json({ ok: true, command: 'close' });
  });

  return app;
}

export const accessRoutes = accessRouter();

/**
 * Atomically check + consume a temporary access grant for the supplied phone
 * and access point. Returns the grant id on success, null when no usable grant
 * exists. Intended for the WhatsApp inbound flow.
 */
export async function tryConsumeGrant(
  phoneE164: string,
  accessPointId: string,
  ts: Date = new Date(),
): Promise<string | null> {
  return await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      const rows = await tx<{ grant_id: string | null }[]>`
        select app.try_consume_grant(${phoneE164}, ${accessPointId}::uuid, ${ts}) as grant_id
      `;
      return rows[0]?.grant_id ?? null;
    },
  );
}
