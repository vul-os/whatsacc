import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, getUser, type AppEnv } from '../middleware/auth.ts';
import { withUserDb } from '../middleware/rls.ts';
import { NotFound } from '../lib/errors.ts';
import type { TxSql } from '../lib/db.ts';

const opSchema = z
  .object({
    lat: z.number().optional(),
    long: z.number().optional(),
    source: z.enum(['web', 'whatsapp', 'api']).default('web'),
  })
  .strict();

async function logAccess(
  tx: TxSql,
  args: {
    user_id: string;
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

function accessRouter() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth());

  app.get('/access-points', async (c) => {
    const rows = await withUserDb(c, async (tx) => {
      return await tx<{
        id: string;
        location_id: string;
        name: string;
        kind: string;
        device_id: string | null;
        status: string;
      }[]>`
        select id, location_id, name, kind, device_id, status
        from access_points
        order by created_at asc
      `;
    });
    return c.json({ access_points: rows });
  });

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
