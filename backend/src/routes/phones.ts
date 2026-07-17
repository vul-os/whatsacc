import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, getUser, type AppEnv } from '../middleware/auth.ts';
import { withAnonDb, withUserDb } from '../middleware/rls.ts';
import { BadRequest, NotFound } from '../lib/errors.ts';
import { getEnv } from '../lib/env.ts';
import { getAvailableAccessPoints } from '../lib/access-lookup.ts';
import { sendWhatsAppInteractive, sendWhatsAppText, type WhatsAppInteractive } from '../lib/whatsapp.ts';

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'invalid_e164');

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
          'Your WhatsApp number is connected to whatsacc.',
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
          'Your WhatsApp number is connected to whatsacc.',
          `I found your ${details.locations.length === 1 ? 'location' : 'locations'}: ${names}${details.locations.length > 3 ? ', ...' : ''}.`,
          "No gates or doors are ready yet. Add an access point in the dashboard, then message 'open'.",
          `${appUrl}/app/access-points`,
        ].join('\n\n'),
      );
      return;
    }

    await sendWhatsAppText(
      to,
      "Your WhatsApp number is connected to whatsacc. Here's what you can open from this number.",
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
    const result = await withUserDb(c, async (tx) => {
      const existing = await tx<{ id: string; verified_at: Date | null }[]>`
        select id, verified_at
        from profile_phone_numbers
        where profile_id = ${user.sub}
          and phone_e164 = ${phone_e164}
        limit 1
      `;
      const [row] = await tx<{ id: string }[]>`
        insert into profile_phone_numbers (profile_id, phone_e164, is_primary, verified_at)
        values (${user.sub}, ${phone_e164}, ${is_primary}, now())
        on conflict (profile_id, phone_e164)
        do update set is_primary = excluded.is_primary, verified_at = coalesce(profile_phone_numbers.verified_at, now())
        returning id
      `;
      return { id: row!.id, shouldNotify: existing.length === 0 || existing[0]!.verified_at === null };
    });
    if (result.shouldNotify) await sendConnectedWhatsAppMessage(user.sub, phone_e164);
    return c.json({ id: result.id }, 201);
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
