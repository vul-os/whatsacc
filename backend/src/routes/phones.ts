import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, getUser, type AppEnv } from '../middleware/auth.ts';
import { withUserDb } from '../middleware/rls.ts';
import { BadRequest, NotFound } from '../lib/errors.ts';

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'invalid_e164');

const addPhoneSchema = z
  .object({
    phone_e164: e164,
    is_primary: z.boolean().default(false),
  })
  .strict();

const verifyPhoneSchema = z.object({ code: z.string().min(4).max(8) }).strict();

function phonesRouter() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth());

  app.get('/me/phones', async (c) => {
    const user = getUser(c);
    const rows = await withUserDb(c, async (tx) => {
      return await tx<{
        id: string;
        phone_e164: string;
        verified_at: Date | null;
        is_primary: boolean;
      }[]>`
        select id, phone_e164, verified_at, is_primary
        from profile_phone_numbers
        where profile_id = ${user.sub}
        order by is_primary desc, created_at asc
      `;
    });
    return c.json({ phones: rows });
  });

  app.post('/me/phones', zValidator('json', addPhoneSchema), async (c) => {
    const user = getUser(c);
    const { phone_e164, is_primary } = c.req.valid('json');
    const result = await withUserDb(c, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into profile_phone_numbers (profile_id, phone_e164, is_primary, verified_at)
        values (${user.sub}, ${phone_e164}, ${is_primary}, now())
        on conflict (profile_id, phone_e164)
        do update set is_primary = excluded.is_primary, verified_at = coalesce(profile_phone_numbers.verified_at, now())
        returning id
      `;
      return { id: row!.id };
    });
    return c.json(result, 201);
  });

  app.post('/me/phones/:id/verify', zValidator('json', verifyPhoneSchema), async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    // TODO: validate code against stored hash; placeholder accepts any 6-digit code
    const { code } = c.req.valid('json');
    if (!/^\d{6}$/.test(code)) throw BadRequest('invalid_code');
    await withUserDb(c, async (tx) => {
      const r = await tx<{ id: string }[]>`
        update profile_phone_numbers set verified_at = now()
        where id = ${id} and profile_id = ${user.sub}
        returning id
      `;
      if (r.length === 0) throw NotFound('phone_not_found');
    });
    return c.body(null, 204);
  });

  app.delete('/me/phones/:id', async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    await withUserDb(c, async (tx) => {
      const r = await tx<{ id: string }[]>`
        delete from profile_phone_numbers
        where id = ${id} and profile_id = ${user.sub}
        returning id
      `;
      if (r.length === 0) throw NotFound('phone_not_found');
    });
    return c.body(null, 204);
  });

  return app;
}

export const phonesRoutes = phonesRouter();
