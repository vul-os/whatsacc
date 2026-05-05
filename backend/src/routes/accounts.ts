import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, getUser, type AppEnv } from '../middleware/auth.ts';
import { withUserDb, withAnonDb } from '../middleware/rls.ts';
import { BadRequest, NotFound } from '../lib/errors.ts';
import { randomToken } from '../lib/random.ts';
import { hashToken } from '../lib/refresh.ts';

const createAccountSchema = z
  .object({
    name: z.string().min(1).max(120),
    billing_type: z.enum(['personal', 'business']).default('personal'),
  })
  .strict();

const inviteSchema = z
  .object({
    email: z.string().email().toLowerCase(),
    role: z.enum(['owner', 'admin', 'member', 'viewer']).default('member'),
  })
  .strict();

const acceptInviteSchema = z.object({}).strict();

function accountsRouter() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth());

  app.get('/', async (c) => {
    const user = getUser(c);
    const rows = await withUserDb(c, async (tx) => {
      return await tx<{
        id: string;
        name: string;
        billing_type: string;
        role: string;
        status: string;
      }[]>`
        select a.id, a.name, a.billing_type, am.role, am.status
        from account_members am
        join accounts a on a.id = am.account_id
        where am.user_id = ${user.sub}
        order by a.created_at desc
      `;
    });
    return c.json({ accounts: rows });
  });

  app.post('/', zValidator('json', createAccountSchema), async (c) => {
    const user = getUser(c);
    const { name, billing_type } = c.req.valid('json');
    const account = await withUserDb(c, async (tx) => {
      const [a] = await tx<{ id: string }[]>`
        insert into accounts (name, billing_type, status)
        values (${name}, ${billing_type}, 'active')
        returning id
      `;
      const accountId = a!.id;
      await tx`
        insert into account_members (account_id, user_id, role, status)
        values (${accountId}, ${user.sub}, 'owner', 'active')
      `;
      return { id: accountId };
    });
    return c.json(account, 201);
  });

  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const data = await withUserDb(c, async (tx) => {
      const rows = await tx<{
        id: string;
        name: string;
        billing_type: string;
        billing_address: unknown;
        status: string;
      }[]>`
        select id, name, billing_type, billing_address, status
        from accounts where id = ${id}
      `;
      return rows[0] ?? null;
    });
    if (!data) throw NotFound('account_not_found');
    return c.json(data);
  });

  app.get('/:id/members', async (c) => {
    const id = c.req.param('id');
    const rows = await withUserDb(c, async (tx) => {
      return await tx<{
        user_id: string;
        role: string;
        status: string;
        email: string;
        display_name: string | null;
      }[]>`
        select am.user_id, am.role, am.status, u.email, p.display_name
        from account_members am
        join users u on u.id = am.user_id
        left join profiles p on p.id = u.id
        where am.account_id = ${id}
      `;
    });
    return c.json({ members: rows });
  });

  app.post('/:id/invites', zValidator('json', inviteSchema), async (c) => {
    const id = c.req.param('id');
    const { email, role } = c.req.valid('json');
    const tokenPlain = randomToken(32);
    const tokenHash = await hashToken(tokenPlain);
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const inviteId = await withUserDb(c, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into account_invites (account_id, email, role, token_hash, expires_at)
        values (${id}, ${email}, ${role}, ${tokenHash}, ${expires})
        returning id
      `;
      return row!.id;
    });
    // TODO: send invite email with the plaintext token link
    return c.json({ id: inviteId, token: tokenPlain }, 201);
  });

  // accepting an invite cannot use the user's account scope (not a member yet)
  app.post('/invites/:token/accept', zValidator('json', acceptInviteSchema), async (c) => {
    const user = getUser(c);
    const token = c.req.param('token');
    const tokenHash = await hashToken(token);

    const result = await withAnonDb(async (tx) => {
      const rows = await tx<{
        id: string;
        account_id: string;
        email: string;
        role: string;
        expires_at: Date;
        accepted_at: Date | null;
        revoked_at: Date | null;
      }[]>`
        select id, account_id, email, role, expires_at, accepted_at, revoked_at
        from account_invites where token_hash = ${tokenHash}
        for update
      `;
      const inv = rows[0];
      if (!inv) throw NotFound('invite_not_found');
      if (inv.accepted_at) throw BadRequest('invite_used');
      if (inv.revoked_at) throw BadRequest('invite_revoked');
      if (inv.expires_at.getTime() <= Date.now()) throw BadRequest('invite_expired');

      const userEmailRows = await tx<{ email: string }[]>`
        select email from users where id = ${user.sub}
      `;
      if (!userEmailRows[0] || userEmailRows[0].email !== inv.email) {
        throw BadRequest('invite_email_mismatch');
      }

      await tx`
        insert into account_members (account_id, user_id, role, status)
        values (${inv.account_id}, ${user.sub}, ${inv.role}, 'active')
        on conflict (account_id, user_id) do update set role = excluded.role, status = 'active'
      `;
      await tx`
        update account_invites set accepted_at = now(), accepted_by = ${user.sub}
        where id = ${inv.id}
      `;
      return { account_id: inv.account_id, role: inv.role };
    });

    return c.json(result);
  });

  return app;
}

export const accountsRoutes = accountsRouter();
