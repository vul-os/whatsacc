import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, getUser, type AppEnv } from '../middleware/auth.ts';
import { withAnonDb, withUserDb } from '../middleware/rls.ts';
import { BadRequest, Conflict, NotFound, TooManyRequests } from '../lib/errors.ts';
import { getEnv } from '../lib/env.ts';
import { randomCode } from '../lib/random.ts';
import { consumeOtpStartLimit, consumeOtpVerifyLimit } from '../lib/rate-limit.ts';
import { getAvailableAccessPoints } from '../lib/access-lookup.ts';
import { sendWhatsAppInteractive, sendWhatsAppText, type WhatsAppInteractive } from '../lib/whatsapp.ts';

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'invalid_e164');

// OTP challenge parameters: 6-digit code, 10-minute expiry, 5 attempts per
// challenge (plus persistent otp_start / otp_verify hourly rate limits that
// survive challenge restarts — see src/lib/rate-limit.ts).
export const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
const VERIFICATION_MAX_ATTEMPTS = 5;

/**
 * Text the OTP to the number being verified. When WHATSAPP_* creds are unset
 * (local/dev/tests) this is a fast no-op — the code row still exists so the
 * flow can be completed out-of-band. The code is deliberately never logged
 * and never returned in any response. Shared with the invite-accept flow
 * (src/routes/accounts.ts), which links phones unverified and starts the
 * same challenge.
 */
export async function sendVerificationCodeText(phoneE164: string, codePlain: string): Promise<void> {
  const to = phoneE164.startsWith('+') ? phoneE164.slice(1) : phoneE164;
  try {
    const sent = await sendWhatsAppText(
      to,
      `Your lintel verification code is ${codePlain}. It expires in 10 minutes. If you didn't request this, ignore this message.`,
    );
    if (!sent.ok && sent.error !== 'whatsapp_credentials_unset') {
      console.warn('[whatsapp-send] verification code failed:', sent.error ?? 'unknown_error');
    }
  } catch (err) {
    console.warn('[whatsapp-send] verification code failed:', (err as Error).message);
  }
}

const addPhoneSchema = z
  .object({
    phone_e164: e164,
    is_primary: z.boolean().default(false),
  })
  .strict();

const verifyPhoneSchema = z.object({ code: z.string().min(4).max(8) }).strict();

async function sendConnectedWhatsAppMessage(userId: string, phoneE164: string): Promise<void> {
  const to = phoneE164.startsWith('+') ? phoneE164.slice(1) : phoneE164;
  const appUrl = getEnv().APP_PUBLIC_URL.replace(/\/$/, '');

  try {
    const details = await withAnonDb(async (tx) => {
      const locations = await tx<{ name: string }[]>`
        select l.name
        from account_members am
        join locations l on l.account_id = am.account_id
        where am.user_id = ${userId}
          and am.status = 'active'
          and l.status = 'active'
        order by l.created_at asc
      `;
      const gates = await getAvailableAccessPoints(tx, { phoneE164 });
      return { locations, gates };
    });

    if (details.locations.length === 0) {
      await sendWhatsAppText(
        to,
        [
          'Your WhatsApp number is connected to lintel.',
          "You don't have a location set up yet. Open the dashboard to add Home, HQ, or your first site.",
          `${appUrl}/app`,
        ].join('\n\n'),
      );
      return;
    }

    if (details.gates.length === 0) {
      const names = details.locations.slice(0, 3).map((l) => l.name).join(', ');
      await sendWhatsAppText(
        to,
        [
          'Your WhatsApp number is connected to lintel.',
          `I found your ${details.locations.length === 1 ? 'location' : 'locations'}: ${names}${details.locations.length > 3 ? ', ...' : ''}.`,
          "No gates or doors are ready yet. Add an access point in the dashboard, then message 'open'.",
          `${appUrl}/app/access-points`,
        ].join('\n\n'),
      );
      return;
    }

    await sendWhatsAppText(
      to,
      "Your WhatsApp number is connected to lintel. Here's what you can open from this number.",
    );

    const interactive: WhatsAppInteractive = details.gates.length === 1
      ? {
          type: 'button',
          body: { text: `Message "open" any time, or tap below to open ${details.gates[0]!.ap_name}.` },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: { id: `open_ap:${details.gates[0]!.ap_id}`, title: `Open ${details.gates[0]!.ap_name}` },
              },
            ],
          },
        }
      : {
          type: 'list',
          header: { type: 'text', text: 'Gate Access' },
          body: { text: 'Message "open" any time, or choose a gate below.' },
          action: {
            button: 'Select Gate',
            sections: [
              {
                title: 'Available Gates',
                rows: details.gates.slice(0, 10).map((g) => ({
                  id: `open_ap:${g.ap_id}`,
                  title: g.ap_name,
                  description: g.loc_name,
                })),
              },
            ],
          },
        };

    const sent = await sendWhatsAppInteractive(to, interactive);
    if (!sent.ok) {
      console.warn('[whatsapp-send] connected rundown failed:', sent.error ?? 'unknown_error');
    }
  } catch (err) {
    console.warn('[whatsapp-send] connected message failed:', (err as Error).message);
  }
}

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

    // A verified phone is the WhatsApp webhook's identity root, so a phone
    // NEVER becomes verified just by being typed in: new numbers start
    // unverified, get an OTP challenge over WhatsApp, and only /verify flips
    // verified_at (the invite-accept flow also links phones UNVERIFIED and
    // funnels into this same challenge). Unverified phones also cannot be
    // made primary.
    const codePlain = randomCode(6);
    const result = await withUserDb(c, async (tx) => {
      const [row] = await tx<{ id: string; verified_at: Date | null }[]>`
        insert into profile_phone_numbers (profile_id, phone_e164, is_primary, verified_at)
        values (${user.sub}, ${phone_e164}, false, null)
        on conflict (profile_id, phone_e164)
        do update set is_primary = (${is_primary} and profile_phone_numbers.verified_at is not null)
        returning id, verified_at
      `;
      const verified = row!.verified_at !== null;
      let challenge = false;
      if (!verified) {
        // Persistent per-user cap on challenge starts: every (re)add of an
        // unverified number mints a fresh code with attempts = 0, so without
        // this an attacker could restart the challenge forever. The throw
        // rolls the whole tx back — nothing to keep on a denial (the tryBump
        // deny consumes nothing).
        const startLimit = await consumeOtpStartLimit(tx, user.sub);
        if (!startLimit.allowed) {
          throw TooManyRequests('otp_rate_limited', startLimit.retryAfterS);
        }
        const expires = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);
        const started = await tx<{ ok: boolean }[]>`
          select app.phone_verification_start(${row!.id}::uuid, ${codePlain}, ${expires}) as ok
        `;
        challenge = started[0]?.ok === true;
      }
      return { id: row!.id, verified, challenge };
    });

    if (result.challenge) {
      await sendVerificationCodeText(phone_e164, codePlain);
    }
    return c.json({ id: result.id, verification_required: !result.verified }, 201);
  });

  app.post('/me/phones/:id/verify', zValidator('json', verifyPhoneSchema), async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const { code } = c.req.valid('json');
    if (!/^\d{6}$/.test(code)) throw BadRequest('invalid_code');

    // The failure branches must NOT throw inside the transaction — a throw
    // rolls the tx back and would undo the attempt-counter increment that
    // makes the 5-attempt lockout real. Map to HTTP errors after commit.
    type VerifyOutcome = {
      status: string;
      verifiedNow: boolean;
      phone_e164: string;
      retryAfterS?: number;
    };
    const outcome = await withUserDb(c, async (tx): Promise<VerifyOutcome> => {
      const rows = await tx<{ id: string; phone_e164: string; verified_at: Date | null }[]>`
        select id, phone_e164, verified_at
        from profile_phone_numbers
        where id = ${id} and profile_id = ${user.sub}
        limit 1
      `;
      const phone = rows[0];
      if (!phone) return { status: 'not_found' as string, verifiedNow: false, phone_e164: '' };
      if (phone.verified_at) return { status: 'already_verified', verifiedNow: false, phone_e164: phone.phone_e164 };

      // Persistent per-phone-row cap on verify attempts. The per-challenge
      // attempt counter resets on every challenge restart; this one does
      // not, so restarts cannot buy unlimited guesses within the window.
      // Checked (and consumed) only after ownership is proven above, so a
      // stranger probing ids cannot burn someone else's budget. Returned as
      // an outcome (no throw): a denial consumed nothing, and earlier writes
      // in this tx must survive.
      const verifyLimit = await consumeOtpVerifyLimit(tx, id);
      if (!verifyLimit.allowed) {
        return {
          status: 'rate_limited',
          verifiedNow: false,
          phone_e164: phone.phone_e164,
          retryAfterS: verifyLimit.retryAfterS,
        };
      }

      const consumed = await tx<{ status: string }[]>`
        select app.phone_verification_consume(
          ${id}::uuid, ${code}, ${VERIFICATION_MAX_ATTEMPTS}
        ) as status
      `;
      const status = consumed[0]?.status ?? 'no_code';
      return { status, verifiedNow: status === 'ok', phone_e164: phone.phone_e164 };
    });

    switch (outcome.status) {
      case 'ok':
      case 'already_verified':
        break;
      case 'not_found':
        throw NotFound('phone_not_found');
      case 'rate_limited':
        throw TooManyRequests('otp_rate_limited', outcome.retryAfterS ?? 3600);
      case 'locked':
        throw TooManyRequests('too_many_attempts', VERIFICATION_CODE_TTL_MS / 1000);
      case 'expired':
        throw BadRequest('code_expired');
      case 'phone_taken':
        throw Conflict('phone_in_use', 'This number is already verified on another account');
      case 'no_code':
        throw BadRequest('no_pending_code');
      default:
        throw BadRequest('invalid_code');
    }

    // The "connected to lintel" rundown only makes sense once the number
    // is actually proven — send it after first successful verification.
    if (outcome.verifiedNow) {
      await sendConnectedWhatsAppMessage(user.sub, outcome.phone_e164);
    }
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
