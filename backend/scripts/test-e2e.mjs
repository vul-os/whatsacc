// End-to-end feature smoke test against the running Workers backend
// (wrangler dev on :8787, talking to Neon dev). Bypasses email-driven flows
// by seeding the user directly via DB (same shortcut as before).
//
// Run with:
//   cd backend
//   node --env-file=../.env.dev /tmp/e2e-workers.mjs

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? process.env.E2E_BASE ?? 'http://localhost:8787';
const DB_URL = (process.env.DATABASE_URL ?? '').trim();
if (!DB_URL) { console.error('error: DATABASE_URL not set'); process.exit(2); }

const TS = Date.now();
const aliceEmail = `e2e-alice-${TS}@example.com`;
const bobEmail = `e2e-bob-${TS}@example.com`;
const password = 'SuperSecret_99';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const fails = [];
const warns = [];

const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', bold: '\x1b[1m', reset: '\x1b[0m' };
function ok(s, info = '') { console.log(`  ${C.ok}✓${C.reset} ${s}${info ? ' — ' + info : ''}`); passed++; }
function bad(s, info) { console.log(`  ${C.bad}✗${C.reset} ${s} — ${info}`); fails.push(`${s}: ${info}`); failed++; }
function warn(s, info) { console.log(`  ${C.warn}⚠${C.reset} ${s} — ${info}`); warns.push(`${s}: ${info}`); }
function step(s) { console.log(`\n${C.bold}${s}${C.reset}`); }

// Force IPv4 single-IP for the Postgres client (Neon multi-IP tripping Node)
const u = new URL(DB_URL);
const { address } = await lookup(u.hostname, { family: 4 });
const sql = new pg.Client({
  host: address,
  port: Number(u.port) || 5432,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, ''),
  ssl: { servername: u.hostname, rejectUnauthorized: false },
});
await sql.connect();

async function api(method, path, opts = {}) {
  const headers = { 'Connection': 'close' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  let body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['Content-Type'] = 'application/json';
  }
  // Wrangler dev's miniflare drops idle keep-alive sockets faster than
  // Node's undici expects. After ~30s idle (seed scripts running), the
  // first request through a pooled connection fails with UND_ERR_SOCKET.
  // Retry once on that exact failure.
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(BASE + path, { method, headers, body });
      break;
    } catch (err) {
      const code = err?.cause?.code;
      if (attempt === 0 && (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET')) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      throw err;
    }
  }
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {/**/}
  return { status: res.status, body: parsed, text };
}

function expect(label, r, wanted = [200, 201, 204]) {
  if (wanted.includes(r.status)) { ok(label, `${r.status}`); return true; }
  bad(label, `expected ${wanted.join('/')}, got ${r.status}: ${r.text.slice(0, 200)}`);
  return false;
}

async function seedUser(email, name) {
  const envFile = process.env.NPM_ENV_FILE
    ?? join(dirname(__dirname), 'Documents/whatsacc-mono/.env.dev'); // best-effort
  const cmd = spawnSync(
    'node',
    [
      `--env-file=../.env.dev`,
      'scripts/seed-user.mjs',
      `--email=${email}`, `--password=${password}`, `--name=${name}`,
    ],
    { cwd: '/home/exo/Documents/whatsacc-mono/backend', stdio: 'pipe' },
  );
  return cmd.status === 0;
}

try {
  // ─── Cleanup any leftover users with this TS prefix (none typically) ───
  step('Cleanup');
  await sql.query(`select set_config('app.is_platform_admin','true',true)`);
  await sql.query(
    `delete from accounts where id in (
       select am.account_id from account_members am
       join users u on u.id = am.user_id
       where u.email = any($1::text[])
     )`,
    [[aliceEmail, bobEmail]],
  );
  await sql.query(`delete from users where email = any($1::text[])`, [[aliceEmail, bobEmail]]);
  ok('cleared any prior test users');

  // ─── Health ─────────────────────────────────────────────────────────────
  step('Health');
  const h = await api('GET', '/health');
  if (expect('GET /health', h)) ok('db_now', h.body?.db_now ?? '?');

  // ─── Reference ──────────────────────────────────────────────────────────
  step('Reference');
  expect('GET /reference/countries', await api('GET', '/reference/countries'));

  // ─── Setup users ────────────────────────────────────────────────────────
  step('Setup (seed-user.mjs)');
  if (await seedUser(aliceEmail, 'Alice E2E')) ok('seed Alice', aliceEmail);
  else bad('seed Alice', 'seed-user.mjs failed');
  if (await seedUser(bobEmail, 'Bob E2E')) ok('seed Bob', bobEmail);
  else bad('seed Bob', 'seed-user.mjs failed');

  // ─── Auth ───────────────────────────────────────────────────────────────
  step('Auth');
  const aliceLogin = await api('POST', '/auth/login', { json: { email: aliceEmail, password } });
  if (!expect('login Alice', aliceLogin)) process.exit(1);
  const aliceTok = aliceLogin.body?.access_token;
  const meRes = await api('GET', '/auth/me', { token: aliceTok });
  expect('GET /auth/me', meRes);
  if (meRes.body?.user?.email === aliceEmail) ok('auth/me returns Alice');

  const bobLogin = await api('POST', '/auth/login', { json: { email: bobEmail, password } });
  if (!expect('login Bob', bobLogin)) process.exit(1);
  const bobTok = bobLogin.body?.access_token;

  // ─── Accounts ───────────────────────────────────────────────────────────
  step('Accounts');
  expect('list accounts', await api('GET', '/accounts', { token: aliceTok }));
  const newAcct = await api('POST', '/accounts', {
    token: aliceTok,
    json: { name: 'Alice Business', country_code: 'ZA' },
  });
  let businessAcctId = null;
  if (newAcct.status === 201) { ok('create business account', newAcct.status.toString()); businessAcctId = newAcct.body?.id; }
  else bad('create business account', `${newAcct.status}: ${newAcct.text.slice(0, 200)}`);

  if (businessAcctId) {
    expect('GET account details', await api('GET', `/accounts/${businessAcctId}`, { token: aliceTok }));
    expect('list account members', await api('GET', `/accounts/${businessAcctId}/members`, { token: aliceTok }));
  }

  // ─── Locations ──────────────────────────────────────────────────────────
  step('Locations');
  let locationId = null;
  if (businessAcctId) {
    const cr = await api('POST', `/locations/accounts/${businessAcctId}/locations`, {
      token: aliceTok,
      json: { type: 'house', name: 'Test House', slug: `test-house-${TS}` },
    });
    if (expect('create location', cr, [201])) locationId = cr.body?.id;
    expect('list locations', await api('GET', `/locations/accounts/${businessAcctId}/locations`, { token: aliceTok }));
    if (locationId) {
      expect('GET location by id', await api('GET', `/locations/${locationId}`, { token: aliceTok }));
      expect('PATCH location', await api('PATCH', `/locations/${locationId}`, { token: aliceTok, json: { name: 'Renamed' } }));
    }
  }

  // ─── Devices ────────────────────────────────────────────────────────────
  step('Devices');
  let deviceId = null;
  if (locationId) {
    const cr = await api('POST', '/devices', { token: aliceTok, json: { location_id: locationId, label: 'Front gate' } });
    if (expect('create device', cr, [201])) deviceId = cr.body?.id;
    expect('list devices', await api('GET', '/devices', { token: aliceTok }));
  }

  // ─── Access points (new route) ─────────────────────────────────────────
  step('Access points');
  let apId = null;
  if (locationId) {
    const cr = await api('POST', '/access/access-points', {
      token: aliceTok,
      json: { location_id: locationId, name: 'Test Gate', kind: 'gate', device_id: deviceId },
    });
    if (expect('create access point', cr, [201])) apId = cr.body?.id;
    expect('list access points', await api('GET', '/access/access-points', { token: aliceTok }));
    if (apId) expect('GET access point by id', await api('GET', `/access/access-points/${apId}`, { token: aliceTok }));
  }

  // ─── Phones ─────────────────────────────────────────────────────────────
  step('Phones');
  expect('list my phones', await api('GET', '/phones/me/phones', { token: aliceTok }));
  expect('add phone', await api('POST', '/phones/me/phones', {
    token: aliceTok,
    json: { phone_e164: `+27821${String(TS).slice(-6)}` },
  }), [201]);

  // ─── Grants ─────────────────────────────────────────────────────────────
  step('Grants');
  expect('list grants', await api('GET', '/access/grants', { token: aliceTok }));
  if (apId) {
    const grant = await api('POST', '/access/grants', {
      token: aliceTok,
      json: {
        access_point_ids: [apId],
        phone_e164: '+27821234567',
        visitor_name: 'Test Visitor',
        ends_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
      },
    });
    expect('create grant', grant, [201]);
  }

  // ─── Analytics ──────────────────────────────────────────────────────────
  step('Analytics');
  if (businessAcctId) expect('account analytics', await api('GET', `/analytics/accounts/${businessAcctId}/summary`, { token: aliceTok }));
  if (locationId) expect('location analytics', await api('GET', `/analytics/locations/${locationId}/summary`, { token: aliceTok }));

  // ─── Invite (email broken — DB row should still land) ──────────────────
  step('Invite flow');
  if (businessAcctId) {
    const invite = await api('POST', `/accounts/${businessAcctId}/invites`, {
      token: aliceTok,
      json: { email: bobEmail, role: 'member', phone_e164: '+27821234567' },
    });
    if (invite.status >= 200 && invite.status < 300) ok('send invite', `${invite.status}`);
    else {
      const rows = await sql.query(
        `select id from account_invites where account_id = $1 and email = $2 order by created_at desc limit 1`,
        [businessAcctId, bobEmail],
      );
      if (rows.rows[0]) warn('invite (email send failed)', 'DB row created — Resend domain unverified is expected');
      else bad('invite', `${invite.status}: ${invite.text.slice(0, 200)}`);
    }
  }

  // ─── Done ───────────────────────────────────────────────────────────────
  console.log(`\n${C.bold}Result: ${passed} passed, ${failed} failed${C.reset}`);
  if (warns.length) {
    console.log(`\n${C.warn}Warnings (expected for the demo state):${C.reset}`);
    for (const w of warns) console.log(`  • ${w}`);
  }
  if (fails.length) {
    console.log(`\n${C.bad}Real failures:${C.reset}`);
    for (const f of fails) console.log(`  • ${f}`);
  }
} finally {
  await sql.end();
}

process.exit(failed === 0 ? 0 : 1);
