// Cross-org RLS isolation probe.
// Creates two unrelated owner-users, has each create their own org +
// location + access-point, then tries every cross-tenant access pattern
// from the OTHER user's session. Anything that leaks Org A data to User B
// (or vice versa) is a real security finding.
//
//   cd backend && BASE_URL=https://whatsacc-backend-dev.whatsaccsupport.workers.dev \
//     node --env-file=../.env.dev scripts/test-rls-isolation.mjs

const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const TS = Date.now();

let passed = 0, failed = 0;
const fails = [];
const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', bold: '\x1b[1m', reset: '\x1b[0m' };
const ok = (s, info = '') => { console.log(`  ${C.ok}✓${C.reset} ${s}${info ? ' — ' + info : ''}`); passed++; };
const bad = (s, info) => { console.log(`  ${C.bad}✗${C.reset} ${s} — ${info}`); fails.push(`${s}: ${info}`); failed++; };
const step = (s) => console.log(`\n${C.bold}${s}${C.reset}`);

async function api(method, path, opts = {}) {
  const headers = { 'Connection': 'close' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  let body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['Content-Type'] = 'application/json';
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(BASE + path, { method, headers, body });
      const text = await res.text();
      let parsed = text; try { parsed = text ? JSON.parse(text) : null; } catch {/**/}
      return { status: res.status, body: parsed, text };
    } catch (err) {
      if (attempt === 0 && (err?.cause?.code === 'UND_ERR_SOCKET' || err?.cause?.code === 'ECONNRESET')) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      throw err;
    }
  }
}

// A leak is anything where the response status is 2xx (we got data) AND the
// returned body looks meaningful (non-empty array, not a 'not_found' error).
function expectDenied(label, r) {
  // Two acceptable outcomes when a non-member tries to read another org's
  // resource:
  //   1. 404 / 403 / 401 — explicit denial
  //   2. 200/201 with an empty list (RLS filtered to zero rows) — also fine
  //      provided the response carries no Org-A data.
  if (r.status >= 400 && r.status < 600) {
    ok(label, `${r.status}`);
    return;
  }
  // 2xx response — must verify it doesn't contain Org A data.
  const body = r.body;
  // Common shapes: {accounts: []}, {locations: []}, {access_points: []}, etc.
  // Any of those being empty is fine. Direct GETs returning a single resource
  // by id should NOT return 200 — that's a leak.
  if (body && typeof body === 'object') {
    const arrayKeys = ['accounts', 'locations', 'access_points', 'devices', 'grants', 'members', 'phones'];
    for (const k of arrayKeys) {
      if (Array.isArray(body[k])) {
        if (body[k].length === 0) { ok(label, `200 empty (${k})`); return; }
        bad(label, `LEAK — ${k} returned ${body[k].length} item(s)`); return;
      }
    }
    if (body.id) { bad(label, `LEAK — returned resource with id ${body.id}`); return; }
  }
  bad(label, `unexpected ${r.status}: ${r.text.slice(0, 120)}`);
}

async function register(email, displayName, locationName) {
  const r = await api('POST', '/auth/register', {
    json: {
      email, password: 'Test_Password_99', display_name: displayName,
      location_name: locationName, country_code: 'ZA', account_type: 'personal',
    },
  });
  if (r.status !== 201) throw new Error(`register ${email}: ${r.status} ${r.text}`);
}
async function login(email) {
  const r = await api('POST', '/auth/login', {
    json: { email, password: 'Test_Password_99' },
  });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${r.text}`);
  return r.body.access_token;
}

step('Setup — two unrelated owners, each in their own org');
const aliceEmail = `rls-alice-${TS}@example.com`;
const bobEmail   = `rls-bob-${TS}@example.com`;

await register(aliceEmail, 'Alice Owner', 'Acme Apartments');
await register(bobEmail,   'Bob Owner',   'Bob Industries');
ok('registered Alice (Acme Apartments)', aliceEmail);
ok('registered Bob (Bob Industries)', bobEmail);

const aliceTok = await login(aliceEmail);
const bobTok   = await login(bobEmail);
ok('logged in both users');

// Pull each user's account list to find their org id
const aliceMe = await api('GET', '/auth/me', { token: aliceTok });
const bobMe   = await api('GET', '/auth/me', { token: bobTok });
const aliceOrg = aliceMe.body.accounts[0].account_id;
const bobOrg   = bobMe.body.accounts[0].account_id;
ok('Alice org', aliceOrg.slice(0, 8) + '…');
ok('Bob org',   bobOrg.slice(0, 8)   + '…');

// Each user creates a location + access point + device under their own org
async function createLocAp(token, accountId, slug) {
  const loc = await api('POST', `/locations/accounts/${accountId}/locations`, {
    token,
    json: { type: 'house', name: `${slug} HQ`, slug: `${slug}-hq-${TS}` },
  });
  if (loc.status !== 201) throw new Error(`create location ${slug}: ${loc.status} ${loc.text}`);
  const dev = await api('POST', '/devices', {
    token, json: { location_id: loc.body.id, label: `${slug} ctrl` },
  });
  if (dev.status !== 201) throw new Error(`create device ${slug}: ${dev.status} ${dev.text}`);
  const ap = await api('POST', '/access/access-points', {
    token,
    json: { location_id: loc.body.id, name: `${slug} Gate`, kind: 'gate', device_id: dev.body.id },
  });
  if (ap.status !== 201) throw new Error(`create AP ${slug}: ${ap.status} ${ap.text}`);
  return { locId: loc.body.id, devId: dev.body.id, apId: ap.body.id };
}
const alice = await createLocAp(aliceTok, aliceOrg, 'alice');
const bob   = await createLocAp(bobTok,   bobOrg,   'bob');
ok('Alice created loc/dev/ap', `loc ${alice.locId.slice(0,8)}…`);
ok('Bob created loc/dev/ap',   `loc ${bob.locId.slice(0,8)}…`);

step('Bob tries to read Alice\'s tenant data');
expectDenied('GET Alice\'s account details',         await api('GET', `/accounts/${aliceOrg}`,           { token: bobTok }));
expectDenied('GET Alice\'s account members',         await api('GET', `/accounts/${aliceOrg}/members`,   { token: bobTok }));
expectDenied('GET Alice\'s account billing',         await api('GET', `/billing/accounts/${aliceOrg}/billing`, { token: bobTok }));
expectDenied('LIST Alice\'s locations (by accountId)', await api('GET', `/locations/accounts/${aliceOrg}/locations`, { token: bobTok }));
expectDenied('GET Alice\'s location by id',          await api('GET', `/locations/${alice.locId}`,       { token: bobTok }));
expectDenied('GET Alice\'s access-point by id',      await api('GET', `/access/access-points/${alice.apId}`, { token: bobTok }));
expectDenied('GET Alice\'s analytics summary',       await api('GET', `/analytics/accounts/${aliceOrg}/summary`, { token: bobTok }));
expectDenied('GET Alice\'s location analytics',      await api('GET', `/analytics/locations/${alice.locId}/summary`, { token: bobTok }));
expectDenied('LIST Alice\'s grants (account scoped)',await api('GET', `/access/grants?account_id=${aliceOrg}`, { token: bobTok }));

step('Bob tries to write to Alice\'s tenant data');
expectDenied('PATCH Alice\'s location',
  await api('PATCH', `/locations/${alice.locId}`, { token: bobTok, json: { name: 'PWNED' } }));
expectDenied('CREATE location under Alice\'s org',
  await api('POST', `/locations/accounts/${aliceOrg}/locations`,
    { token: bobTok, json: { type: 'house', name: 'Bob squatting', slug: `pwn-${TS}` } }));
expectDenied('CREATE access-point under Alice\'s location',
  await api('POST', '/access/access-points',
    { token: bobTok, json: { location_id: alice.locId, name: 'Bob squatting AP', kind: 'gate' } }));
expectDenied('CREATE device under Alice\'s location',
  await api('POST', '/devices',
    { token: bobTok, json: { location_id: alice.locId, label: 'Bob squatting dev' } }));
expectDenied('CREATE grant on Alice\'s AP',
  await api('POST', '/access/grants',
    { token: bobTok, json: {
      access_point_ids: [alice.apId], phone_e164: '+27821234567',
      visitor_name: 'Squatter', ends_at: new Date(Date.now() + 24*3600_000).toISOString(),
    }}));
expectDenied('INVITE someone to Alice\'s org',
  await api('POST', `/accounts/${aliceOrg}/invites`,
    { token: bobTok, json: { email: 'evil@example.com', role: 'admin' } }));

step('Alice tries to read Bob\'s tenant data (mirror — same pattern)');
expectDenied('GET Bob\'s account details',     await api('GET', `/accounts/${bobOrg}`,           { token: aliceTok }));
expectDenied('GET Bob\'s account members',     await api('GET', `/accounts/${bobOrg}/members`,   { token: aliceTok }));
expectDenied('GET Bob\'s account billing',     await api('GET', `/billing/accounts/${bobOrg}/billing`, { token: aliceTok }));
expectDenied('GET Bob\'s location by id',      await api('GET', `/locations/${bob.locId}`,       { token: aliceTok }));
expectDenied('GET Bob\'s access-point by id',  await api('GET', `/access/access-points/${bob.apId}`, { token: aliceTok }));

step('Sanity — each user can still read their OWN data');
const aliceOwn = await api('GET', `/accounts/${aliceOrg}`, { token: aliceTok });
if (aliceOwn.status === 200 && aliceOwn.body?.id === aliceOrg) ok('Alice reads her own org', '200');
else bad('Alice reads her own org', `unexpected ${aliceOwn.status}`);

const bobOwnAp = await api('GET', `/access/access-points/${bob.apId}`, { token: bobTok });
if (bobOwnAp.status === 200 && bobOwnAp.body?.id === bob.apId) ok('Bob reads his own access-point', '200');
else bad('Bob reads his own access-point', `unexpected ${bobOwnAp.status}`);

const aliceList = await api('GET', '/accounts', { token: aliceTok });
const aliceListSet = new Set((aliceList.body?.accounts ?? []).map((a) => a.id));
if (aliceListSet.has(aliceOrg) && !aliceListSet.has(bobOrg))
  ok('Alice\'s account list contains hers, not Bob\'s');
else bad('account list filtering', `aliceList=${[...aliceListSet].map(s=>s.slice(0,8)).join(',')}`);

console.log(`\n${C.bold}Result: ${passed} passed, ${failed} failed${C.reset}`);
if (failed > 0) {
  console.log(`\n${C.bad}Real failures (potential security findings):${C.reset}`);
  for (const f of fails) console.log(`  • ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
