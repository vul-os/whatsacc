import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, type AppEnv } from '../middleware/auth.ts';
import { withUserDb } from '../middleware/rls.ts';
import { hashToken } from '../lib/refresh.ts';
import { BadRequest, NotFound } from '../lib/errors.ts';

const claimSchema = z
  .object({
    claim_token: z.string().min(1),
    public_key: z.string().min(1).optional(),
  })
  .strict();

function devicesRouter() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth());

  // TODO: full device pairing + Durable Object websocket transport
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
