// Seed realistic demo data for one user, end-to-end through the running
// backend's HTTP routes. Falls back to direct DB writes only where no public
// API exists yet (currently: nothing — POST /access/access-points was added).
//
// Usage:
//   1. Make sure the backend is running (`npm run dev` -> wrangler dev on :8787)
//   2. cd backend
//   3. node --env-file=../.env scripts/seed-demo-data.mjs
//
// After it finishes, log in at http://localhost:5173/login as
//   demo@whatsacc.com / DemoSeed_99

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const DB_URL = (process.env.DATABASE_URL ?? '').trim();
if (!DB_URL) {
  console.error('error: DATABASE_URL not set (run with --env-file=../.env)');
  process.exit(2);
}

const DEMO_EMAIL = 'demo@whatsacc.com';
const DEMO_PASSWORD = 'DemoSeed_99';
const DEMO_NAME = 'Andile Demo';

// Force single-IPv4 to dodge Node's multi-IP connect failure mode
// (broken IPv6 + Neon load-balanced AWS IPs).
const dbU = new URL(DB_URL);
const { address: dbAddr } = await lookup(dbU.hostname, { family: 4 });
const client = new pg.Client({
  host: dbAddr,
  port: Number(dbU.port) || 5432,
  user: decodeURIComponent(dbU.username),
  password: decodeURIComponent(dbU.password),
  database: dbU.pathname.replace(/^\//, ''),
  ssl: { servername: dbU.hostname, rejectUnauthorized: false },
});
await client.connect();

const TS = Date.now();

function ok(s) { console.log(`  \x1b[32m✓\x1b[0m ${s}`); }
function bad(s, info) { console.log(`  \x1b[31m✗\x1b[0m ${s} — ${info}`); }
function warn(s, info) { console.log(`  \x1b[33m⚠\x1b[0m ${s} — ${info}`); }
function step(s) { console.log(`\n\x1b[1m${s}\x1b[0m`); }

async function api(method, path, opts = {}) {
  const headers = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  let body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + path, { method, headers, body });
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {/**/}
  return { status: res.status, body: parsed, text };
}

function expect2xx(label, r) {
  if (r.status >= 200 && r.status < 300) return true;
  bad(label, `${r.status}: ${r.text.slice(0, 200)}`);
  return false;
}

try {
  // ─── 0a. Wipe existing demo data ────────────────────────────────────────
  step('Cleanup (so re-runs are idempotent)');
  await client.query("select set_config('app.is_platform_admin', 'true', true)");
  await client.query(
    `delete from accounts where id in (
       select am.account_id from account_members am
       join users u on u.id = am.user_id
       where u.email = $1
     )`,
    [DEMO_EMAIL],
  );
  await client.query('delete from users where email = $1', [DEMO_EMAIL]);
  ok('cleared previous demo data');

  // ─── 0b. Bootstrap demo user via existing seed-user.mjs ────────────────
  step('Bootstrap demo user');
  const seed = spawnSync(
    'node',
    [
      `--env-file=${join(dirname(__dirname), '..', '.env')}`,
      join(__dirname, 'seed-user.mjs'),
      `--email=${DEMO_EMAIL}`,
      `--password=${DEMO_PASSWORD}`,
      `--name=${DEMO_NAME}`,
      `--country=ZA`,
    ],
    { stdio: 'pipe' },
  );
  if (seed.status !== 0) {
    console.error(seed.stderr?.toString());
    console.error('seed-user.mjs failed; aborting.');
    process.exit(1);
  }
  ok(`user ${DEMO_EMAIL}`);

  // ─── 1. Login ──────────────────────────────────────────────────────────
  step('Login');
  const login = await api('POST', '/auth/login', {
    json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  if (!expect2xx('login', login)) process.exit(1);
  const token = login.body.access_token;
  ok('logged in');

  const meRes = await api('GET', '/auth/me', { token });
  const personalAccountId = meRes.body.accounts[0].account_id;
  ok(`personal account ${personalAccountId.slice(0, 8)}…`);

  // ─── 2. Business account ───────────────────────────────────────────────
  step('Create business account');
  const biz = await api('POST', '/accounts', {
    token,
    json: { name: 'Sunset Apartments', billing_type: 'business', country_code: 'ZA' },
  });
  expect2xx('create business account', biz);
  const businessAccountId = biz.body.id;
  ok(`Sunset Apartments ${businessAccountId.slice(0, 8)}…`);

  // ─── 3. Locations ──────────────────────────────────────────────────────
  step('Locations');
  async function createLocation(spec) {
    const r = await api('POST', `/locations/accounts/${spec.account_id}/locations`, {
      token,
      json: {
        type: spec.type,
        name: spec.name,
        slug: spec.slug,
        parent_location_id: spec.parent ?? null,
        address: { street: '12 Camps Bay Drive', city: 'Cape Town', postal_code: '8005', country: 'ZA' },
      },
    });
    expect2xx(`create location "${spec.name}"`, r);
    return r.body.id;
  }
  const homeId = await createLocation({ account_id: personalAccountId, type: 'house', name: 'Home', slug: 'home' });
  ok('Home (personal)');
  const cottageId = await createLocation({
    account_id: personalAccountId, type: 'house', name: 'Garden Cottage', slug: 'cottage', parent: homeId,
  });
  ok('Garden Cottage');
  const sunsetId = await createLocation({ account_id: businessAccountId, type: 'complex', name: 'Sunset Apartments', slug: 'sunset' });
  ok('Sunset Apartments (business)');
  const apt3a = await createLocation({
    account_id: businessAccountId, type: 'building', name: 'Block A', slug: 'block-a', parent: sunsetId,
  });
  ok('Block A');

  // ─── 4. Devices ────────────────────────────────────────────────────────
  step('Devices');
  const deviceSpecs = [
    { location_id: homeId, label: 'Main Gate Controller' },
    { location_id: homeId, label: 'Garage Door Opener' },
    { location_id: cottageId, label: 'Cottage Pedestrian Gate' },
    { location_id: sunsetId, label: 'Vehicle Boom — North' },
    { location_id: sunsetId, label: 'Vehicle Boom — South' },
    { location_id: apt3a, label: 'Block A Lobby Door' },
  ];
  const devices = [];
  for (const d of deviceSpecs) {
    const r = await api('POST', '/devices', { token, json: { location_id: d.location_id, label: d.label } });
    expect2xx(`create device ${d.label}`, r);
    devices.push({ id: r.body.id, ...d });
    ok(d.label);
  }

  // ─── 5. Access points (now via API — the route exists since 2026-05-06) ─
  step('Access points');
  const accessPointSpecs = [
    { device_id: devices[0].id, location_id: homeId, name: 'Front Gate', kind: 'gate' },
    { device_id: devices[1].id, location_id: homeId, name: 'Garage', kind: 'door' },
    { device_id: devices[2].id, location_id: cottageId, name: 'Cottage Pedestrian', kind: 'gate' },
    { device_id: devices[3].id, location_id: sunsetId, name: 'North Boom', kind: 'barrier' },
    { device_id: devices[4].id, location_id: sunsetId, name: 'South Boom', kind: 'barrier' },
    { device_id: devices[5].id, location_id: apt3a, name: 'Lobby Door', kind: 'door' },
  ];
  for (const ap of accessPointSpecs) {
    const r = await api('POST', '/access/access-points', { token, json: ap });
    if (expect2xx(`access point ${ap.name}`, r)) ok(`${ap.name} (${ap.kind})`);
  }

  // ─── 6. Phones ─────────────────────────────────────────────────────────
  step('Phones');
  for (const phone of ['+27821234567', '+27839876543']) {
    const r = await api('POST', '/phones/me/phones', { token, json: { phone_e164: phone } });
    if (expect2xx(`add phone ${phone}`, r)) ok(phone);
  }

  // ─── 7. Grants ─────────────────────────────────────────────────────────
  step('Grants');
  const apIdsRes = await api('GET', '/access/access-points', { token });
  const apIds = (apIdsRes.body.access_points ?? []).map((p) => p.id);
  const grantSpecs = [
    { ap: apIds.slice(0, 1), phone: '+27821111111', name: 'Mary — Cleaner', hours: 12, max_uses: 1 },
    { ap: apIds.slice(0, 2), phone: '+27822222222', name: 'John Smith — Visitor', hours: 24, max_uses: 3 },
    { ap: apIds.slice(0, 1), phone: '+27823333333', name: 'Acme Delivery', hours: 4, max_uses: 1 },
    { ap: apIds.slice(3, 5), phone: '+27824444444', name: 'Sunset Block A — Tenant Joseph', hours: 24 * 30, max_uses: 10000 },
  ];
  for (const g of grantSpecs) {
    const r = await api('POST', '/access/grants', {
      token,
      json: {
        access_point_ids: g.ap,
        phone_e164: g.phone,
        visitor_name: g.name,
        ends_at: new Date(Date.now() + g.hours * 3600_000).toISOString(),
        max_uses: g.max_uses,
        notes: `Auto-seeded demo grant for ${g.name}.`,
      },
    });
    if (expect2xx(`grant ${g.name}`, r)) ok(`${g.name} (${g.hours}h, ${g.ap.length} access point(s))`);
  }

  // ─── 8. Referrals KYC ──────────────────────────────────────────────────
  step('Referrals (KYC)');
  const kycRes = await api('PUT', '/referrals/kyc', {
    token,
    json: {
      full_name: DEMO_NAME,
      contact_email: DEMO_EMAIL,
      cellphone: '+27821234567',
      id_kind: 'za_id',
      id_number: '9001015432087',
      bank_name: 'Standard Bank',
      bank_branch_code: '051001',
      bank_account_number: '0000000000',
      bank_account_holder: DEMO_NAME,
      bank_account_type: 'cheque',
    },
  });
  if (expect2xx('set referral KYC', kycRes)) ok('KYC details saved');

  // ─── 9. Pending invites ────────────────────────────────────────────────
  step('Invites (email send may fail; DB rows still created)');
  for (const email of ['partner@example.com', 'tenant.alex@example.com']) {
    const r = await api('POST', `/accounts/${businessAccountId}/invites`, {
      token,
      json: { email, role: 'member' },
    });
    if (r.status >= 200 && r.status < 300) ok(`invited ${email}`);
    else {
      const rows = await client.query(
        `select id from account_invites where account_id = $1 and email = $2
         order by created_at desc limit 1`,
        [businessAccountId, email],
      );
      if (rows.rows[0]) ok(`invited ${email} (email send failed but DB row created)`);
      else bad(`invite ${email}`, `${r.status}`);
    }
  }

  // ─── 10. Wallet topup intent ───────────────────────────────────────────
  step('Billing — wallet topup intent (real Paystack)');
  const topup = await api('POST', '/billing/wallet/topup', {
    token,
    json: { account_id: businessAccountId, amount_cents: 250_00 },
  });
  if (expect2xx('init wallet topup', topup)) {
    ok('topup intent created');
    ok(`hosted checkout URL: ${topup.body.authorization_url}`);
  }

  // ─── Summary ───────────────────────────────────────────────────────────
  console.log(`\n\x1b[1m─── Done ───\x1b[0m\n`);
  console.log(`Frontend:  http://localhost:5173`);
  console.log(`Email:     ${DEMO_EMAIL}`);
  console.log(`Password:  ${DEMO_PASSWORD}\n`);
  console.log(`Personal account:  ${personalAccountId}`);
  console.log(`Business account:  ${businessAccountId} ("Sunset Apartments")`);
} finally {
  await client.end();
}
