import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv } from '../middleware/auth.ts';
import { requireAuth, getUser } from '../middleware/auth.ts';
import { withAnonDb, withUserDb } from '../middleware/rls.ts';
import { hashPassword, verifyPassword } from '../lib/password.ts';
import { signAccessToken, signShortToken, verifyShortToken } from '../lib/jwt.ts';
import { mintRefreshToken, hashToken, REFRESH_TTL_SECONDS } from '../lib/refresh.ts';
import { randomToken } from '../lib/random.ts';
import { renderEmail, sendEmail, escapeHtml } from '../lib/email.ts';
import {
  buildAuthUrl,
  exchangeCode,
  makePkce,
  verifyIdToken,
} from '../lib/google.ts';
import { BadRequest, Conflict, Forbidden, NotFound, Unauthorized } from '../lib/errors.ts';
import { getEnv } from '../lib/env.ts';
import { isValidSlug, randomSlug } from '../lib/slug.ts';
import type { TxSql } from '../lib/db.ts';

const ACCESS_TTL = 15 * 60; // 15 min

const registerSchema = z
  .object({
    email: z.string().email().toLowerCase(),
    password: z.string().min(8).max(256),
    display_name: z.string().min(1).max(120),
    country_code: z
      .string()
      .length(2)
      .transform((v) => v.toUpperCase())
      .default('ZA'),
    account_type: z.enum(['personal', 'business']).default('personal'),
    referral_slug: z
      .string()
      .min(3)
      .max(30)
      .transform((v) => v.toLowerCase())
      .optional(),
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().email().toLowerCase(),
    password: z.string().min(1).max(256),
  })
  .strict();

const refreshSchema = z.object({ refresh_token: z.string().min(1) }).strict();
const logoutSchema = z.object({ refresh_token: z.string().min(1) }).strict();
const forgotSchema = z.object({ email: z.string().email().toLowerCase() }).strict();
const resetSchema = z
  .object({ token: z.string().min(1), new_password: z.string().min(8).max(256) })
  .strict();
const updatePasswordSchema = z
  .object({
    current_password: z.string().min(1).max(256),
    new_password: z.string().min(8).max(256),
  })
  .strict();
const verifyEmailSchema = z.object({ token: z.string().min(1) }).strict();

type UserRow = {
  id: string;
  email: string;
  password_hash: string | null;
  status: string;
  email_verified_at: Date | null;
  is_platform_admin: boolean;
};

type RefreshRow = {
  id: string;
  family_id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
};

async function assignNewUserSlug(tx: TxSql, userId: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const candidate = randomSlug(8);
    if (!isValidSlug(candidate)) continue;
    const rows = await tx<{ id: string }[]>`
      update users set referral_slug = ${candidate}
      where id = ${userId} and referral_slug is null
      returning id
    `;
    if (rows.length > 0) return candidate;
    // Conflict path: slug taken; loop and try again.
    const existing = await tx<{ referral_slug: string | null }[]>`
      select referral_slug from users where id = ${userId}
    `;
    if (existing[0]?.referral_slug) return existing[0].referral_slug;
  }
  throw new Error('failed_to_mint_slug');
}

async function attributeReferral(
  tx: TxSql,
  refereeUserId: string,
  rawSlug: string,
): Promise<void> {
  const slug = rawSlug.toLowerCase();
  if (!isValidSlug(slug)) return;
  const rows = await tx<{ id: string }[]>`
    select id from users where referral_slug = ${slug}
  `;
  const referrer = rows[0];
  if (!referrer || referrer.id === refereeUserId) return;
  await tx`
    update users
    set referred_by_user_id = ${referrer.id},
        referral_attributed_at = now()
    where id = ${refereeUserId} and referred_by_user_id is null
  `;
  await tx`
    insert into referral_attributions (referrer_user_id, referee_user_id, via_slug)
    values (${referrer.id}, ${refereeUserId}, ${slug})
    on conflict (referee_user_id) do nothing
  `;
}

async function bootstrapPersonalAccount(
  tx: TxSql,
  opts: { userId: string; name: string; countryCode: string; billingType?: 'personal' | 'business' },
): Promise<string> {
  const country = await tx<{ code: string }[]>`
    select code from countries where code = ${opts.countryCode}
  `;
  const code = country[0]?.code ?? 'ZA';

  const [acct] = await tx<{ id: string }[]>`
    insert into accounts (name, billing_type, status, country_code)
    values (${opts.name}, ${opts.billingType ?? 'personal'}, 'active', ${code})
    returning id
  `;
  const accountId = acct!.id;

  await tx`
    insert into account_members (account_id, user_id, role, status)
    values (${accountId}, ${opts.userId}, 'owner', 'active')
  `;

  await tx`insert into wallets (account_id, currency) values (${accountId}, 'ZAR')`;

  const [plan] = await tx<{ id: string }[]>`select id from plans where code = 'free' limit 1`;
  if (plan) {
    await tx`
      insert into account_subscriptions (account_id, plan_id, status)
      values (${accountId}, ${plan.id}, 'active')
    `;
  }
  return accountId;
}

async function issueTokens(
  tx: TxSql,
  user: { id: string; email: string; is_platform_admin: boolean },
  opts: {
    familyId?: string;
    userAgent?: string | null;
    ip?: string | null;
  } = {},
): Promise<{ access_token: string; refresh_token: string; refresh_id: string; family_id: string }> {
  const { plain, hash } = await mintRefreshToken();
  const expires = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);

  let family_id: string;
  if (opts.familyId) {
    family_id = opts.familyId;
  } else {
    const uuidRows = await tx<{ uuid: string }[]>`select gen_random_uuid() as uuid`;
    family_id = uuidRows[0]!.uuid;
  }

  const insertRows = await tx<{ id: string }[]>`
    insert into refresh_tokens
      (family_id, user_id, token_hash, expires_at, user_agent, ip)
    values
      (${family_id}, ${user.id}, ${hash}, ${expires}, ${opts.userAgent ?? null}, ${opts.ip ?? null})
    returning id
  `;
  const id = insertRows[0]!.id;

  const accessToken = await signAccessToken(
    {
      sub: user.id,
      email: user.email,
      account_id: null,
      is_platform_admin: user.is_platform_admin,
    },
    ACCESS_TTL,
  );

  return { access_token: accessToken, refresh_token: plain, refresh_id: id, family_id };
}

function authRouter() {
  const app = new Hono<AppEnv>();

  app.post('/register', zValidator('json', registerSchema), async (c) => {
    const { email, password, display_name, country_code, account_type, referral_slug } =
      c.req.valid('json');
    const password_hash = await hashPassword(password);
    const verifyTokenPlain = randomToken(32);
    const verifyTokenHash = await hashToken(verifyTokenPlain);

    const result = await withAnonDb(async (tx) => {
      const existing = await tx<{ id: string }[]>`select id from users where email = ${email}`;
      if (existing.length > 0) throw Conflict('email_taken');

      const [user] = await tx<{ id: string }[]>`
        insert into users (email, password_hash, status)
        values (${email}, ${password_hash}, 'pending')
        returning id
      `;
      const userId = user!.id;

      await tx`
        insert into profiles (id, display_name, country_code)
        values (${userId}, ${display_name}, ${country_code})
      `;

      const expires = new Date(Date.now() + 60 * 60 * 24 * 1000); // 24h
      await tx`
        insert into email_verification_tokens (token_hash, user_id, expires_at)
        values (${verifyTokenHash}, ${userId}, ${expires})
      `;

      const accountId = await bootstrapPersonalAccount(tx, {
        userId,
        name: display_name,
        countryCode: country_code,
        billingType: account_type,
      });

      await assignNewUserSlug(tx, userId);

      if (referral_slug) {
        await attributeReferral(tx, userId, referral_slug);
      }

      return { userId, accountId };
    });

    const env = getEnv();
    const verifyUrl = `${env.APP_PUBLIC_URL}/auth/verify-email?token=${encodeURIComponent(verifyTokenPlain)}`;
    const verifyMail = renderEmail({
      preheader: 'Confirm your email to finish setting up whatsacc.',
      heading: `Welcome, ${escapeHtml(display_name)}.`,
      bodyParagraphs: [
        "Thanks for signing up for whatsacc. Confirm your email so we know it's really you — it takes one click.",
        'This link expires in 24 hours.',
      ],
      cta: { label: 'Verify my email', url: verifyUrl },
      footnote: "If you didn't create a whatsacc account, you can safely ignore this email.",
    });
    await sendEmail({
      to: email,
      subject: 'Verify your whatsacc email',
      html: verifyMail.html,
      text: verifyMail.text,
    });

    return c.json({ id: result.userId, account_id: result.accountId }, 201);
  });

  app.post('/login', zValidator('json', loginSchema), async (c) => {
    const { email, password } = c.req.valid('json');
    const ua = c.req.header('User-Agent') ?? null;
    const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? null;

    const tokens = await withAnonDb(async (tx) => {
      const rows = await tx<UserRow[]>`
        select id, email, password_hash, status, email_verified_at, is_platform_admin
        from users
        where email = ${email}
      `;
      const user = rows[0];
      if (!user || !user.password_hash) throw Unauthorized('invalid_credentials');
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) throw Unauthorized('invalid_credentials');
      if (user.status !== 'active') throw Forbidden('account_not_active', `status=${user.status}`);
      return await issueTokens(tx, user, { userAgent: ua, ip });
    });

    return c.json({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
    });
  });

  app.post('/refresh', zValidator('json', refreshSchema), async (c) => {
    const { refresh_token } = c.req.valid('json');
    const tokenHash = await hashToken(refresh_token);
    const ua = c.req.header('User-Agent') ?? null;
    const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? null;

    // Reuse detection happens in its own transaction so the family-revoke
    // commits even though we then throw 401. Throwing inside withAnonDb's
    // sql.begin() would roll the UPDATE back and leave a live family.
    const reuseFamily = await withAnonDb(async (tx) => {
      const rows = await tx<RefreshRow[]>`
        select id, family_id, user_id, token_hash, expires_at, revoked_at, replaced_by
        from refresh_tokens
        where token_hash = ${tokenHash}
        for update
      `;
      const row = rows[0];
      if (!row) return { kind: 'invalid' as const };
      if (row.revoked_at || row.replaced_by) {
        await tx`
          update refresh_tokens
          set revoked_at = now()
          where family_id = ${row.family_id} and revoked_at is null
        `;
        return { kind: 'reused' as const };
      }
      if (row.expires_at.getTime() <= Date.now()) {
        await tx`update refresh_tokens set revoked_at = now() where id = ${row.id}`;
        return { kind: 'expired' as const };
      }
      return { kind: 'ok' as const };
    });

    if (reuseFamily.kind === 'invalid') throw Unauthorized('invalid_refresh_token');
    if (reuseFamily.kind === 'reused') throw Unauthorized('refresh_token_reused');
    if (reuseFamily.kind === 'expired') throw Unauthorized('refresh_token_expired');

    const tokens = await withAnonDb(async (tx) => {
      // Re-fetch the row inside this transaction; rotate atomically.
      const rows = await tx<RefreshRow[]>`
        select id, family_id, user_id, token_hash, expires_at, revoked_at, replaced_by
        from refresh_tokens
        where token_hash = ${tokenHash}
        for update
      `;
      const row = rows[0];
      if (!row || row.revoked_at || row.replaced_by) {
        throw Unauthorized('invalid_refresh_token');
      }

      const userRows = await tx<UserRow[]>`
        select id, email, password_hash, status, email_verified_at, is_platform_admin
        from users where id = ${row.user_id}
      `;
      const user = userRows[0];
      if (!user || user.status !== 'active') throw Unauthorized('user_inactive');

      const issued = await issueTokens(tx, user, {
        familyId: row.family_id,
        userAgent: ua,
        ip,
      });

      await tx`
        update refresh_tokens
        set replaced_by = ${issued.refresh_id}, revoked_at = now()
        where id = ${row.id}
      `;

      return issued;
    });

    return c.json({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
    });
  });

  app.post('/logout', zValidator('json', logoutSchema), async (c) => {
    const { refresh_token } = c.req.valid('json');
    const tokenHash = await hashToken(refresh_token);
    await withAnonDb(async (tx) => {
      const rows = await tx<{ family_id: string }[]>`
        select family_id from refresh_tokens where token_hash = ${tokenHash}
      `;
      const row = rows[0];
      if (row) {
        await tx`
          update refresh_tokens
          set revoked_at = now()
          where family_id = ${row.family_id} and revoked_at is null
        `;
      }
    });
    return c.body(null, 204);
  });

  app.post('/forgot-password', zValidator('json', forgotSchema), async (c) => {
    const { email } = c.req.valid('json');
    const tokenPlain = randomToken(32);
    const tokenHash = await hashToken(tokenPlain);

    const sent = await withAnonDb(async (tx) => {
      const rows = await tx<{ id: string }[]>`select id from users where email = ${email}`;
      const u = rows[0];
      if (!u) return false;
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1h
      await tx`
        insert into password_reset_tokens (token_hash, user_id, expires_at)
        values (${tokenHash}, ${u.id}, ${expires})
      `;
      return true;
    });

    if (sent) {
      const env = getEnv();
      const url = `${env.APP_PUBLIC_URL}/auth/reset-password?token=${encodeURIComponent(tokenPlain)}`;
      const resetMail = renderEmail({
        preheader: 'Reset your whatsacc password.',
        heading: 'Reset your password',
        bodyParagraphs: [
          'We received a request to reset the password on your whatsacc account. Use the button below to set a new one.',
          'This link expires in 1 hour.',
        ],
        cta: { label: 'Reset password', url },
        footnote:
          "If you didn't request a password reset, you can ignore this email — your password won't change.",
      });
      await sendEmail({
        to: email,
        subject: 'Reset your whatsacc password',
        html: resetMail.html,
        text: resetMail.text,
      });
    }

    return c.body(null, 204);
  });

  app.post('/reset-password', zValidator('json', resetSchema), async (c) => {
    const { token, new_password } = c.req.valid('json');
    const tokenHash = await hashToken(token);
    const newHash = await hashPassword(new_password);

    await withAnonDb(async (tx) => {
      const rows = await tx<{
        token_hash: string;
        user_id: string;
        expires_at: Date;
        used_at: Date | null;
      }[]>`
        select token_hash, user_id, expires_at, used_at
        from password_reset_tokens
        where token_hash = ${tokenHash}
        for update
      `;
      const row = rows[0];
      if (!row) throw BadRequest('invalid_token');
      if (row.used_at) throw BadRequest('token_used');
      if (row.expires_at.getTime() <= Date.now()) throw BadRequest('token_expired');

      await tx`
        update users set password_hash = ${newHash}, updated_at = now()
        where id = ${row.user_id}
      `;
      await tx`
        update password_reset_tokens set used_at = now() where token_hash = ${tokenHash}
      `;
      await tx`
        update refresh_tokens set revoked_at = now()
        where user_id = ${row.user_id} and revoked_at is null
      `;
    });

    return c.body(null, 204);
  });

  app.post('/verify-email', zValidator('json', verifyEmailSchema), async (c) => {
    const { token } = c.req.valid('json');
    const tokenHash = await hashToken(token);

    await withAnonDb(async (tx) => {
      const rows = await tx<{
        token_hash: string;
        user_id: string;
        expires_at: Date;
        used_at: Date | null;
      }[]>`
        select token_hash, user_id, expires_at, used_at
        from email_verification_tokens
        where token_hash = ${tokenHash}
        for update
      `;
      const row = rows[0];
      if (!row) throw BadRequest('invalid_token');
      if (row.used_at) throw BadRequest('token_used');
      if (row.expires_at.getTime() <= Date.now()) throw BadRequest('token_expired');

      await tx`
        update users
        set email_verified_at = now(), status = 'active', updated_at = now()
        where id = ${row.user_id}
      `;
      await tx`
        update email_verification_tokens set used_at = now() where token_hash = ${tokenHash}
      `;
    });

    return c.body(null, 204);
  });

  // Authenticated update — user provides current password to change to a new
  // one. Revokes all other refresh-token families so any logged-in sessions
  // elsewhere are killed; the caller's bearer JWT remains valid until expiry.
  app.post(
    '/update-password',
    requireAuth(),
    zValidator('json', updatePasswordSchema),
    async (c) => {
      const me = getUser(c);
      const { current_password, new_password } = c.req.valid('json');
      if (current_password === new_password) {
        throw BadRequest('same_password', 'New password must differ from the current one');
      }
      const newHash = await hashPassword(new_password);

      await withAnonDb(async (tx) => {
        const rows = await tx<{ password_hash: string | null }[]>`
          select password_hash from users where id = ${me.sub}
        `;
        const row = rows[0];
        if (!row || !row.password_hash) {
          throw BadRequest('no_password_set', 'This account has no password (Google sign-in only)');
        }
        const ok = await verifyPassword(current_password, row.password_hash);
        if (!ok) throw Unauthorized('invalid_current_password');

        await tx`
          update users set password_hash = ${newHash}, updated_at = now()
          where id = ${me.sub}
        `;
        await tx`
          update refresh_tokens set revoked_at = now()
          where user_id = ${me.sub} and revoked_at is null
        `;
      });

      return c.body(null, 204);
    },
  );

  app.get('/me', requireAuth(), async (c) => {
    const user = getUser(c);
    const data = await withUserDb(c, async (tx) => {
      const userRows = await tx<{
        id: string;
        email: string;
        status: string;
        email_verified_at: Date | null;
        is_platform_admin: boolean;
        referral_slug: string | null;
      }[]>`
        select id, email, status, email_verified_at, is_platform_admin, referral_slug
        from users where id = ${user.sub}
      `;
      const u = userRows[0];
      if (!u) throw NotFound('user_not_found');

      const profileRows = await tx<{
        id: string;
        display_name: string | null;
        avatar_url: string | null;
        locale: string | null;
      }[]>`
        select id, display_name, avatar_url, locale
        from profiles where id = ${user.sub}
      `;

      const accounts = await tx<{
        account_id: string;
        name: string;
        billing_type: string;
        role: string;
        status: string;
      }[]>`
        select a.id as account_id, a.name, a.billing_type, am.role, am.status
        from account_members am
        join accounts a on a.id = am.account_id
        where am.user_id = ${user.sub}
      `;

      return { user: u, profile: profileRows[0] ?? null, accounts };
    });
    return c.json(data);
  });

  // Google OAuth
  app.get('/google/start', async (c) => {
    const { codeVerifier, codeChallenge } = await makePkce();
    const state = randomToken(16);
    const refSlug = c.req.query('ref');
    const cookieJwt = await signShortToken(
      {
        code_verifier: codeVerifier,
        state,
        ref_slug: refSlug && isValidSlug(refSlug.toLowerCase()) ? refSlug.toLowerCase() : null,
      },
      600,
    );
    setCookie(c, 'gauth', cookieJwt, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    });
    const url = buildAuthUrl(state, codeChallenge);
    return c.redirect(url, 302);
  });

  app.get('/google/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');
    if (error) throw BadRequest('google_oauth_error', error);
    if (!code || !state) throw BadRequest('google_oauth_missing_params');

    const cookie = getCookie(c, 'gauth');
    if (!cookie) throw BadRequest('google_oauth_state_missing');
    deleteCookie(c, 'gauth', { path: '/' });

    const stateClaims = await verifyShortToken(cookie);
    if (stateClaims.state !== state) throw BadRequest('google_oauth_state_mismatch');
    const codeVerifier = stateClaims.code_verifier;
    if (typeof codeVerifier !== 'string') throw BadRequest('google_oauth_state_invalid');

    const tokenRes = await exchangeCode(code, codeVerifier);
    const idClaims = await verifyIdToken(tokenRes.id_token);

    const ua = c.req.header('User-Agent') ?? null;
    const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? null;

    const tokens = await withAnonDb(async (tx) => {
      const ident = await tx<{ user_id: string }[]>`
        select user_id from oauth_identities
        where provider = 'google' and provider_sub = ${idClaims.sub}
      `;

      let userId: string;
      let createdNewUser = false;
      if (ident[0]) {
        userId = ident[0].user_id;
      } else {
        const existing = await tx<{ id: string }[]>`
          select id from users where email = ${idClaims.email}
        `;
        if (existing[0]) {
          userId = existing[0].id;
        } else {
          const [u] = await tx<{ id: string }[]>`
            insert into users (email, status, email_verified_at)
            values (${idClaims.email}, 'active', ${idClaims.email_verified ? new Date() : null})
            returning id
          `;
          userId = u!.id;
          await tx`
            insert into profiles (id, display_name, avatar_url)
            values (${userId}, ${idClaims.name ?? idClaims.email}, ${idClaims.picture ?? null})
          `;
          createdNewUser = true;
        }
        await tx`
          insert into oauth_identities (user_id, provider, provider_sub, email)
          values (${userId}, 'google', ${idClaims.sub}, ${idClaims.email})
        `;
      }

      if (createdNewUser) {
        await bootstrapPersonalAccount(tx, {
          userId,
          name: idClaims.name ?? idClaims.email,
          countryCode: 'ZA',
          billingType: 'personal',
        });
        await assignNewUserSlug(tx, userId);
        const refSlug = stateClaims.ref_slug;
        if (typeof refSlug === 'string') {
          await attributeReferral(tx, userId, refSlug);
        }
      }

      const userRows = await tx<UserRow[]>`
        select id, email, password_hash, status, email_verified_at, is_platform_admin
        from users where id = ${userId}
      `;
      const u = userRows[0];
      if (!u) throw NotFound('user_not_found');

      // ensure user is active after OAuth
      if (u.status !== 'active') {
        await tx`update users set status = 'active', email_verified_at = coalesce(email_verified_at, now()) where id = ${userId}`;
        u.status = 'active';
      }

      return await issueTokens(tx, u, { userAgent: ua, ip });
    });

    const fragment = new URLSearchParams({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: 'Bearer',
      expires_in: String(ACCESS_TTL),
    }).toString();
    const env = getEnv();
    return c.redirect(`${env.APP_PUBLIC_URL}/auth/callback#${fragment}`, 302);
  });

  return app;
}

export const authRoutes = authRouter();
