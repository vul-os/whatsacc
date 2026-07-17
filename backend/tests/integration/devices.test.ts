// Integration tests for the device claim-token lifecycle
// (src/routes/devices.ts): admin creates an unpaired device and gets a
// one-time claim token; the installer redeems it (optionally binding a
// public key); tokens are single-use and expire; listing is RLS-scoped.

import { assert, assertEquals, assertExists } from '../helpers/assert.ts';
import { bootTestApp, type AppHandle } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { registerUser, seedLocationWithAccessPoint, type RegisteredUser } from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';
import { adminSql } from '../helpers/chat.ts';

type DeviceListItem = {
  id: string;
  location_id: string;
  label: string | null;
  status: string;
  paired_at: string | null;
  claim_expires_at: string | null;
};

async function createDevice(
  app: AppHandle,
  u: RegisteredUser,
  locationId: string,
  extra: Record<string, unknown> = {},
) {
  return await app.request('POST', '/devices', {
    token: u.access_token,
    json: { location_id: locationId, ...extra },
  });
}

async function claimDevice(app: AppHandle, u: RegisteredUser, claimToken: string, publicKey?: string) {
  return await app.request('POST', '/devices/claim', {
    token: u.access_token,
    json: publicKey === undefined ? { claim_token: claimToken } : { claim_token: claimToken, public_key: publicKey },
  });
}

async function deviceRow(id: string) {
  const rows = await adminSql(
    async (tx) => await tx<{
      status: string;
      paired_at: Date | null;
      public_key: string | null;
      claim_token_hash: string | null;
      claim_expires_at: Date | null;
    }[]>`
      select status, paired_at, public_key, claim_token_hash, claim_expires_at
      from devices where id = ${id}
    `,
  );
  return rows[0]!;
}

// ---------------------------------------------------------------------------

dbTest('devices: admin create returns a one-time claim token; only its hash is stored', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

  const r = await createDevice(app, u, seeded.location_id, { label: 'Gate controller A' });
  assertEquals(r.status, 201);
  const body = r.body as {
    id: string;
    location_id: string;
    label: string;
    status: string;
    claim_token: string;
    claim_expires_at: string;
  };
  assertExists(body.id);
  assertEquals(body.location_id, seeded.location_id);
  assertEquals(body.label, 'Gate controller A');
  assertEquals(body.status, 'unpaired');
  assert(body.claim_token.length >= 24, 'claim token must be a real secret');
  // Default TTL is 1h.
  const ttlMs = new Date(body.claim_expires_at).getTime() - Date.now();
  assert(ttlMs > 55 * 60 * 1000 && ttlMs <= 60 * 60 * 1000, `default TTL ~1h, got ${ttlMs}ms`);

  // The DB stores only the hash — never the plaintext token.
  const row = await deviceRow(body.id);
  assertExists(row.claim_token_hash);
  assert(row.claim_token_hash !== body.claim_token, 'plaintext token must not be stored');
  assertEquals(row.status, 'unpaired');
  assertEquals(row.paired_at, null);
});

dbTest('devices: create validates admin role, location visibility, and TTL bounds', async () => {
  await resetData();
  const app = await bootTestApp();
  const owner = await registerUser(app);
  const member = await registerUser(app);
  const outsider = await registerUser(app);
  await adminSql(async (tx) => {
    await tx`
      insert into account_members (account_id, user_id, role, status)
      values (${owner.account_id}, ${member.user_id}, 'member', 'active')
    `;
  });
  const seeded = await seedLocationWithAccessPoint(owner.account_id, { withAccessPoint: true });

  // Plain members cannot mint claim tokens.
  const asMember = await createDevice(app, member, seeded.location_id);
  assertEquals(asMember.status, 403);
  assertEquals((asMember.body as { error: string }).error, 'not_account_admin');

  // Outsiders can't even see the location (RLS → not found).
  const asOutsider = await createDevice(app, outsider, seeded.location_id);
  assertEquals(asOutsider.status, 404);

  // TTL below the 60s floor and above the 7-day ceiling are rejected by zod.
  assertEquals((await createDevice(app, owner, seeded.location_id, { claim_ttl_seconds: 30 })).status, 400);
  assertEquals(
    (await createDevice(app, owner, seeded.location_id, { claim_ttl_seconds: 8 * 24 * 60 * 60 })).status,
    400,
  );

  // No devices got created by the failed attempts.
  const rows = await adminSql(
    async (tx) => await tx<{ count: string }[]>`select count(*)::text as count from devices`,
  );
  assertEquals(rows[0]!.count, '0');
});

dbTest('devices: claim pairs the device, stores the public key, and burns the token', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

  const created = await createDevice(app, u, seeded.location_id, { label: 'Pairing test' });
  const { id, claim_token } = created.body as { id: string; claim_token: string };

  const claim = await claimDevice(app, u, claim_token, 'ssh-ed25519 AAAA-test-device-key');
  assertEquals(claim.status, 200);
  assertEquals((claim.body as { id: string }).id, id);

  const row = await deviceRow(id);
  assertEquals(row.status, 'active');
  assertExists(row.paired_at);
  assertEquals(row.public_key, 'ssh-ed25519 AAAA-test-device-key');
  // Single-use: the token hash and its expiry are cleared on redemption.
  assertEquals(row.claim_token_hash, null);
  assertEquals(row.claim_expires_at, null);

  // Redeeming the same token again fails: the hash is gone, so the device
  // can no longer be found by token.
  const replay = await claimDevice(app, u, claim_token);
  assertEquals(replay.status, 404);
  assertEquals((replay.body as { error: string }).error, 'device_not_found');
});

dbTest('devices: claiming an already-paired device (fresh token forged onto it) is rejected', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
  const created = await createDevice(app, u, seeded.location_id);
  const { id, claim_token } = created.body as { id: string; claim_token: string };
  assertEquals((await claimDevice(app, u, claim_token, 'key-1')).status, 200);

  // Simulate an operator mistake: re-arming a claim hash on a paired device.
  // The paired_at guard still refuses re-pairing.
  await adminSql(async (tx) => {
    await tx`
      update devices
      set claim_token_hash = 'rearmed-hash-placeholder', claim_expires_at = now() + interval '1 hour'
      where id = ${id}
    `;
  });
  // We can't forge a token matching 'rearmed-hash-placeholder' (it's not a
  // real hash) — instead verify through a second device whose token we DO
  // know, after marking it paired.
  const second = await createDevice(app, u, seeded.location_id);
  const s = second.body as { id: string; claim_token: string };
  await adminSql(async (tx) => {
    await tx`update devices set paired_at = now(), status = 'active' where id = ${s.id}`;
  });
  const r = await claimDevice(app, u, s.claim_token);
  assertEquals(r.status, 400);
  assertEquals((r.body as { error: string }).error, 'device_already_paired');
});

dbTest('devices: expired claim tokens are refused with claim_expired', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
  const created = await createDevice(app, u, seeded.location_id, { claim_ttl_seconds: 60 });
  const { id, claim_token } = created.body as { id: string; claim_token: string };

  // Time-travel the expiry into the past.
  await adminSql(async (tx) => {
    await tx`update devices set claim_expires_at = now() - interval '1 minute' where id = ${id}`;
  });

  const r = await claimDevice(app, u, claim_token, 'late-key');
  assertEquals(r.status, 400);
  assertEquals((r.body as { error: string }).error, 'claim_expired');
  const row = await deviceRow(id);
  assertEquals(row.status, 'unpaired');
  assertEquals(row.public_key, null);
});

dbTest('devices: claim without a public key pairs but leaves public_key null', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
  const created = await createDevice(app, u, seeded.location_id);
  const { id, claim_token } = created.body as { id: string; claim_token: string };

  assertEquals((await claimDevice(app, u, claim_token)).status, 200);
  const row = await deviceRow(id);
  assertEquals(row.status, 'active');
  assertEquals(row.public_key, null);
});

dbTest('devices: list shows status/pairing and scopes by location, account, and RLS', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const outsider = await registerUser(app);
  const s1 = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
  const s2 = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

  const d1 = (await createDevice(app, u, s1.location_id, { label: 'Loc1 device' })).body as {
    id: string;
    claim_token: string;
  };
  const d2 = (await createDevice(app, u, s2.location_id, { label: 'Loc2 device' })).body as {
    id: string;
    claim_token: string;
  };
  assertEquals((await claimDevice(app, u, d1.claim_token, 'k1')).status, 200);

  // Unfiltered: both devices, with claim/pairing status visible.
  const all = await app.request('GET', '/devices', { token: u.access_token });
  assertEquals(all.status, 200);
  const allDevices = (all.body as { devices: DeviceListItem[] }).devices;
  assertEquals(allDevices.length, 2);
  const paired = allDevices.find((d) => d.id === d1.id)!;
  const unpaired = allDevices.find((d) => d.id === d2.id)!;
  assertEquals(paired.status, 'active');
  assertExists(paired.paired_at);
  assertEquals(unpaired.status, 'unpaired');
  assertEquals(unpaired.paired_at, null);
  assertExists(unpaired.claim_expires_at);

  // location_id filter narrows to one.
  const byLoc = await app.request('GET', '/devices', {
    token: u.access_token,
    query: { location_id: s2.location_id },
  });
  const byLocDevices = (byLoc.body as { devices: DeviceListItem[] }).devices;
  assertEquals(byLocDevices.length, 1);
  assertEquals(byLocDevices[0]!.id, d2.id);

  // account_id filter includes both; a foreign account id yields nothing.
  const byAcct = await app.request('GET', '/devices', {
    token: u.access_token,
    query: { account_id: u.account_id },
  });
  assertEquals((byAcct.body as { devices: DeviceListItem[] }).devices.length, 2);

  // RLS: an outsider sees an empty list, not an error.
  const foreign = await app.request('GET', '/devices', { token: outsider.access_token });
  assertEquals(foreign.status, 200);
  assertEquals((foreign.body as { devices: DeviceListItem[] }).devices.length, 0);

  // Unauthenticated access is refused outright.
  const anon = await app.request('GET', '/devices');
  assertEquals(anon.status, 401);
});

dbTest('devices: a valid claim token is useless to a user outside the account (RLS)', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const outsider = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
  const created = await createDevice(app, u, seeded.location_id);
  const { id, claim_token } = created.body as { id: string; claim_token: string };

  // Pinned current behavior: the claim SELECT runs under the caller's RLS
  // context, so a leaked token alone is not enough — the claimer must also
  // be a member of the device's account. Outsiders get device_not_found.
  const r = await claimDevice(app, outsider, claim_token, 'stolen-key');
  assertEquals(r.status, 404);
  assertEquals((r.body as { error: string }).error, 'device_not_found');
  const row = await deviceRow(id);
  assertEquals(row.status, 'unpaired');
  assertEquals(row.public_key, null);

  // The rightful admin can still claim afterwards.
  assertEquals((await claimDevice(app, u, claim_token)).status, 200);
});
