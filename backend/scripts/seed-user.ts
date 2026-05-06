// One-off: create (or update) a user with a known password and mark them
// active + email-verified. Mirrors what /auth/register does, minus the email.
//
// Usage:
//   cd backend
//   deno run -A --env-file=../.env scripts/seed-user.ts \
//     --email=whatsaccsupport@gmail.com --password=happy123 --name=Andile

import postgres from 'postgres';
import { parseArgs } from 'jsr:@std/cli@^1.0.0/parse-args';
import { hashPassword } from '../src/lib/password.ts';
import { randomSlug } from '../src/lib/slug.ts';

const args = parseArgs(Deno.args, {
  string: ['email', 'password', 'name', 'country'],
  default: { country: 'ZA', name: 'Support' },
});

const email = String(args.email ?? '').trim().toLowerCase();
const password = String(args.password ?? '');
const name = String(args.name ?? 'Support');
const country = String(args.country ?? 'ZA').toUpperCase();

if (!email || !password) {
  console.error('error: --email and --password are required');
  Deno.exit(1);
}

const url = (Deno.env.get('DATABASE_URL') ?? '').trim();
if (!url) {
  console.error('error: DATABASE_URL not set');
  Deno.exit(1);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

try {
  const passwordHash = await hashPassword(password);

  await sql.begin(async (tx) => {
    // Bypass RLS — every policy short-circuits when app.is_platform_admin = true.
    await tx`select set_config('app.user_id', '', true)`;
    await tx`select set_config('app.account_id', '', true)`;
    await tx`select set_config('app.is_platform_admin', 'true', true)`;

    const existing = await tx<{ id: string }[]>`
      select id from users where email = ${email}
    `;

    let userId: string;
    if (existing[0]) {
      userId = existing[0].id;
      await tx`
        update users set
          password_hash = ${passwordHash},
          status = 'active',
          email_verified_at = coalesce(email_verified_at, now()),
          updated_at = now()
        where id = ${userId}
      `;
      console.log(`updated existing user ${email} (${userId})`);
    } else {
      const [u] = await tx<{ id: string }[]>`
        insert into users (email, password_hash, status, email_verified_at)
        values (${email}, ${passwordHash}, 'active', now())
        returning id
      `;
      userId = u!.id;
      await tx`
        insert into profiles (id, display_name, country_code)
        values (${userId}, ${name}, ${country})
      `;
      console.log(`created user ${email} (${userId})`);
    }

    // Ensure user has a personal account, membership, wallet, subscription.
    const memberRows = await tx<{ account_id: string }[]>`
      select account_id from account_members where user_id = ${userId} limit 1
    `;
    if (!memberRows[0]) {
      const countryRow = await tx<{ code: string }[]>`
        select code from countries where code = ${country}
      `;
      const code = countryRow[0]?.code ?? 'ZA';

      const [acct] = await tx<{ id: string }[]>`
        insert into accounts (name, billing_type, status, country_code)
        values (${name}, 'personal', 'active', ${code})
        returning id
      `;
      const accountId = acct!.id;

      await tx`
        insert into account_members (account_id, user_id, role, status)
        values (${accountId}, ${userId}, 'owner', 'active')
      `;
      await tx`insert into wallets (account_id, currency) values (${accountId}, 'ZAR')`;

      const planRows = await tx<{ id: string }[]>`select id from plans where code = 'free' limit 1`;
      if (planRows[0]) {
        await tx`
          insert into account_subscriptions (account_id, plan_id, status)
          values (${accountId}, ${planRows[0].id}, 'active')
        `;
      }
      console.log(`bootstrapped personal account ${accountId}`);
    }

    // Ensure a referral slug.
    const slugRows = await tx<{ referral_slug: string | null }[]>`
      select referral_slug from users where id = ${userId}
    `;
    if (!slugRows[0]?.referral_slug) {
      for (let i = 0; i < 5; i++) {
        const candidate = randomSlug(8);
        const updated = await tx<{ id: string }[]>`
          update users set referral_slug = ${candidate}
          where id = ${userId} and referral_slug is null
          returning id
        `;
        if (updated[0]) {
          console.log(`assigned referral_slug ${candidate}`);
          break;
        }
      }
    }
  });

  console.log('\n✓ done');
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log('  status:   active, email_verified_at: now()');
} finally {
  await sql.end({ timeout: 5 });
}
