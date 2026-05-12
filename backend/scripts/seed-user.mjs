// One-off: create (or update) a user with a known password and mark them
// active + email-verified. Mirrors what /auth/register does, minus the email.
//
// Usage:
//   cd backend
//   node --env-file=../.env scripts/seed-user.mjs \
//     --email=whatsaccsupport.com --password=happy123 --name=Acc bot

import pg from 'pg';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';

// Args
const args = parseArgs(
  process.argv.slice(2),
  ['email', 'password', 'name', 'country', 'location-name'],
);
const email = String(args.email ?? '').trim().toLowerCase();
const password = String(args.password ?? '');
const name = String(args.name ?? 'Support');
const country = String(args.country ?? 'ZA').toUpperCase();
// Account + first-location name. Defaults to "Home" so account naming
// stays distinct from the human's display_name (which `--name` controls).
const locationName = String(args['location-name'] ?? 'Home');
if (!email || !password) {
  console.error('error: --email and --password are required');
  process.exit(1);
}

const url = (process.env.DATABASE_URL ?? '').trim();
if (!url) {
  console.error('error: DATABASE_URL not set');
  process.exit(1);
}

// Force single-IPv4 connection — Node's default multi-IP connect trips over
// broken IPv6 + Neon's load-balanced AWS IPs on some networks.
const u = new URL(url);
const { address } = await lookup(u.hostname, { family: 4 });
const client = new pg.Client({
  host: address,
  port: Number(u.port) || 5432,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, ''),
  ssl: { servername: u.hostname, rejectUnauthorized: false },
});
await client.connect();

try {
  const passwordHash = await hashPassword(password);

  await client.query('BEGIN');
  // Bypass RLS — every policy short-circuits when app.is_platform_admin = true.
  await client.query("select set_config('app.user_id', '', true)");
  await client.query("select set_config('app.account_id', '', true)");
  await client.query("select set_config('app.is_platform_admin', 'true', true)");

  const existing = await client.query('select id from users where email = $1', [email]);
  let userId;
  if (existing.rows[0]) {
    userId = existing.rows[0].id;
    await client.query(
      `update users set
        password_hash = $1,
        status = 'active',
        email_verified_at = coalesce(email_verified_at, now()),
        updated_at = now()
       where id = $2`,
      [passwordHash, userId],
    );
    console.log(`updated existing user ${email} (${userId})`);
  } else {
    const u = await client.query(
      `insert into users (email, password_hash, status, email_verified_at)
       values ($1, $2, 'active', now())
       returning id`,
      [email, passwordHash],
    );
    userId = u.rows[0].id;
    await client.query(
      `insert into profiles (id, display_name, country_code) values ($1, $2, $3)`,
      [userId, name, country],
    );
    console.log(`created user ${email} (${userId})`);
  }

  // Ensure user has a personal account, membership, wallet, subscription.
  const memberRows = await client.query(
    'select account_id from account_members where user_id = $1 limit 1',
    [userId],
  );
  if (!memberRows.rows[0]) {
    const countryRow = await client.query('select code from countries where code = $1', [country]);
    const code = countryRow.rows[0]?.code ?? 'ZA';

    const acct = await client.query(
      `insert into accounts (name, billing_type, status, country_code)
       values ($1, 'personal', 'active', $2)
       returning id`,
      [locationName, code],
    );
    const accountId = acct.rows[0].id;

    await client.query(
      `insert into account_members (account_id, user_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [accountId, userId],
    );
    await client.query("insert into wallets (account_id, currency) values ($1, 'ZAR')", [accountId]);

    const planRows = await client.query("select id from plans where code = 'free' limit 1");
    if (planRows.rows[0]) {
      await client.query(
        `insert into account_subscriptions (account_id, plan_id, status)
         values ($1, $2, 'active')`,
        [accountId, planRows.rows[0].id],
      );
    }
    // Each account anchors exactly one location of the same name. Mirrors
    // what /auth/register does so the seed produces an identical shape.
    const locSlug = locationName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
      || 'home';
    await client.query(
      `insert into locations (account_id, type, name, slug, address, status)
       values ($1, 'house', $2, $3, '{}'::jsonb, 'active')`,
      [accountId, locationName, `${locSlug}-${Date.now().toString(36)}`],
    );
    console.log(`bootstrapped account "${locationName}" (${accountId}) + matching location`);
  }

  // Ensure a referral slug.
  const slugRows = await client.query('select referral_slug from users where id = $1', [userId]);
  if (!slugRows.rows[0]?.referral_slug) {
    for (let i = 0; i < 5; i++) {
      const candidate = randomSlug(8);
      const updated = await client.query(
        `update users set referral_slug = $1
         where id = $2 and referral_slug is null
         returning id`,
        [candidate, userId],
      );
      if (updated.rows[0]) {
        console.log(`assigned referral_slug ${candidate}`);
        break;
      }
    }
  }

  await client.query('COMMIT');
  console.log('\n✓ done');
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log('  status:   active, email_verified_at: now()');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e);
  process.exit(1);
} finally {
  await client.end();
}

// ─── helpers ───────────────────────────────────────────────────────────────
function parseArgs(argv, names) {
  const out = {};
  for (const a of argv) {
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      const k = a.slice(2, eq);
      if (names.includes(k)) out[k] = a.slice(eq + 1);
    }
  }
  return out;
}

async function hashPassword(plain) {
  // PBKDF2-SHA256, same params and PHC-style format as src/lib/password.ts
  // so the Workers-side verifyPassword can read what this writes.
  // Cloudflare Workers' Web Crypto caps PBKDF2 iterations at 100_000;
  // src/lib/password.ts uses the same. Keep these in sync.
  const ITERATIONS = 100_000;
  const HASH_LENGTH = 32;
  const SALT_LENGTH = 16;
  const salt = randomBytes(SALT_LENGTH);
  const hash = pbkdf2Sync(plain, salt, ITERATIONS, HASH_LENGTH, 'sha256');
  return `$pbkdf2-sha256$i=${ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`;
}

function b64encode(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '');
}

function randomSlug(len = 8) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
