// Instance-admin (gateway operator) routes.
//
// whatsacc is a self-hosted gateway; each deployment has an operator. These
// routes let that operator bootstrap themselves (one-time claim), observe the
// instance (overview / accounts / users / audit), moderate it (suspend
// accounts, disable users, grant/revoke platform admin) and tune the
// abuse-protection rate limits at runtime.
//
// SECURITY MODEL
//   - Everything except the claim endpoints sits behind requireAuth() + a
//     live is_platform_admin check (requireAuth() re-reads the users row per
//     request, so revocation is immediate and the JWT claim is never trusted
//     for gating). Denied attempts are audit-logged.
//   - Cross-tenant reads use the SAME RLS machinery as everything else: the
//     admin transaction runs with app.is_platform_admin=true, which the
//     baseline policies already honor. Tenant RLS is never weakened for
//     normal users; internal tables stay reachable only through the
//     SECURITY DEFINER app.* helpers (baseline internal-role pattern).
//   - Claim flow is fail-closed: no ADMIN_CLAIM_TOKEN → nobody can claim;
//     any admin exists (or the claim was ever redeemed) → the token is dead
//     forever; token comparison is constant-time.

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { MiddlewareHandler } from 'hono';
import { requireAuth, getUser, type AppEnv } from '../middleware/auth.ts';
import { withAnonDb } from '../middleware/rls.ts';
import { withRLS, type TxSql } from '../lib/db.ts';
import type { Context } from 'hono';
import { getEnv } from '../lib/env.ts';
import { BadRequest, Forbidden, NotFound } from '../lib/errors.ts';
import { timingSafeEqualStr, writeAdminAudit } from '../lib/admin.ts';
import {
  INSTANCE_RATE_LIMITS_KEY,
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_OVERRIDE_FIELDS,
  getRateLimitConfig,
  mergeRateLimitConfig,
  readRateLimitOverrides,
  type RateLimitConfig,
  type RateLimitOverrideField,
  type RateLimitOverrides,
} from '../lib/rate-limit.ts';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const claimSchema = z.object({ token: z.string().min(1).max(512) }).strict();

const listQuerySchema = z
  .object({
    query: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .partial({ query: true });

const accountStatusSchema = z
  .object({ status: z.enum(['active', 'suspended']) })
  .strict();

const userStatusSchema = z
  .object({ status: z.enum(['active', 'disabled']) })
  .strict();

const platformAdminSchema = z.object({ grant: z.boolean() }).strict();

const limitValue = z.number().int().min(0).max(1_000_000_000).nullable();
const limitsPatchSchema = z
  .object({
    open_cooldown_s: limitValue.optional(),
    opens_per_hour: limitValue.optional(),
    chat_msgs_per_min: limitValue.optional(),
    account_opens_per_hour: limitValue.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' });

const AUDIT_KINDS = [
  'all',
  'denied',
  'success',
  'open',
  'close',
  'rate_limited',
  'quota_exceeded',
  'account_suspended',
] as const;

const auditQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    kind: z.enum(AUDIT_KINDS).default('all'),
  })
  .partial();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `fn` with the platform-admin RLS context. Only ever called after the
 * admin gate has verified is_platform_admin against the live users row.
 */
async function withAdminDb<T>(c: Context<AppEnv>, fn: (tx: TxSql) => Promise<T>): Promise<T> {
  const user = getUser(c);
  return await withRLS(
    { user_id: user.sub, account_id: null, is_platform_admin: true },
    fn,
  );
}

/**
 * Admin gate. Assumes requireAuth() already ran (claims carry the LIVE
 * is_platform_admin read from the DB this request). Denied attempts are
 * audit-logged best-effort — the 403 never depends on the audit write.
 */
function adminGate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = getUser(c);
    if (!user.is_platform_admin) {
      try {
        await withAnonDb(async (tx) => {
          await writeAdminAudit(tx, {
            actor_user_id: user.sub,
            action: 'admin_access_denied',
            target_kind: 'route',
            target_id: c.req.path,
            allowed: false,
            detail: { method: c.req.method, path: c.req.path },
          });
        });
      } catch (err) {
        console.error('admin_audit_write_failed', err);
      }
      throw Forbidden('not_platform_admin');
    }
    await next();
  };
}

type RateLimitExternal = Record<RateLimitOverrideField, number>;

function configToExternal(cfg: RateLimitConfig): RateLimitExternal {
  return {
    open_cooldown_s: cfg.openCooldownS,
    opens_per_hour: cfg.opensPerHour,
    chat_msgs_per_min: cfg.chatMsgsPerMin,
    account_opens_per_hour: cfg.accountOpensPerHour,
  };
}

function overridesToExternal(o: RateLimitOverrides): Record<RateLimitOverrideField, number | null> {
  const out = {} as Record<RateLimitOverrideField, number | null>;
  for (const field of Object.keys(RATE_LIMIT_OVERRIDE_FIELDS) as RateLimitOverrideField[]) {
    out[field] = o[field] ?? null;
  }
  return out;
}

async function limitsPayload(tx: TxSql) {
  const overrides = await readRateLimitOverrides(tx);
  const envCfg = getRateLimitConfig();
  return {
    defaults: configToExternal(RATE_LIMIT_DEFAULTS),
    env: configToExternal(envCfg),
    overrides: overridesToExternal(overrides),
    effective: configToExternal(mergeRateLimitConfig(envCfg, overrides)),
  };
}

type AuditEntryRow = {
  id: string;
  ts: Date;
  command: string | null;
  source: string | null;
  success: boolean;
  error: string | null;
  account_id: string | null;
  account_name: string | null;
  location_id: string | null;
  location_name: string | null;
  access_point_id: string | null;
  access_point_name: string | null;
  user_id: string | null;
  user_email: string | null;
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function adminRouter() {
  const app = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // First-run claim (authenticated, NOT admin-gated — that's the point)
  // -------------------------------------------------------------------------

  // Claim availability for setup UIs. Boolean-only disclosure.
  app.get('/claim', requireAuth(), async (c) => {
    const tokenConfigured = Boolean(getEnv().ADMIN_CLAIM_TOKEN?.trim());
    const state = await withAnonDb(async (tx) => {
      const rows = await tx<{ admin_exists: boolean; claimed: unknown }[]>`
        select app.platform_admin_exists() as admin_exists,
               app.instance_setting_get('admin_claimed') as claimed
      `;
      return {
        adminExists: Boolean(rows[0]?.admin_exists),
        claimedFlag: rows[0]?.claimed !== null && rows[0]?.claimed !== undefined,
      };
    });
    const claimed = state.adminExists || state.claimedFlag;
    return c.json({ claimed, claimable: tokenConfigured && !claimed });
  });

  app.post('/claim', requireAuth(), zValidator('json', claimSchema), async (c) => {
    const user = getUser(c);
    const { token } = c.req.valid('json');
    const envToken = getEnv().ADMIN_CLAIM_TOKEN?.trim() || null;

    const deny = async (code: string): Promise<never> => {
      try {
        await withAnonDb(async (tx) => {
          await writeAdminAudit(tx, {
            actor_user_id: user.sub,
            action: 'admin_claim',
            target_kind: 'user',
            target_id: user.sub,
            allowed: false,
            detail: { reason: code },
          });
        });
      } catch (err) {
        console.error('admin_audit_write_failed', err);
      }
      throw Forbidden(code);
    };

    const state = await withAnonDb(async (tx) => {
      const rows = await tx<{ admin_exists: boolean; claimed: unknown }[]>`
        select app.platform_admin_exists() as admin_exists,
               app.instance_setting_get('admin_claimed') as claimed
      `;
      return {
        adminExists: Boolean(rows[0]?.admin_exists),
        claimedFlag: rows[0]?.claimed !== null && rows[0]?.claimed !== undefined,
      };
    });

    // Burned forever once any platform admin exists (or a claim ever won).
    if (state.adminExists || state.claimedFlag) return await deny('claim_closed');
    // Fail-closed: no token configured → nobody can claim.
    if (!envToken) return await deny('claim_disabled');
    if (!(await timingSafeEqualStr(token, envToken))) return await deny('invalid_claim_token');

    // Atomic in SQL: exactly one caller can win even under concurrency.
    const won = await withAnonDb(async (tx) => {
      const rows = await tx<{ ok: boolean }[]>`
        select app.claim_platform_admin(${user.sub}::uuid) as ok
      `;
      if (rows[0]?.ok) {
        await writeAdminAudit(tx, {
          actor_user_id: user.sub,
          action: 'admin_claim',
          target_kind: 'user',
          target_id: user.sub,
          allowed: true,
          detail: { email: user.email },
        });
      }
      return Boolean(rows[0]?.ok);
    });
    if (!won) return await deny('claim_closed');

    console.log(`[admin] instance claimed by ${user.email} (${user.sub})`);
    return c.json({ ok: true, user_id: user.sub, is_platform_admin: true });
  });

  // -------------------------------------------------------------------------
  // Everything below: platform admins only
  // -------------------------------------------------------------------------
  app.use('*', requireAuth());
  app.use('*', adminGate());

  // ---- Overview -----------------------------------------------------------

  app.get('/overview', async (c) => {
    const data = await withAdminDb(c, async (tx) => {
      const totals = await tx<{
        users: number;
        accounts: number;
        locations: number;
        devices: number;
        access_points: number;
      }[]>`
        select
          (select count(*) from users)::int as users,
          (select count(*) from accounts)::int as accounts,
          (select count(*) from locations)::int as locations,
          (select count(*) from devices)::int as devices,
          (select count(*) from access_points)::int as access_points
      `;
      const opens = await tx<{ today: number; last_7d: number }[]>`
        select
          (select count(*) from access_logs
            where command = 'open' and success = true
              and ts >= date_trunc('day', now()))::int as today,
          (select count(*) from access_logs
            where command = 'open' and success = true
              and ts >= date_trunc('day', now()) - interval '6 days')::int as last_7d
      `;
      const denialRows = await tx<{ reason: string; n: number }[]>`
        select coalesce(error, 'other') as reason, count(*)::int as n
        from access_logs
        where success = false and ts >= date_trunc('day', now())
        group by 1
      `;
      const signups = await tx<{
        id: string;
        email: string;
        display_name: string | null;
        status: string;
        is_platform_admin: boolean;
        created_at: Date;
      }[]>`
        select u.id, u.email::text as email, p.display_name, u.status,
               u.is_platform_admin, u.created_at
        from users u
        left join profiles p on p.id = u.id
        order by u.created_at desc
        limit 10
      `;
      return { totals: totals[0]!, opens: opens[0]!, denialRows, signups };
    });

    const denials: Record<string, number> = {
      rate_limited: 0,
      quota_exceeded: 0,
      account_suspended: 0,
      other: 0,
    };
    let denialsTotal = 0;
    for (const r of data.denialRows) {
      const key = r.reason in denials ? r.reason : 'other';
      denials[key] = (denials[key] ?? 0) + Number(r.n);
      denialsTotal += Number(r.n);
    }

    return c.json({
      totals: data.totals,
      opens: data.opens,
      denials_today: { total: denialsTotal, ...denials },
      recent_signups: data.signups,
    });
  });

  // ---- Accounts -----------------------------------------------------------

  app.get('/accounts', zValidator('query', listQuerySchema), async (c) => {
    const q = c.req.valid('query');
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const pattern = q.query ? `%${q.query}%` : null;

    const data = await withAdminDb(c, async (tx) => {
      const rows = await tx<{
        id: string;
        name: string;
        status: string;
        country_code: string;
        created_at: Date;
        member_count: number;
        location_count: number;
        opens_7d: number;
      }[]>`
        select a.id, a.name, a.status, a.country_code, a.created_at,
               (select count(*) from account_members am where am.account_id = a.id)::int as member_count,
               (select count(*) from locations l where l.account_id = a.id)::int as location_count,
               (select count(*) from access_logs al
                 where al.account_id = a.id and al.command = 'open' and al.success = true
                   and al.ts >= date_trunc('day', now()) - interval '6 days')::int as opens_7d
        from accounts a
        where (${pattern}::text is null or a.name ilike ${pattern}::text)
        order by a.created_at desc
        limit ${limit} offset ${offset}
      `;
      const totalRows = await tx<{ total: number }[]>`
        select count(*)::int as total from accounts a
        where (${pattern}::text is null or a.name ilike ${pattern}::text)
      `;
      return { rows, total: Number(totalRows[0]?.total ?? 0) };
    });

    return c.json({ accounts: data.rows, total: data.total, limit, offset });
  });

  app.get('/accounts/:id', async (c) => {
    const id = c.req.param('id');
    const data = await withAdminDb(c, async (tx) => {
      const acct = await tx<{
        id: string;
        name: string;
        status: string;
        country_code: string;
        created_at: Date;
        updated_at: Date;
      }[]>`
        select id, name, status, country_code, created_at, updated_at
        from accounts where id = ${id}
      `;
      if (!acct[0]) return null;

      const members = await tx<{
        user_id: string;
        email: string;
        display_name: string | null;
        role: string;
        status: string;
        joined_at: Date;
      }[]>`
        select am.user_id, u.email::text as email, p.display_name,
               am.role, am.status, am.joined_at
        from account_members am
        join users u on u.id = am.user_id
        left join profiles p on p.id = am.user_id
        where am.account_id = ${id}
        order by am.joined_at asc
      `;

      const locations = await tx<{
        id: string;
        name: string;
        type: string;
        slug: string;
        status: string;
        created_at: Date;
      }[]>`
        select id, name, type, slug, status, created_at
        from locations where account_id = ${id}
        order by created_at asc
      `;

      const recent = await tx<AuditEntryRow[]>`
        select al.id, al.ts, al.command, al.source, al.success, al.error,
               al.account_id, a.name as account_name,
               al.location_id, l.name as location_name,
               al.access_point_id, ap.name as access_point_name,
               al.user_id, u.email::text as user_email
        from access_logs al
        left join accounts a on a.id = al.account_id
        left join locations l on l.id = al.location_id
        left join access_points ap on ap.id = al.access_point_id
        left join users u on u.id = al.user_id
        where al.account_id = ${id}
        order by al.ts desc
        limit 25
      `;

      return { account: acct[0], members, locations, recent_access_logs: recent };
    });
    if (!data) throw NotFound('account_not_found');
    return c.json(data);
  });

  app.patch('/accounts/:id', zValidator('json', accountStatusSchema), async (c) => {
    const me = getUser(c);
    const id = c.req.param('id');
    const { status } = c.req.valid('json');

    const updated = await withAdminDb(c, async (tx) => {
      const rows = await tx<{
        id: string;
        name: string;
        status: string;
        country_code: string;
        created_at: Date;
        updated_at: Date;
      }[]>`
        update accounts
        set status = ${status}, updated_at = now()
        where id = ${id}
        returning id, name, status, country_code, created_at, updated_at
      `;
      const acct = rows[0] ?? null;
      if (acct) {
        await writeAdminAudit(tx, {
          actor_user_id: me.sub,
          action: 'account_status',
          target_kind: 'account',
          target_id: id,
          allowed: true,
          detail: { status },
        });
      }
      return acct;
    });
    if (!updated) throw NotFound('account_not_found');
    return c.json({ account: updated });
  });

  // ---- Users --------------------------------------------------------------

  app.get('/users', zValidator('query', listQuerySchema), async (c) => {
    const q = c.req.valid('query');
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const pattern = q.query ? `%${q.query}%` : null;

    const data = await withAdminDb(c, async (tx) => {
      const rows = await tx<{
        id: string;
        email: string;
        status: string;
        is_platform_admin: boolean;
        created_at: Date;
        display_name: string | null;
        accounts: { account_id: string; name: string; role: string }[];
        last_access_at: Date | null;
      }[]>`
        select u.id, u.email::text as email, u.status, u.is_platform_admin,
               u.created_at, p.display_name,
               coalesce(
                 (select json_agg(json_build_object(
                    'account_id', a.id, 'name', a.name, 'role', am.role))
                  from account_members am
                  join accounts a on a.id = am.account_id
                  where am.user_id = u.id),
                 '[]'::json
               ) as accounts,
               (select max(al.ts) from access_logs al where al.user_id = u.id) as last_access_at
        from users u
        left join profiles p on p.id = u.id
        where (${pattern}::text is null or u.email::text ilike ${pattern}::text)
        order by u.created_at desc
        limit ${limit} offset ${offset}
      `;
      const totalRows = await tx<{ total: number }[]>`
        select count(*)::int as total from users u
        where (${pattern}::text is null or u.email::text ilike ${pattern}::text)
      `;
      return { rows, total: Number(totalRows[0]?.total ?? 0) };
    });

    return c.json({ users: data.rows, total: data.total, limit, offset });
  });

  app.patch('/users/:id', zValidator('json', userStatusSchema), async (c) => {
    const me = getUser(c);
    const id = c.req.param('id');
    const { status } = c.req.valid('json');

    if (status === 'disabled' && id === me.sub) {
      throw BadRequest('cannot_disable_self', 'You cannot disable your own user');
    }

    const updated = await withAdminDb(c, async (tx) => {
      const targetRows = await tx<{
        id: string;
        email: string;
        status: string;
        is_platform_admin: boolean;
      }[]>`
        select id, email::text as email, status, is_platform_admin
        from users where id = ${id}
      `;
      const target = targetRows[0];
      if (!target) return null;

      if (status === 'disabled' && target.is_platform_admin) {
        const others = await tx<{ n: number }[]>`
          select count(*)::int as n from users
          where is_platform_admin = true and status = 'active' and id <> ${id}
        `;
        if (Number(others[0]?.n ?? 0) === 0) {
          throw BadRequest(
            'cannot_disable_last_admin',
            'This is the last active platform admin — grant another admin first',
          );
        }
      }

      const rows = await tx<{
        id: string;
        email: string;
        status: string;
        is_platform_admin: boolean;
      }[]>`
        update users set status = ${status}, updated_at = now()
        where id = ${id}
        returning id, email::text as email, status, is_platform_admin
      `;

      if (status === 'disabled') {
        // Kill refresh immediately; access tokens die at the live gate in
        // requireAuth() on their next use.
        await tx`
          update refresh_tokens set revoked_at = now()
          where user_id = ${id} and revoked_at is null
        `;
      }

      await writeAdminAudit(tx, {
        actor_user_id: me.sub,
        action: 'user_status',
        target_kind: 'user',
        target_id: id,
        allowed: true,
        detail: { status, email: target.email },
      });

      return rows[0] ?? null;
    });
    if (!updated) throw NotFound('user_not_found');
    return c.json({ user: updated });
  });

  app.post('/users/:id/platform-admin', zValidator('json', platformAdminSchema), async (c) => {
    const me = getUser(c);
    const id = c.req.param('id');
    const { grant } = c.req.valid('json');

    const updated = await withAdminDb(c, async (tx) => {
      const targetRows = await tx<{
        id: string;
        email: string;
        status: string;
        is_platform_admin: boolean;
      }[]>`
        select id, email::text as email, status, is_platform_admin
        from users where id = ${id}
      `;
      const target = targetRows[0];
      if (!target) return null;

      if (!grant && target.is_platform_admin) {
        const others = await tx<{ n: number }[]>`
          select count(*)::int as n from users
          where is_platform_admin = true and status = 'active' and id <> ${id}
        `;
        if (Number(others[0]?.n ?? 0) === 0) {
          throw BadRequest(
            'cannot_revoke_last_admin',
            'This is the last active platform admin — grant another admin first',
          );
        }
      }

      const rows = await tx<{
        id: string;
        email: string;
        status: string;
        is_platform_admin: boolean;
      }[]>`
        update users set is_platform_admin = ${grant}, updated_at = now()
        where id = ${id}
        returning id, email::text as email, status, is_platform_admin
      `;

      await writeAdminAudit(tx, {
        actor_user_id: me.sub,
        action: 'platform_admin',
        target_kind: 'user',
        target_id: id,
        allowed: true,
        detail: { grant, email: target.email },
      });

      return rows[0] ?? null;
    });
    if (!updated) throw NotFound('user_not_found');
    return c.json({ user: updated });
  });

  // ---- Rate-limit overrides ----------------------------------------------

  app.get('/limits', async (c) => {
    const payload = await withAdminDb(c, async (tx) => await limitsPayload(tx));
    return c.json(payload);
  });

  app.patch('/limits', zValidator('json', limitsPatchSchema), async (c) => {
    const me = getUser(c);
    const patch = c.req.valid('json');

    const payload = await withAdminDb(c, async (tx) => {
      const current = await readRateLimitOverrides(tx);
      const next: RateLimitOverrides = { ...current };
      for (const field of Object.keys(RATE_LIMIT_OVERRIDE_FIELDS) as RateLimitOverrideField[]) {
        const v = patch[field];
        if (v === undefined) continue;
        if (v === null) delete next[field];
        else next[field] = v;
      }
      await tx`
        select app.instance_setting_set(
          ${INSTANCE_RATE_LIMITS_KEY},
          ${tx.json(next)}::jsonb,
          ${me.sub}::uuid
        )
      `;
      await writeAdminAudit(tx, {
        actor_user_id: me.sub,
        action: 'limits_update',
        target_kind: 'instance',
        target_id: INSTANCE_RATE_LIMITS_KEY,
        allowed: true,
        detail: { patch, overrides: next },
      });
      return await limitsPayload(tx);
    });

    return c.json(payload);
  });

  // ---- Audit --------------------------------------------------------------

  // Cross-account access_logs (opens/closes/denials). RLS grants platform
  // admins the full view via the baseline policies — tenants stay scoped.
  app.get('/audit', zValidator('query', auditQuerySchema), async (c) => {
    const q = c.req.valid('query');
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const kind = q.kind ?? 'all';

    let successFilter: boolean | null = null;
    let commandFilter: string | null = null;
    let errorFilter: string | null = null;
    if (kind === 'denied') successFilter = false;
    else if (kind === 'success') successFilter = true;
    else if (kind === 'open' || kind === 'close') commandFilter = kind;
    else if (kind !== 'all') errorFilter = kind;

    const data = await withAdminDb(c, async (tx) => {
      const rows = await tx<AuditEntryRow[]>`
        select al.id, al.ts, al.command, al.source, al.success, al.error,
               al.account_id, a.name as account_name,
               al.location_id, l.name as location_name,
               al.access_point_id, ap.name as access_point_name,
               al.user_id, u.email::text as user_email
        from access_logs al
        left join accounts a on a.id = al.account_id
        left join locations l on l.id = al.location_id
        left join access_points ap on ap.id = al.access_point_id
        left join users u on u.id = al.user_id
        where (${successFilter}::boolean is null or al.success = ${successFilter}::boolean)
          and (${commandFilter}::text is null or al.command = ${commandFilter}::text)
          and (${errorFilter}::text is null or al.error = ${errorFilter}::text)
        order by al.ts desc
        limit ${limit} offset ${offset}
      `;
      const totalRows = await tx<{ total: number }[]>`
        select count(*)::int as total
        from access_logs al
        where (${successFilter}::boolean is null or al.success = ${successFilter}::boolean)
          and (${commandFilter}::text is null or al.command = ${commandFilter}::text)
          and (${errorFilter}::text is null or al.error = ${errorFilter}::text)
      `;
      return { rows, total: Number(totalRows[0]?.total ?? 0) };
    });

    return c.json({ entries: data.rows, total: data.total, limit, offset, kind });
  });

  // Admin-action trail (claims, suspensions, grants, denied /admin probes).
  app.get('/audit/actions', zValidator('query', auditQuerySchema), async (c) => {
    const q = c.req.valid('query');
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;

    const data = await withAdminDb(c, async (tx) => {
      const rows = await tx<{
        id: string;
        actor_user_id: string | null;
        actor_email: string | null;
        action: string;
        target_kind: string | null;
        target_id: string | null;
        allowed: boolean;
        detail: unknown;
        created_at: Date;
      }[]>`
        select aal.id, aal.actor_user_id, u.email::text as actor_email,
               aal.action, aal.target_kind, aal.target_id, aal.allowed,
               aal.detail, aal.created_at
        from admin_audit_log aal
        left join users u on u.id = aal.actor_user_id
        order by aal.created_at desc
        limit ${limit} offset ${offset}
      `;
      const totalRows = await tx<{ total: number }[]>`
        select count(*)::int as total from admin_audit_log
      `;
      return { rows, total: Number(totalRows[0]?.total ?? 0) };
    });

    return c.json({ actions: data.rows, total: data.total, limit, offset });
  });

  return app;
}

export const adminRoutes = adminRouter();
