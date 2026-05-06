import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, getUser, type AppEnv } from '../middleware/auth.ts';
import { withAnonDb, withUserDb } from '../middleware/rls.ts';
import { BadRequest, Conflict, NotFound, Forbidden } from '../lib/errors.ts';
import { isValidSlug, RESERVED_SLUGS } from '../lib/slug.ts';
import type { TxSql } from '../lib/db.ts';

const MIN_PAYOUT_CENTS = 50_000; // R 500
const SLUG_CHANGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const slugUpdateSchema = z
  .object({
    slug: z
      .string()
      .min(3)
      .max(30)
      .transform((v) => v.toLowerCase()),
  })
  .strict();

const kycSchema = z
  .object({
    full_name: z.string().min(1).max(120).optional(),
    contact_email: z.string().email().toLowerCase().optional(),
    cellphone: z
      .string()
      .min(7)
      .max(20)
      .regex(/^[+\d\s\-()]+$/)
      .optional(),
    id_kind: z.enum(['za_id', 'passport']).optional(),
    id_number: z.string().min(4).max(40).optional(),
    bank_name: z.string().min(1).max(120).optional(),
    bank_branch_code: z
      .string()
      .min(3)
      .max(20)
      .regex(/^\d+$/)
      .optional(),
    bank_account_number: z
      .string()
      .min(4)
      .max(34)
      .regex(/^[\dA-Z]+$/i)
      .optional(),
    bank_account_holder: z.string().min(1).max(120).optional(),
    bank_account_type: z.enum(['cheque', 'savings', 'transmission']).optional(),
  })
  .strict();

const payoutRequestSchema = z
  .object({
    amount_zar_cents: z.number().int().min(MIN_PAYOUT_CENTS).max(100_000_000),
  })
  .strict();

type KycRow = {
  user_id: string;
  full_name: string | null;
  contact_email: string | null;
  cellphone: string | null;
  id_kind: string | null;
  id_number: string | null;
  bank_name: string | null;
  bank_branch_code: string | null;
  bank_account_number: string | null;
  bank_account_holder: string | null;
  bank_account_type: string | null;
  verified_at: Date | null;
  updated_at: Date;
};

function kycComplete(k: KycRow | null): boolean {
  if (!k) return false;
  return (
    !!k.full_name &&
    !!k.cellphone &&
    !!k.id_kind &&
    !!k.id_number &&
    !!k.bank_name &&
    !!k.bank_branch_code &&
    !!k.bank_account_number &&
    !!k.bank_account_holder &&
    !!k.bank_account_type
  );
}

async function loadKyc(tx: TxSql, userId: string): Promise<KycRow | null> {
  const rows = await tx<KycRow[]>`
    select user_id, full_name, contact_email, cellphone, id_kind, id_number,
           bank_name, bank_branch_code, bank_account_number, bank_account_holder,
           bank_account_type, verified_at, updated_at
    from kyc_profiles
    where user_id = ${userId}
  `;
  return rows[0] ?? null;
}

async function computeBalance(
  tx: TxSql,
  userId: string,
): Promise<{
  earned_cents: number;
  paid_out_cents: number;
  pending_cents: number;
  available_cents: number;
}> {
  const earnedRows = await tx<{ sum: string | null }[]>`
    select coalesce(sum(amount_zar_cents), 0)::bigint::text as sum
    from referral_earnings
    where referrer_user_id = ${userId}
  `;
  const paidRows = await tx<{ sum: string | null }[]>`
    select coalesce(sum(amount_zar_cents), 0)::bigint::text as sum
    from payout_requests
    where user_id = ${userId} and status = 'paid'
  `;
  const pendingRows = await tx<{ sum: string | null }[]>`
    select coalesce(sum(amount_zar_cents), 0)::bigint::text as sum
    from payout_requests
    where user_id = ${userId} and status in ('pending','approved')
  `;
  const earned = Number(earnedRows[0]?.sum ?? 0);
  const paid = Number(paidRows[0]?.sum ?? 0);
  const pending = Number(pendingRows[0]?.sum ?? 0);
  return {
    earned_cents: earned,
    paid_out_cents: paid,
    pending_cents: pending,
    available_cents: Math.max(0, earned - paid - pending),
  };
}

function referralsRouter() {
  const app = new Hono<AppEnv>();

  // Public: resolve a slug to a referrer summary so the /r/:slug landing page
  // can show "you were referred by X" before signup.
  app.get('/resolve/:slug', async (c) => {
    const slug = c.req.param('slug').toLowerCase();
    if (!isValidSlug(slug)) throw NotFound('slug_not_found');
    const data = await withAnonDb(async (tx) => {
      const rows = await tx<{ id: string; display_name: string | null; avatar_url: string | null }[]>`
        select u.id, p.display_name, p.avatar_url
        from users u
        left join profiles p on p.id = u.id
        where u.referral_slug = ${slug} and u.status = 'active'
      `;
      return rows[0] ?? null;
    });
    if (!data) throw NotFound('slug_not_found');
    return c.json({
      slug,
      display_name: data.display_name ?? slug,
      avatar_url: data.avatar_url,
    });
  });

  // ----------------------------- authed below ------------------------------
  app.use('*', requireAuth());

  app.get('/me', async (c) => {
    const user = getUser(c);
    const data = await withUserDb(c, async (tx) => {
      const meRows = await tx<{
        id: string;
        referral_slug: string | null;
        referral_slug_updated_at: Date | null;
        referred_by_user_id: string | null;
      }[]>`
        select id, referral_slug, referral_slug_updated_at, referred_by_user_id
        from users where id = ${user.sub}
      `;
      const me = meRows[0]!;
      const balance = await computeBalance(tx, user.sub);
      const counts = await tx<{ active: string; total: string }[]>`
        select
          count(distinct re.referee_user_id) filter (where re.created_at > now() - interval '30 days')::text as active,
          (select count(*)::text from referral_attributions where referrer_user_id = ${user.sub}) as total
        from referral_earnings re
        where re.referrer_user_id = ${user.sub}
      `;
      const recent = await tx<{
        id: string;
        amount_zar_cents: string;
        source_kind: string;
        rate_bps: number;
        created_at: Date;
        referee_user_id: string;
        referee_email: string | null;
      }[]>`
        select re.id, re.amount_zar_cents::text, re.source_kind, re.rate_bps, re.created_at,
               re.referee_user_id, u.email::text as referee_email
        from referral_earnings re
        left join users u on u.id = re.referee_user_id
        where re.referrer_user_id = ${user.sub}
        order by re.created_at desc
        limit 25
      `;
      const payouts = await tx<{
        id: string;
        amount_zar_cents: string;
        status: string;
        requested_at: Date;
        processed_at: Date | null;
        notes: string | null;
      }[]>`
        select id, amount_zar_cents::text, status, requested_at, processed_at, notes
        from payout_requests
        where user_id = ${user.sub}
        order by requested_at desc
        limit 25
      `;
      const kyc = await loadKyc(tx, user.sub);

      return {
        slug: me.referral_slug,
        slug_updated_at: me.referral_slug_updated_at,
        referred_by_user_id: me.referred_by_user_id,
        balance,
        counts: {
          referees_total: Number(counts[0]?.total ?? 0),
          referees_active_30d: Number(counts[0]?.active ?? 0),
        },
        recent_earnings: recent.map((r) => ({
          id: r.id,
          amount_zar_cents: Number(r.amount_zar_cents),
          source_kind: r.source_kind,
          rate_bps: r.rate_bps,
          created_at: r.created_at,
          referee_email_masked: maskEmail(r.referee_email),
        })),
        payouts: payouts.map((p) => ({
          id: p.id,
          amount_zar_cents: Number(p.amount_zar_cents),
          status: p.status,
          requested_at: p.requested_at,
          processed_at: p.processed_at,
          notes: p.notes,
        })),
        kyc_status: {
          complete: kycComplete(kyc),
          verified_at: kyc?.verified_at ?? null,
        },
        min_payout_cents: MIN_PAYOUT_CENTS,
      };
    });
    return c.json(data);
  });

  app.put('/slug', zValidator('json', slugUpdateSchema), async (c) => {
    const user = getUser(c);
    const { slug } = c.req.valid('json');
    if (!isValidSlug(slug)) {
      throw BadRequest(
        'invalid_slug',
        RESERVED_SLUGS.has(slug) ? 'reserved' : '3-30 lowercase letters, digits, hyphens',
      );
    }
    const result = await withUserDb(c, async (tx) => {
      const rows = await tx<{ referral_slug_updated_at: Date | null }[]>`
        select referral_slug_updated_at from users where id = ${user.sub}
      `;
      const last = rows[0]?.referral_slug_updated_at;
      if (last && Date.now() - last.getTime() < SLUG_CHANGE_COOLDOWN_MS) {
        throw BadRequest('slug_change_cooldown', 'You can change your slug once per 24 hours.');
      }
      try {
        const updated = await tx<{ referral_slug: string }[]>`
          update users
          set referral_slug = ${slug}, referral_slug_updated_at = now(), updated_at = now()
          where id = ${user.sub}
          returning referral_slug
        `;
        return { slug: updated[0]!.referral_slug };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23505') throw Conflict('slug_taken');
        if (code === '23514') throw BadRequest('invalid_slug');
        throw err;
      }
    });
    return c.json(result);
  });

  app.get('/kyc', async (c) => {
    const user = getUser(c);
    const k = await withUserDb(c, async (tx) => loadKyc(tx, user.sub));
    return c.json({ kyc: k, complete: kycComplete(k) });
  });

  app.put('/kyc', zValidator('json', kycSchema), async (c) => {
    const user = getUser(c);
    const body = c.req.valid('json');
    const result = await withUserDb(c, async (tx) => {
      await tx`
        insert into kyc_profiles
          (user_id, full_name, contact_email, cellphone, id_kind, id_number,
           bank_name, bank_branch_code, bank_account_number, bank_account_holder,
           bank_account_type)
        values
          (${user.sub}, ${body.full_name ?? null}, ${body.contact_email ?? null},
           ${body.cellphone ?? null}, ${body.id_kind ?? null}, ${body.id_number ?? null},
           ${body.bank_name ?? null}, ${body.bank_branch_code ?? null},
           ${body.bank_account_number ?? null}, ${body.bank_account_holder ?? null},
           ${body.bank_account_type ?? null})
        on conflict (user_id) do update set
          full_name = coalesce(excluded.full_name, kyc_profiles.full_name),
          contact_email = coalesce(excluded.contact_email, kyc_profiles.contact_email),
          cellphone = coalesce(excluded.cellphone, kyc_profiles.cellphone),
          id_kind = coalesce(excluded.id_kind, kyc_profiles.id_kind),
          id_number = coalesce(excluded.id_number, kyc_profiles.id_number),
          bank_name = coalesce(excluded.bank_name, kyc_profiles.bank_name),
          bank_branch_code = coalesce(excluded.bank_branch_code, kyc_profiles.bank_branch_code),
          bank_account_number = coalesce(excluded.bank_account_number, kyc_profiles.bank_account_number),
          bank_account_holder = coalesce(excluded.bank_account_holder, kyc_profiles.bank_account_holder),
          bank_account_type = coalesce(excluded.bank_account_type, kyc_profiles.bank_account_type),
          updated_at = now()
      `;
      const fresh = await loadKyc(tx, user.sub);
      return { kyc: fresh, complete: kycComplete(fresh) };
    });
    return c.json(result);
  });

  app.post('/payouts', zValidator('json', payoutRequestSchema), async (c) => {
    const user = getUser(c);
    const { amount_zar_cents } = c.req.valid('json');
    const result = await withUserDb(c, async (tx) => {
      // Serialise concurrent payout creates for this user. Without this,
      // two simultaneous requests under READ COMMITTED can each see
      // available=N before either inserts a pending row, then both insert
      // and total pending > earned.
      await tx`select pg_advisory_xact_lock(hashtextextended('payout:' || ${user.sub}, 0))`;
      const kyc = await loadKyc(tx, user.sub);
      if (!kycComplete(kyc)) throw Forbidden('kyc_incomplete');
      const balance = await computeBalance(tx, user.sub);
      if (amount_zar_cents > balance.available_cents) {
        throw BadRequest(
          'insufficient_balance',
          `available R ${(balance.available_cents / 100).toFixed(2)}`,
        );
      }
      const snapshot = {
        full_name: kyc!.full_name,
        contact_email: kyc!.contact_email,
        cellphone: kyc!.cellphone,
        id_kind: kyc!.id_kind,
        id_number: kyc!.id_number,
        bank_name: kyc!.bank_name,
        bank_branch_code: kyc!.bank_branch_code,
        bank_account_number: kyc!.bank_account_number,
        bank_account_holder: kyc!.bank_account_holder,
        bank_account_type: kyc!.bank_account_type,
      };
      const [row] = await tx<{ id: string }[]>`
        insert into payout_requests (user_id, amount_zar_cents, status, kyc_snapshot)
        values (${user.sub}, ${amount_zar_cents}, 'pending', ${tx.json(snapshot)})
        returning id
      `;
      return { id: row!.id };
    });
    return c.json(result, 201);
  });

  app.post('/payouts/:id/cancel', async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    await withUserDb(c, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        update payout_requests
        set status = 'cancelled', processed_at = now()
        where id = ${id} and user_id = ${user.sub} and status = 'pending'
        returning id
      `;
      if (rows.length === 0) throw NotFound('payout_not_cancellable');
    });
    return c.body(null, 204);
  });

  return app;
}

function maskEmail(email: string | null): string {
  if (!email) return '***';
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const head = local.length <= 2 ? local[0] ?? '*' : local.slice(0, 2);
  return `${head}***@${domain}`;
}

export const referralsRoutes = referralsRouter();
