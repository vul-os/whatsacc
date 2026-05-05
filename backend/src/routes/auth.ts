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
import { sendEmail } from '../lib/email.ts';
import {
  buildAuthUrl,
  exchangeCode,
  makePkce,
  verifyIdToken,
} from '../lib/google.ts';
import { BadRequest, Conflict, Forbidden, NotFound, Unauthorized } from '../lib/errors.ts';
import { getEnv } from '../lib/env.ts';
import type { TxSql } from '../lib/db.ts';

const ACCESS_TTL = 15 * 60; // 15 min

const registerSchema = z
  .object({
    email: z.string().email().toLowerCase(),
    password: z.string().min(8).max(256),
    display_name: z.string().min(1).max(120),
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
    const { email, password, display_name } = c.req.valid('json');
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
        insert into profiles (id, display_name)
        values (${userId}, ${display_name})
      `;

      const expires = new Date(Date.now() + 60 * 60 * 24 * 1000); // 24h
      await tx`
        insert into email_verification_tokens (token_hash, user_id, expires_at)
        values (${verifyTokenHash}, ${userId}, ${expires})
      `;

      return { userId };
    });

    const env = getEnv();
    const verifyUrl = `${env.APP_PUBLIC_URL}/auth/verify-email?token=${encodeURIComponent(verifyTokenPlain)}`;
    await sendEmail({
      to: email,
      subject: 'Verify your whatsacc email',
      html: `<p>Hi ${display_name},</p><p>Click <a href="${verifyUrl}">here</a> to verify your email. Link expires in 24 hours.</p>`,
      text: `Verify your email: ${verifyUrl}`,
    });

    return c.json({ id: result.userId }, 201);
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

    const tokens = await withAnonDb(async (tx) => {
      const rows = await tx<RefreshRow[]>`
        select id, family_id, user_id, token_hash, expires_at, revoked_at, replaced_by
        from refresh_tokens
        where token_hash = ${tokenHash}
        for update
      `;
      const row = rows[0];
      if (!row) throw Unauthorized('invalid_refresh_token');

      // reuse detection: token already revoked or already replaced -> kill family
      if (row.revoked_at || row.replaced_by) {
        await tx`
          update refresh_tokens
          set revoked_at = now()
          where family_id = ${row.family_id} and revoked_at is null
        `;
        throw Unauthorized('refresh_token_reused');
      }

      if (row.expires_at.getTime() <= Date.now()) {
        await tx`update refresh_tokens set revoked_at = now() where id = ${row.id}`;
        throw Unauthorized('refresh_token_expired');
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
      await sendEmail({
        to: email,
        subject: 'Reset your whatsacc password',
        html: `<p>Click <a href="${url}">here</a> to reset your password. Link expires in 1 hour.</p>`,
        text: `Reset your password: ${url}`,
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

  app.get('/me', requireAuth(), async (c) => {
    const user = getUser(c);
    const data = await withUserDb(c, async (tx) => {
      const userRows = await tx<{
        id: string;
        email: string;
        status: string;
        email_verified_at: Date | null;
        is_platform_admin: boolean;
      }[]>`
        select id, email, status, email_verified_at, is_platform_admin
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
    const cookieJwt = await signShortToken(
      { code_verifier: codeVerifier, state },
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
        }
        await tx`
          insert into oauth_identities (user_id, provider, provider_sub, email)
          values (${userId}, 'google', ${idClaims.sub}, ${idClaims.email})
        `;
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
