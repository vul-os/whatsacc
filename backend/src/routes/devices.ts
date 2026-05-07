import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, getUser, type AppEnv } from '../middleware/auth.ts';
import { withUserDb } from '../middleware/rls.ts';
import { hashToken } from '../lib/refresh.ts';
import { randomToken } from '../lib/random.ts';
import { BadRequest, Forbidden, NotFound } from '../lib/errors.ts';

const claimSchema = z
  .object({
    claim_token: z.string().min(1),
    public_key: z.string().min(1).optional(),
  })
  .strict();

const createSchema = z
  .object({
    location_id: z.string().uuid(),
    label: z.string().min(1).max(120).optional(),
    claim_ttl_seconds: z.number().int().min(60).max(7 * 24 * 60 * 60).optional(),
  })
  .strict();

const CLAIM_DEFAULT_TTL = 60 * 60; // 1h

type DeviceRow = {
  id: string;
  location_id: string;
  label: string | null;
  status: string;
  paired_at: Date | null;
  last_seen_at: Date | null;
  claim_expires_at: Date | null;
  created_at: Date;
};

function devicesRouter() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth());

  app.get('/', async (c) => {
    // ?location_id= or ?account_id= scopes the listing. Without either RLS
    // still filters to accounts the user is a member of — but that collapses
    // every location's devices into one view when the user owns several.
    // The frontend passes the active account id so the page only shows the
    // current location's devices.
    const locationId = c.req.query('location_id') ?? null;
    const accountId = c.req.query('account_id') ?? null;
    const rows = await withUserDb(c, async (tx) => {
      return await tx<DeviceRow[]>`
        select d.id, d.location_id, d.label, d.status, d.paired_at, d.last_seen_at,
               d.claim_expires_at, d.created_at
        from devices d
        join locations l on l.id = d.location_id
        where (${locationId}::uuid is null or d.location_id = ${locationId}::uuid)
          and (${accountId}::uuid is null or l.account_id = ${accountId}::uuid)
        order by d.created_at desc
      `;
    });
    return c.json({ devices: rows });
  });

  app.post('/', zValidator('json', createSchema), async (c) => {
    const user = getUser(c);
    const body = c.req.valid('json');
    const claim_token = randomToken(24);
    const claim_token_hash = await hashToken(claim_token);
    const ttl = body.claim_ttl_seconds ?? CLAIM_DEFAULT_TTL;
    const expires = new Date(Date.now() + ttl * 1000);

    const result = await withUserDb(c, async (tx) => {
      // Confirm the user is admin of the location's account.
      const adminRows = await tx<{ ok: boolean }[]>`
        select app.is_account_admin(l.account_id) as ok
        from locations l where l.id = ${body.location_id}
      `;
      if (!adminRows[0]) throw NotFound('location_not_found');
      if (!adminRows[0].ok) throw Forbidden('not_account_admin');

      const [row] = await tx<{ id: string }[]>`
        insert into devices
          (location_id, label, claim_token_hash, claim_expires_at, status)
        values
          (${body.location_id}, ${body.label ?? null}, ${claim_token_hash},
           ${expires}, 'unpaired')
        returning id
      `;
      return { id: row!.id };
    });

    return c.json(
      {
        id: result.id,
        location_id: body.location_id,
        label: body.label ?? null,
        status: 'unpaired',
        claim_token,
        claim_expires_at: expires,
        created_by: user.sub,
      },
      201,
    );
  });

  app.post('/claim', zValidator('json', claimSchema), async (c) => {
    const { claim_token, public_key } = c.req.valid('json');
    const tokenHash = await hashToken(claim_token);
    const result = await withUserDb(c, async (tx) => {
      const rows = await tx<{
        id: string;
        claim_expires_at: Date | null;
        paired_at: Date | null;
      }[]>`
        select id, claim_expires_at, paired_at
        from devices where claim_token_hash = ${tokenHash}
        for update
      `;
      const row = rows[0];
      if (!row) throw NotFound('device_not_found');
      if (row.paired_at) throw BadRequest('device_already_paired');
      if (row.claim_expires_at && row.claim_expires_at.getTime() <= Date.now()) {
        throw BadRequest('claim_expired');
      }
      await tx`
        update devices set
          paired_at = now(),
          public_key = coalesce(${public_key ?? null}, public_key),
          status = 'active',
          claim_token_hash = null,
          claim_expires_at = null
        where id = ${row.id}
      `;
      return { id: row.id };
    });
    return c.json(result);
  });

  return app;
}

export const devicesRoutes = devicesRouter();
