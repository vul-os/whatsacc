import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type postgres from 'postgres';
import { requireAuth, type AppEnv } from '../middleware/auth.ts';
import { withUserDb } from '../middleware/rls.ts';
import { NotFound } from '../lib/errors.ts';

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
      }[]>`
        select id, parent_location_id, type, name, slug, status
        from locations where account_id = ${accountId}
        order by created_at asc
      `;
    });
    return c.json({ locations: rows });
  });

  app.post(
    '/accounts/:accountId/locations',
    zValidator('json', createLocationSchema),
    async (c) => {
      const accountId = c.req.param('accountId');
      const body = c.req.valid('json');
      const result = await withUserDb(c, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          insert into locations
            (account_id, parent_location_id, type, name, slug, address, lat, long, status)
          values
            (${accountId}, ${body.parent_location_id ?? null}, ${body.type},
             ${body.name}, ${body.slug ?? null}, ${tx.json((body.address ?? null) as postgres.JSONValue)},
             ${body.lat ?? null}, ${body.long ?? null}, 'active')
          returning id
        `;
        return rows[0]!;
      });
      return c.json(result, 201);
    },
  );

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

  app.patch('/:id', zValidator('json', patchLocationSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    // TODO: build dynamic update; for now do a single set with COALESCEs
    await withUserDb(c, async (tx) => {
      await tx`
        update locations set
          name = coalesce(${body.name ?? null}, name),
          address = coalesce(${tx.json((body.address ?? null) as postgres.JSONValue)}, address),
          lat = coalesce(${body.lat ?? null}, lat),
          long = coalesce(${body.long ?? null}, long),
          status = coalesce(${body.status ?? null}, status),
          updated_at = now()
        where id = ${id}
      `;
    });
    return c.body(null, 204);
  });

  return app;
}

export const locationsRoutes = locationsRouter();
