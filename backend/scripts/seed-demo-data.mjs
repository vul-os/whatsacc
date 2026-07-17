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

const DEMO_EMAIL = 'whatsaccsupport@gmail.com';
const DEMO_PASSWORD = 'happy123';
const DEMO_NAME = 'Whatsacc Support';

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
      `--location-name=Home`,
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
  // The first location ("Home") is auto-created during register and is its
  // own account. We add two more — "Sunset Apartments" and "Garden Cottage"
  // — each as a separate top-level location with its own account.
  const homeAccountId = meRes.body.accounts[0].account_id;
  const homeLocations = await api('GET', `/locations/accounts/${homeAccountId}/locations`, { token });
  const homeId = homeLocations.body.locations[0]?.id;
  ok(`Home auto-created on signup`, homeId?.slice(0, 8) ?? '?');

  // ─── 2. Two more locations, each its own account ──────────────────────
  step('Add a second location: Sunset Apartments');
  const sunsetCreate = await api('POST', '/locations', {
    token,
    json: {
      name: 'Sunset Apartments', type: 'complex', country_code: 'ZA',
      address: { city: 'Cape Town', country: 'ZA' },
    },
  });
  expect2xx('POST /locations Sunset Apartments', sunsetCreate);
  const sunsetId = sunsetCreate.body.id;
  const sunsetAccountId = sunsetCreate.body.account_id;

  step('Add a third location: Garden Cottage');
  const cottageCreate = await api('POST', '/locations', {
    token,
    json: {
      name: 'Garden Cottage', type: 'house', country_code: 'ZA',
      address: { city: 'Cape Town', country: 'ZA' },
    },
  });
  expect2xx('POST /locations Garden Cottage', cottageCreate);
  const cottageId = cottageCreate.body.id;
  const cottageAccountId = cottageCreate.body.account_id;

  // ─── 3. Devices ────────────────────────────────────────────────────────
  step('Devices');
  const deviceSpecs = [
    { location_id: homeId, label: 'Home — Main Gate' },
    { location_id: homeId, label: 'Home — Garage' },
    { location_id: sunsetId, label: 'Sunset — North Boom' },
    { location_id: sunsetId, label: 'Sunset — South Boom' },
    { location_id: cottageId, label: 'Cottage — Pedestrian' },
  ];
  const devices = [];
  for (const d of deviceSpecs) {
    const r = await api('POST', '/devices', { token, json: { location_id: d.location_id, label: d.label } });
    expect2xx(`create device ${d.label}`, r);
    devices.push({ id: r.body.id, ...d });
    ok(d.label);
  }

  // ─── 4. Access points ──────────────────────────────────────────────────
  step('Access points');
  const accessPointSpecs = [
    { device_id: devices[0].id, location_id: homeId, name: 'Front Gate', kind: 'gate' },
    { device_id: devices[1].id, location_id: homeId, name: 'Garage', kind: 'door' },
    { device_id: devices[2].id, location_id: sunsetId, name: 'North Boom', kind: 'barrier' },
    { device_id: devices[3].id, location_id: sunsetId, name: 'South Boom', kind: 'barrier' },
    { device_id: devices[4].id, location_id: cottageId, name: 'Cottage Pedestrian', kind: 'gate' },
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

  // ─── 7. Pending invites — to the Sunset Apartments location ──────────
  step('Invites to Sunset Apartments (email send may fail; DB rows still created)');
  for (const email of ['partner@example.com', 'tenant.alex@example.com']) {
    const r = await api('POST', `/accounts/${sunsetAccountId}/invites`, {
      token,
      json: { email, role: 'member', phone_e164: '+27000000000' },
    });
    if (r.status >= 200 && r.status < 300) ok(`invited ${email}`);
    else {
      const rows = await client.query(
        `select id from account_invites where account_id = $1 and email = $2
         order by created_at desc limit 1`,
        [sunsetAccountId, email],
      );
      if (rows.rows[0]) ok(`invited ${email} (email send failed but DB row created)`);
      else bad(`invite ${email}`, `${r.status}`);
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────
  console.log(`\n\x1b[1m─── Done ───\x1b[0m\n`);
  console.log(`Frontend:  http://localhost:5173`);
  console.log(`Email:     ${DEMO_EMAIL}`);
  console.log(`Password:  ${DEMO_PASSWORD}\n`);
  console.log(`Locations seeded: Home (${homeAccountId.slice(0, 8)}…), Sunset Apartments (${sunsetAccountId.slice(0, 8)}…), Garden Cottage (${cottageAccountId.slice(0, 8)}…)`);
} finally {
  await client.end();
}
