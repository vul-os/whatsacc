// Seed realistic demo data for one user, end-to-end through the running
// backend's HTTP routes (so the same code paths real users hit). Falls back
// to direct DB writes only where no public API exists (e.g., access_points,
// since there's no route to create them today).
//
// Usage:
//   1. Make sure the backend is running on http://localhost:8787 (`deno task dev`)
//   2. cd backend
//   3. deno run -A --env-file=../.env scripts/seed-demo-data.ts
//
// After it finishes, log in at http://localhost:5173/login with the printed
// credentials to see populated locations, devices, access points, grants,
// phones, members, invites and analytics.

import postgres from 'postgres';

const BASE = 'http://localhost:8787';
const DB_URL = (Deno.env.get('DATABASE_URL') ?? '').trim();
if (!DB_URL) {
  console.error('error: DATABASE_URL not set (run with --env-file=../.env)');
  Deno.exit(1);
}

const DEMO_EMAIL = 'demo@whatsacc.com';
const DEMO_PASSWORD = 'DemoSeed_99';
const DEMO_NAME = 'Andile Demo';

const sql = postgres(DB_URL, { prepare: false, max: 1, onnotice: () => {} });

// ─── HTTP helper ───────────────────────────────────────────────────────────
type Resp = { status: number; body: any; text: string };
async function api(
  method: string,
  path: string,
  opts: { token?: string; json?: unknown } = {},
): Promise<Resp> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + path, { method, headers, body });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {/**/}
  return { status: res.status, body: parsed, text };
}

function expect2xx(label: string, r: Resp): boolean {
  if (r.status >= 200 && r.status < 300) return true;
  console.error(`✗ ${label} — ${r.status}: ${r.text.slice(0, 200)}`);
  return false;
}

function ok(s: string) { console.log(`  \x1b[32m✓\x1b[0m ${s}`); }
function step(s: string) { console.log(`\n\x1b[1m${s}\x1b[0m`); }

// ─── 0a. Wipe any existing demo data so re-runs stay clean ───────────────
step('Cleanup (so re-runs are idempotent)');
await sql.begin(async (tx) => {
  await tx`select set_config('app.is_platform_admin', 'true', true)`;
  // Drop every account this user is a member of (cascades to locations,
  // devices, access_points, grants, invites, wallets, subscriptions).
  await tx`
    delete from accounts where id in (
      select am.account_id from account_members am
      join users u on u.id = am.user_id
      where u.email = ${DEMO_EMAIL}
    )
  `;
  // Then drop the user (cascades to profiles, oauth_identities, phones,
  // sessions, refresh tokens, email verification tokens, KYC rows).
  await tx`delete from users where email = ${DEMO_EMAIL}`;
});
ok('cleared previous demo data');

// ─── 0b. Bootstrap demo user via existing seed-user.ts ───────────────────
step('Bootstrap demo user');
{
  const cmd = new Deno.Command('deno', {
    args: [
      'run', '-A', '--env-file=../.env', '--config=deno.json',
      'scripts/seed-user.ts',
      `--email=${DEMO_EMAIL}`, `--password=${DEMO_PASSWORD}`, `--name=${DEMO_NAME}`,
    ],
    cwd: Deno.cwd(),
    stdout: 'piped', stderr: 'piped',
  });
  const out = await cmd.output();
  if (!out.success) {
    console.error(new TextDecoder().decode(out.stderr));
    console.error('seed-user.ts failed; aborting.');
    Deno.exit(1);
  }
}
ok(`user ${DEMO_EMAIL}`);

// ─── 1. Login ─────────────────────────────────────────────────────────────
step('Login');
const login = await api('POST', '/auth/login', { json: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
if (!expect2xx('login', login)) Deno.exit(1);
const token: string = login.body.access_token;
ok('logged in');

const meRes = await api('GET', '/auth/me', { token });
const personalAccountId: string = meRes.body.accounts[0].account_id;
const userId: string = meRes.body.user.id;
ok(`personal account ${personalAccountId.slice(0, 8)}…`);

// ─── 2. Create a business account (now possible after Bug 1 fix) ──────────
step('Create business account');
const biz = await api('POST', '/accounts', {
  token,
  json: { name: 'Sunset Apartments', billing_type: 'business', country_code: 'ZA' },
});
expect2xx('create business account', biz);
const businessAccountId: string = biz.body.id;
ok(`business account "Sunset Apartments" ${businessAccountId.slice(0, 8)}…`);

// ─── 3. Locations — under each account ────────────────────────────────────
step('Locations');

type LocSpec = {
  account_id: string;
  type: 'house' | 'complex' | 'building' | 'other';
  name: string;
  slug: string;
  parent?: string;
};

async function createLocation(spec: LocSpec): Promise<string> {
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
ok(`Home (personal) ${homeId.slice(0, 8)}…`);

const cottageId = await createLocation({
  account_id: personalAccountId, type: 'house', name: 'Garden Cottage', slug: 'cottage', parent: homeId,
});
ok('Garden Cottage (sub-location of Home)');

const sunsetId = await createLocation({ account_id: businessAccountId, type: 'complex', name: 'Sunset Apartments', slug: 'sunset' });
ok(`Sunset Apartments (business) ${sunsetId.slice(0, 8)}…`);

const apt3a = await createLocation({
  account_id: businessAccountId, type: 'building', name: 'Block A', slug: 'block-a', parent: sunsetId,
});
ok('Block A (sub-location of Sunset Apartments)');

// ─── 4. Devices — at each location ────────────────────────────────────────
step('Devices');

type DevSpec = { location_id: string; label: string };
const deviceSpecs: DevSpec[] = [
  { location_id: homeId, label: 'Main Gate Controller' },
  { location_id: homeId, label: 'Garage Door Opener' },
  { location_id: cottageId, label: 'Cottage Pedestrian Gate' },
  { location_id: sunsetId, label: 'Vehicle Boom — North' },
  { location_id: sunsetId, label: 'Vehicle Boom — South' },
  { location_id: apt3a, label: 'Block A Lobby Door' },
];
const deviceIds: { id: string; spec: DevSpec }[] = [];
for (const d of deviceSpecs) {
  const r = await api('POST', '/devices', { token, json: { location_id: d.location_id, label: d.label } });
  expect2xx(`create device ${d.label}`, r);
  deviceIds.push({ id: r.body.id, spec: d });
  ok(d.label);
}

// ─── 5. Access points — direct DB (no public API) ─────────────────────────
step('Access points (direct DB — no creation route exists yet)');

const accessPointSpecs: { device_id: string; location_id: string; name: string; kind: 'gate' | 'door' | 'barrier' | 'other' }[] = [
  { device_id: deviceIds[0].id, location_id: homeId, name: 'Front Gate', kind: 'gate' },
  { device_id: deviceIds[1].id, location_id: homeId, name: 'Garage', kind: 'door' },
  { device_id: deviceIds[2].id, location_id: cottageId, name: 'Cottage Pedestrian', kind: 'gate' },
  { device_id: deviceIds[3].id, location_id: sunsetId, name: 'North Boom', kind: 'barrier' },
  { device_id: deviceIds[4].id, location_id: sunsetId, name: 'South Boom', kind: 'barrier' },
  { device_id: deviceIds[5].id, location_id: apt3a, name: 'Lobby Door', kind: 'door' },
];

await sql.begin(async (tx) => {
  await tx`select set_config('app.user_id', '', true)`;
  await tx`select set_config('app.account_id', '', true)`;
  await tx`select set_config('app.is_platform_admin', 'true', true)`;

  for (const ap of accessPointSpecs) {
    await tx`
      insert into access_points (location_id, name, kind, device_id, status)
      values (${ap.location_id}, ${ap.name}, ${ap.kind}, ${ap.device_id}, 'active')
    `;
  }
});
for (const ap of accessPointSpecs) ok(`${ap.name} (${ap.kind})`);

// ─── 6. Phones — added to user ────────────────────────────────────────────
step('Phones');
const phones = [
  '+27821234567', // primary
  '+27839876543',
];
for (const phone of phones) {
  const r = await api('POST', '/phones/me/phones', { token, json: { phone_e164: phone } });
  expect2xx(`add phone ${phone}`, r);
  ok(phone);
}

// ─── 7. Grants — with real access points now that we created some ────────
step('Grants');

const apIdsRes = await api('GET', '/access/access-points', { token });
const apIds: string[] = (apIdsRes.body.access_points ?? []).map((p: any) => p.id);

if (apIds.length === 0) {
  console.error('! no access points found via GET; skipping grants');
} else {
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
}

// ─── 8. Referrals — set KYC ──────────────────────────────────────────────
step('Referrals (KYC)');
const kycRes = await api('PUT', '/referrals/kyc', {
  token,
  json: {
    full_name: DEMO_NAME,
    contact_email: DEMO_EMAIL,
    cellphone: '+27821234567',
    id_kind: 'za_id',
    id_number: '9001015432087', // dummy SA-format ID
    bank_name: 'Standard Bank',
    bank_branch_code: '051001',
    bank_account_number: '0000000000',
    bank_account_holder: DEMO_NAME,
    bank_account_type: 'cheque',
  },
});
if (expect2xx('set referral KYC', kycRes)) ok('KYC details saved');

// ─── 9. Pending invites — DB rows will exist even if email send fails ────
step('Invites (email send may fail; DB rows will still be created)');
const inviteEmails = ['partner@example.com', 'tenant.alex@example.com'];
for (const email of inviteEmails) {
  const r = await api('POST', `/accounts/${businessAccountId}/invites`, {
    token,
    json: { email, role: 'member' },
  });
  if (r.status >= 200 && r.status < 300) {
    ok(`invited ${email}`);
  } else {
    // Confirm the row landed despite email failure
    const rows = await sql<{ id: string }[]>`
      select id from account_invites
      where account_id = ${businessAccountId} and email = ${email}
      order by created_at desc limit 1
    `;
    if (rows[0]) ok(`invited ${email} (email send failed but DB row created)`);
    else console.error(`✗ invite ${email} — ${r.status}`);
  }
}

// ─── 10. Wallet topup intent — gets created, hosted-checkout URL ─────────
step('Billing — wallet topup intent (hosted checkout URL ready)');
const topup = await api('POST', '/billing/wallet/topup', {
  token,
  json: { account_id: businessAccountId, amount_cents: 250_00 },
});
if (expect2xx('init wallet topup', topup)) {
  ok(`topup intent created`);
  ok(`hosted checkout URL: ${topup.body.authorization_url}`);
}

// ─── Summary ──────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m─── Done ───\x1b[0m\n`);
console.log(`Frontend:  http://localhost:5173`);
console.log(`Email:     ${DEMO_EMAIL}`);
console.log(`Password:  ${DEMO_PASSWORD}\n`);
console.log(`Personal account:  ${personalAccountId}`);
console.log(`Business account:  ${businessAccountId} ("Sunset Apartments")`);

await sql.end();
