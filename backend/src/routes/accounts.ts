import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, getUser, type AppEnv } from '../middleware/auth.ts';
import { withUserDb, withAnonDb } from '../middleware/rls.ts';
import { BadRequest, NotFound } from '../lib/errors.ts';
import { randomToken } from '../lib/random.ts';
import { hashToken } from '../lib/refresh.ts';
import { escapeHtml, renderEmail, sendEmail } from '../lib/email.ts';
import { getEnv } from '../lib/env.ts';
import { bootstrapPersonalAccount } from './auth.ts';
import { sendWhatsAppText } from '../lib/whatsapp.ts';
import { randomCode } from '../lib/random.ts';
import { consumeOtpStartLimit } from '../lib/rate-limit.ts';
import { sendVerificationCodeText, VERIFICATION_CODE_TTL_MS } from './phones.ts';

const createAccountSchema = z
  .object({
    name: z.string().min(1).max(120),
    country_code: z.string().length(2).transform((v) => v.toUpperCase()).default('ZA'),
  })
  .strict();

const updateAccountSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
  })
  .strict();

const inviteSchema = z
  .object({
    email: z.string().email().toLowerCase(),
    role: z.enum(['owner', 'admin', 'member', 'viewer']).default('member'),
    phone_e164: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Invalid phone number format (must start with + and include country code)'),
  })
  .strict();

const acceptInviteSchema = z
  .object({
    phone_e164: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Invalid phone number format').optional(),
  })
  .strict();

function accountsRouter() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth());

  app.get('/', async (c) => {
    const user = getUser(c);
    const rows = await withUserDb(c, async (tx) => {
      return await tx<{
        id: string;
        name: string;
        role: string;
        status: string;
      }[]>`
        select a.id, a.name, am.role, am.status
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
    const { name, country_code } = c.req.valid('json');
    // Account creation must run with elevated privilege: the accounts RLS
    // WITH CHECK clause requires is_account_admin(id), but at INSERT time no
    // membership row exists yet. requireAuth() above already verified the
    // caller.
    const accountId = await withAnonDb(async (tx) => {
      return await bootstrapPersonalAccount(tx, {
        userId: user.sub,
        name,
        countryCode: country_code,
      });
    });
    return c.json({ id: accountId }, 201);
  });

  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const data = await withUserDb(c, async (tx) => {
      const rows = await tx<{
        id: string;
        name: string;
        status: string;
      }[]>`
        select id, name, status
        from accounts where id = ${id}
      `;
      return rows[0] ?? null;
    });
    if (!data) throw NotFound('account_not_found');
    return c.json(data);
  });

  app.patch('/:id', zValidator('json', updateAccountSchema), async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    await withUserDb(c, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        update accounts
        set name = coalesce(${body.name ?? null}, name),
            updated_at = now()
        where id = ${id}
        returning id
      `;
      if (rows.length === 0) throw NotFound('account_not_found');
    });
    return c.body(null, 204);
  });

  app.get('/:id/members', async (c) => {
    const id = c.req.param('id');
    // Cross-row read: the users/profiles RLS policies only expose the
    // caller's own rows, so a direct JOIN would filter every co-member out.
    // app.account_member_list is the house-pattern SECURITY DEFINER helper
    // (owned by lintel_internal, self-gated on app.is_account_member) that
    // returns the full member list for accounts the caller belongs to and
    // zero rows for everyone else.
    const rows = await withUserDb(c, async (tx) => {
      return await tx<{
        user_id: string;
        role: string;
        status: string;
        email: string;
        display_name: string | null;
      }[]>`
        select user_id, role, status, email, display_name
        from app.account_member_list(${id}::uuid)
      `;
    });
    return c.json({ members: rows });
  });

  app.post('/:id/invites', zValidator('json', inviteSchema), async (c) => {
    const id = c.req.param('id');
    const { email, role, phone_e164 } = c.req.valid('json');
    const tokenPlain = randomToken(32);
    const tokenHash = await hashToken(tokenPlain);
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const result = await withUserDb(c, async (tx) => {
      const [invite] = await tx<{ id: string }[]>`
        insert into account_invites (account_id, email, role, token_hash, expires_at, phone_e164)
        values (${id}, ${email}, ${role}, ${tokenHash}, ${expires}, ${phone_e164 ?? null})
        returning id
      `;
      const accountRows = await tx<{ name: string }[]>`
        select name from accounts where id = ${id}
      `;
      return { invite_id: invite!.id, account_name: accountRows[0]?.name ?? 'lintel account' };
    });

    const env = getEnv();
    const acceptUrl =
      `${env.APP_PUBLIC_URL}/accept-invite?token=${encodeURIComponent(tokenPlain)}`;
    
    let whatsappSent = false;
    try {
      const waTo = phone_e164.startsWith('+') ? phone_e164.slice(1) : phone_e164;
      const waResult = await sendWhatsAppText(
        waTo,
        `Hi! You've been invited to join ${result.account_name} on lintel. Accept your invitation here: ${acceptUrl}`,
      );
      whatsappSent = waResult.ok;
      if (!waResult.ok) {
        console.warn('[whatsapp-send] invite failed:', waResult.error ?? 'unknown_error');
      }
    } catch (err) {
      console.warn('[whatsapp-send] invite failed:', (err as Error).message);
    }

    const inviteMail = renderEmail({
      preheader: `You've been invited to join ${result.account_name} on lintel.`,
      heading: `Join ${escapeHtml(result.account_name)} on lintel`,
      bodyParagraphs: [
        `You've been invited to join <strong style="color:#1a1f36;">${escapeHtml(result.account_name)}</strong> as <strong style="color:#1a1f36;">${escapeHtml(role)}</strong>.`,
        'Accept the invite to set up your account and start opening gates with a text.',
        'This invitation expires in 7 days.',
      ],
      cta: { label: 'Accept invitation', url: acceptUrl },
      footnote:
        "If you weren't expecting this, you can safely ignore this email — no account will be created.",
    });

    let emailSent = true;
    try {
      await sendEmail({
        to: email,
        subject: `You've been invited to ${result.account_name} on lintel`,
        html: inviteMail.html,
        text: inviteMail.text,
      });
    } catch (err) {
      emailSent = false;
      console.warn('[email-send] invite failed:', (err as Error).message);
    }

    // SECURITY: the accept token (inside acceptUrl) is NEVER returned to the
    // inviter — it is delivered to the INVITEE only (email + WhatsApp). The
    // create response used to echo accept_url, which let the inviter accept
    // their own invite. Dev/test ergonomics: with delivery mocked/unset,
    // tests recover the token by overwriting token_hash via the admin
    // handle, exactly like they force OTP codes.
    return c.json(
      { id: result.invite_id, email_sent: emailSent, whatsapp_sent: whatsappSent },
      201,
    );
  });

  // accepting an invite cannot use the user's account scope (not a member yet)
  app.post('/invites/:token/accept', zValidator('json', acceptInviteSchema), async (c) => {
    const user = getUser(c);
    const token = c.req.param('token');
    const tokenHash = await hashToken(token);
    const { phone_e164 } = c.req.valid('json');

    const result = await withAnonDb(async (tx) => {
      const rows = await tx<{
        id: string;
        account_id: string;
        email: string;
        role: string;
        expires_at: Date;
        accepted_at: Date | null;
        revoked_at: Date | null;
        phone_e164: string | null;
      }[]>`
        select id, account_id, email, role, expires_at, accepted_at, revoked_at, phone_e164
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

      if (phone_e164 && inv.phone_e164 && phone_e164 !== inv.phone_e164) {
        throw BadRequest('invite_phone_mismatch', 'Phone number must match the number this invitation was sent to');
      }
      const effectivePhone = phone_e164 ?? inv.phone_e164;

      await tx`
        insert into account_members (account_id, user_id, role, status)
        values (${inv.account_id}, ${user.sub}, ${inv.role}, 'active')
        on conflict (account_id, user_id) do update set role = excluded.role, status = 'active'
      `;
      await tx`
        insert into location_members (location_id, user_id, role)
        select id, ${user.sub}, ${inv.role}
        from locations
        where account_id = ${inv.account_id}
        on conflict (location_id, user_id) do update set role = excluded.role, updated_at = now()
      `;
      await tx`
        update account_invites set accepted_at = now(), accepted_by = ${user.sub}
        where id = ${inv.id}
      `;

      // SECURITY (design choice, documented on purpose): accepting an invite
      // NEVER verifies a phone number. The accept token is dual-delivered —
      // the SAME secret goes out over email AND WhatsApp — so possessing it
      // proves nothing about controlling the phone: the acceptor may have
      // followed the emailed link while the WhatsApp copy sat unread on
      // someone else's handset. Channel attribution cannot be reconstructed
      // after the fact (whatsapp_sent only records that Meta ACCEPTED the
      // outbound message, not that the acceptor read it there), so the
      // "WhatsApp-delivered token as proof of phone control" exception is
      // unsound and deliberately NOT implemented — auto-verify here
      // previously allowed a self-invite to claim (and durably squat, via
      // the one-verified-owner unique index) any unclaimed number. A
      // body-supplied phone_e164 is attacker-typed input and is likewise
      // never trusted. Instead: link the phone UNVERIFIED (and non-primary —
      // unverified phones cannot be primary) and start the standard OTP
      // challenge; only /phones/me/phones/:id/verify flips verified_at.
      let otp: { phoneE164: string; codePlain: string } | null = null;
      let verificationRequired = false;
      if (effectivePhone) {
        const [phoneRow] = await tx<{ id: string; verified_at: Date | null }[]>`
          insert into profile_phone_numbers (profile_id, phone_e164, is_primary, verified_at)
          values (${user.sub}, ${effectivePhone}, false, null)
          on conflict (profile_id, phone_e164)
          do update set is_primary = profile_phone_numbers.is_primary
          returning id, verified_at
        `;
        if (phoneRow && phoneRow.verified_at === null) {
          verificationRequired = true;
          // Charge the same otp_start budget as POST /me/phones: invites are
          // single-use, but MINTING them is cheap for a self-inviter, so an
          // uncharged challenge start here would be both an OTP-text pump at
          // an arbitrary number and an attempt-counter reset that dodges the
          // start limit. Denial is SOFT (skip the challenge, keep the
          // accept): membership must not fail because of OTP throttling —
          // the invitee can start verification later via POST /me/phones.
          const startLimit = await consumeOtpStartLimit(tx, user.sub);
          if (startLimit.allowed) {
            const codePlain = randomCode(6);
            const expires = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);
            const started = await tx<{ ok: boolean }[]>`
              select app.phone_verification_start(${phoneRow.id}::uuid, ${codePlain}, ${expires}) as ok
            `;
            if (started[0]?.ok === true) otp = { phoneE164: effectivePhone, codePlain };
          }
        }
      }

      return { account_id: inv.account_id, role: inv.role, otp, verificationRequired };
    });

    // Send the OTP after commit (same ergonomics as POST /me/phones: no-op
    // without WhatsApp creds; the code is never logged or returned).
    if (result.otp) {
      await sendVerificationCodeText(result.otp.phoneE164, result.otp.codePlain);
    }

    return c.json({
      account_id: result.account_id,
      role: result.role,
      phone_verification_required: result.verificationRequired,
    });
  });

  return app;
}

export const accountsRoutes = accountsRouter();
