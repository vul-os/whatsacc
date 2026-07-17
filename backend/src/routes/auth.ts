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
import type { TxSql } from '../lib/db.ts';

const ACCESS_TTL = 15 * 60; // 15 min

const registerSchema = z
  .object({
    email: z.string().email().toLowerCase(),
    password: z.string().min(8).max(256),
    display_name: z.string().min(1).max(120),
    phone_e164: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
    // The user names their first physical place ("Home", "Sunset Apartments",
    // etc.). Each location is its own tenant — bootstrap creates an account
    // and a location of the same name, both owned by the new user.
    location_name: z.string().min(1).max(120).optional(),
    country_code: z
      .string()
      .length(2)
      .transform((v) => v.toUpperCase())
      .default('ZA'),
    // Accepted for client compatibility; carries no behaviour server-side.
    account_type: z.enum(['personal', 'business']).default('personal'),
    invite_token: z.string().min(1).optional(),
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
const slackIdentitySchema = z
  .object({
    slack_user_id: z.string().regex(/^[UW][A-Z0-9]{2,32}$/).optional(),
    slack_handle: z.string().min(1).max(80).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.slack_user_id || v.slack_handle), {
    message: 'slack_user_id or slack_handle is required',
  });

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

// Generate a URL-safe slug for a new location row. Locations are unique
// per (account_id, slug); we always tack on a short timestamp suffix so two
// locations called "Home" under the same account never collide.
export function makeLocationSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  const suffix = Date.now().toString(36);
  return `${base || 'loc'}-${suffix}`;
}

export async function bootstrapPersonalAccount(
  tx: TxSql,
  opts: { userId: string; name: string; countryCode: string },
): Promise<string> {
  const country = await tx<{ code: string }[]>`
    select code from countries where code = ${opts.countryCode}
  `;
  const code = country[0]?.code ?? 'ZA';

  const [acct] = await tx<{ id: string }[]>`
    insert into accounts (name, status, country_code)
    values (${opts.name}, 'active', ${code})
    returning id
  `;
  const accountId = acct!.id;

  await tx`
    insert into account_members (account_id, user_id, role, status)
    values (${accountId}, ${opts.userId}, 'owner', 'active')
  `;

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
    const {
      email, password, display_name, phone_e164, location_name, country_code, invite_token,
    } = c.req.valid('json');
    if (!invite_token && !location_name) {
      throw BadRequest('location_required', 'Location name is required');
    }
    const password_hash = await hashPassword(password);
    const verifyTokenPlain = randomToken(32);
    const verifyTokenHash = await hashToken(verifyTokenPlain);
    const inviteTokenHash = invite_token ? await hashToken(invite_token) : null;

    const result = await withAnonDb(async (tx) => {
      const existing = await tx<{ id: string }[]>`select id from users where email = ${email}`;
      if (existing.length > 0) throw Conflict('email_taken');

      // Status starts at 'active' so users can sign in immediately. Email
      // verification is still emitted (verify-email flow stamps
      // email_verified_at when clicked) but isn't a login gate. This avoids
      // a hard dependency on Resend's deliverability.
      const [user] = await tx<{ id: string }[]>`
        insert into users (email, password_hash, status)
        values (${email}, ${password_hash}, 'active')
        returning id
      `;
      const userId = user!.id;

      await tx`
        insert into profiles (id, display_name, country_code)
        values (${userId}, ${display_name}, ${country_code})
      `;

      if (phone_e164) {
        await tx`
          insert into profile_phone_numbers (profile_id, phone_e164, is_primary, verified_at)
          values (${userId}, ${phone_e164}, true, now())
        `;
      }

      const expires = new Date(Date.now() + 60 * 60 * 24 * 1000); // 24h
      await tx`
        insert into email_verification_tokens (token_hash, user_id, expires_at)
        values (${verifyTokenHash}, ${userId}, ${expires})
      `;

      let accountId: string;
      if (inviteTokenHash) {
        const inviteRows = await tx<{
          id: string;
          account_id: string;
          email: string;
          role: 'owner' | 'admin' | 'member' | 'viewer';
          expires_at: Date;
          accepted_at: Date | null;
          revoked_at: Date | null;
          phone_e164: string | null;
        }[]>`
          select id, account_id, email, role, expires_at, accepted_at, revoked_at, phone_e164
          from account_invites where token_hash = ${inviteTokenHash}
          for update
        `;
        const inv = inviteRows[0];
        if (!inv) throw BadRequest('invite_not_found');
        if (inv.accepted_at) throw BadRequest('invite_used');
        if (inv.revoked_at) throw BadRequest('invite_revoked');
        if (inv.expires_at.getTime() <= Date.now()) throw BadRequest('invite_expired');
        if (inv.email !== email) throw BadRequest('invite_email_mismatch');
        if (phone_e164 && inv.phone_e164 && inv.phone_e164 !== phone_e164) {
          throw BadRequest('invite_phone_mismatch', 'Phone number must match the number this invitation was sent to');
        }

        accountId = inv.account_id;
        await tx`
          insert into account_members (account_id, user_id, role, status)
          values (${accountId}, ${userId}, ${inv.role}, 'active')
          on conflict (account_id, user_id) do update set role = excluded.role, status = 'active'
        `;
        await tx`
          insert into location_members (location_id, user_id, role)
          select id, ${userId}, ${inv.role}
          from locations
          where account_id = ${accountId}
          on conflict (location_id, user_id) do update set role = excluded.role, updated_at = now()
        `;
        await tx`
          update account_invites set accepted_at = now(), accepted_by = ${userId}
          where id = ${inv.id}
        `;
        const linkedPhone = phone_e164 ?? inv.phone_e164;
        if (linkedPhone) {
          await tx`
            insert into profile_phone_numbers (profile_id, phone_e164, is_primary, verified_at)
            values (${userId}, ${linkedPhone}, true, now())
            on conflict (profile_id, phone_e164)
            do update set is_primary = true, verified_at = coalesce(profile_phone_numbers.verified_at, now())
          `;
        }
      } else {
        accountId = await bootstrapPersonalAccount(tx, {
          userId,
          name: location_name!,
          countryCode: country_code,
        });

        // Each account is anchored to exactly one location of the same name —
        // that's the unit users actually think about. Subsequent locations the
        // user creates each get their own fresh account (see POST /locations).
        const [location] = await tx<{ id: string }[]>`
          insert into locations (account_id, type, name, slug, address, status)
          values (
            ${accountId},
            'house',
            ${location_name!},
            ${makeLocationSlug(location_name!)},
            '{}'::jsonb,
            'active'
          )
          returning id
        `;

        await tx`
          insert into location_members (location_id, user_id, role)
          values (${location!.id}, ${userId}, 'owner')
          on conflict (location_id, user_id) do update set role = excluded.role, updated_at = now()
        `;
      }

      const userRows = await tx<UserRow[]>`
        select id, email, password_hash, status, email_verified_at, is_platform_admin
        from users where id = ${userId}
      `;
      const issued = await issueTokens(tx, userRows[0]!, {
        userAgent: c.req.header('User-Agent') ?? null,
        ip: c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? null,
      });

      return { userId, accountId, tokens: issued };
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
    // Best-effort — register must succeed even if Resend hiccups. The user's
    // status is already 'active' so they can sign in without the verify
    // email; this is just a confirmation nudge.
    try {
      await sendEmail({
        to: email,
        subject: 'Verify your whatsacc email',
        html: verifyMail.html,
        text: verifyMail.text,
      });
    } catch (err) {
      console.warn('[email-send] verify-email failed:', (err as Error).message);
    }

    return c.json({
      id: result.userId,
      account_id: result.accountId,
      access_token: result.tokens.access_token,
      refresh_token: result.tokens.refresh_token,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
    }, 201);
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
      try {
        await sendEmail({
          to: email,
          subject: 'Reset your whatsacc password',
          html: resetMail.html,
          text: resetMail.text,
        });
      } catch (err) {
        console.warn('[email-send] reset-password failed:', (err as Error).message);
      }
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
        has_password: boolean;
      }[]>`
        select id, email, status, email_verified_at, is_platform_admin,
               (password_hash is not null) as has_password
        from users where id = ${user.sub}
      `;
      const u = userRows[0];
      if (!u) throw NotFound('user_not_found');

      const profileRows = await tx<{
        id: string;
        display_name: string | null;
        avatar_url: string | null;
        avatar_cdn_url: string | null;
        avatar_source: 'google' | 'user' | null;
        locale: string | null;
        slack_user_id: string | null;
        slack_handle: string | null;
      }[]>`
        select id, display_name, avatar_url, avatar_cdn_url, avatar_source,
               locale, slack_user_id, slack_handle
        from profiles where id = ${user.sub}
      `;

      const phones = await tx<{
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

      const accounts = await tx<{
        account_id: string;
        name: string;
        role: string;
        status: string;
      }[]>`
        select a.id as account_id, a.name, am.role, am.status
        from account_members am
        join accounts a on a.id = am.account_id
        where am.user_id = ${user.sub}
      `;

      return { user: u, profile: profileRows[0] ?? null, phones, accounts };
    });
    return c.json(data);
  });

  // Profile updates the user controls directly. Today: display_name + avatar.
  // Avatar URL is accepted as any https:// URL — when phase-2 BunnyCDN lands,
  // the cdn proxy will fetch from this origin and avatar_cdn_url will carry
  // the cached version. Setting avatar_url to null clears the customisation
  // and frees the next Google sign-in to repopulate from the `picture` claim.
  const profileUpdateSchema = z
    .object({
      display_name: z.string().trim().min(1).max(80).optional(),
      avatar_url: z
        .union([
          z.string().url().max(1024).refine((s) => s.startsWith('https://'), {
            message: 'avatar_url must be an https URL',
          }),
          z.null(),
        ])
        .optional(),
    })
    .strict()
    .refine((b) => b.display_name !== undefined || b.avatar_url !== undefined, {
      message: 'at least one of display_name, avatar_url is required',
    });

  app.patch('/me/profile', requireAuth(), zValidator('json', profileUpdateSchema), async (c) => {
    const user = getUser(c);
    const body = c.req.valid('json');

    const updated = await withUserDb(c, async (tx) => {
      // display_name update (independent of avatar)
      if (body.display_name !== undefined) {
        await tx`
          update profiles
             set display_name = ${body.display_name},
                 updated_at = now()
           where id = ${user.sub}
        `;
      }

      // Avatar update. Three cases:
      //   - URL provided  → store, mark source='user', clear stale cdn url.
      //   - null provided → wipe avatar + source so the next Google sign-in
      //                     can restore the Google picture.
      //   - undefined     → leave untouched.
      if (body.avatar_url !== undefined) {
        if (body.avatar_url === null) {
          await tx`
            update profiles
               set avatar_url = null,
                   avatar_source = null,
                   avatar_cdn_url = null,
                   updated_at = now()
             where id = ${user.sub}
          `;
        } else {
          await tx`
            update profiles
               set avatar_url = ${body.avatar_url},
                   avatar_source = 'user',
                   avatar_cdn_url = null,
                   updated_at = now()
             where id = ${user.sub}
          `;
        }
      }

      const rows = await tx<{
        display_name: string | null;
        avatar_url: string | null;
        avatar_cdn_url: string | null;
        avatar_source: 'google' | 'user' | null;
      }[]>`
        select display_name, avatar_url, avatar_cdn_url, avatar_source
        from profiles where id = ${user.sub}
      `;
      return rows[0] ?? null;
    });

    return c.json({ profile: updated });
  });

  app.put('/me/slack', requireAuth(), zValidator('json', slackIdentitySchema), async (c) => {
    const user = getUser(c);
    const body = c.req.valid('json');
    const handle = body.slack_handle?.replace(/^@+/, '').trim() || null;
    const slackUserId = body.slack_user_id?.trim().toUpperCase() || null;

    await withUserDb(c, async (tx) => {
      await tx`
        update profiles
        set slack_user_id = coalesce(${slackUserId}, slack_user_id),
            slack_handle = coalesce(${handle}, slack_handle),
            updated_at = now()
        where id = ${user.sub}
      `;
    });

    return c.body(null, 204);
  });

  // Google OAuth
  app.get('/google/start', async (c) => {
    const { codeVerifier, codeChallenge } = await makePkce();
    const state = randomToken(16);
    const cookieJwt = await signShortToken(
      {
        code_verifier: codeVerifier,
        state,
      },
      600,
    );
    const isHttps = new URL(c.req.url).protocol === 'https:';
    setCookie(c, 'gauth', cookieJwt, {
      httpOnly: true,
      secure: isHttps,
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
            insert into profiles (id, display_name, avatar_url, avatar_source)
            values (${userId}, ${idClaims.name ?? idClaims.email}, ${idClaims.picture ?? null},
                    ${idClaims.picture ? 'google' : null})
          `;
          createdNewUser = true;
        }
        await tx`
          insert into oauth_identities (user_id, provider, provider_sub, email)
          values (${userId}, 'google', ${idClaims.sub}, ${idClaims.email})
        `;
      }

      // Refresh the avatar from Google's current `picture` claim, UNLESS the
      // user has customised their avatar via PATCH /auth/me/profile (which
      // sets avatar_source = 'user'). avatar_cdn_url is also cleared so the
      // phase-2 CDN re-fetches against the new origin URL. If Google supplies
      // no picture this turn we don't touch the column.
      if (!createdNewUser && idClaims.picture) {
        await tx`
          update profiles
             set avatar_url = ${idClaims.picture},
                 avatar_source = 'google',
                 avatar_cdn_url = null
           where id = ${userId}
             and (avatar_source is distinct from 'user')
        `;
      }

      if (createdNewUser) {
        await bootstrapPersonalAccount(tx, {
          userId,
          name: idClaims.name ?? idClaims.email,
          countryCode: 'ZA',
        });
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
