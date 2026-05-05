import { assert, assertEquals, assertExists } from '@std/assert';
import { tryConsumeGrant } from '@/routes/access.ts';
import { withRLS } from '@/lib/db.ts';
import { bootTestApp } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { registerUser, seedLocationWithAccessPoint } from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';

const PHONE = '+27821234567';

dbTest('grants: admin can create a grant covering one access point', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

  const ends = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const r = await app.request('POST', '/access/grants', {
    token: u.access_token,
    json: {
      phone_e164: PHONE,
      visitor_name: 'Themba (electrician)',
      ends_at: ends,
      max_uses: 5,
      access_point_ids: [seeded.access_point_id!],
    },
  });
  assertEquals(r.status, 201);
  const body = r.body as {
    id: string;
    effective_status: string;
    access_point_ids: string[];
    uses_count: number;
  };
  assertExists(body.id);
  assertEquals(body.effective_status, 'active');
  assertEquals(body.access_point_ids.length, 1);
  assertEquals(body.uses_count, 0);
});

dbTest('grants: ends_at must be after starts_at', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

  const r = await app.request('POST', '/access/grants', {
    token: u.access_token,
    json: {
      phone_e164: PHONE,
      starts_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ends_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      access_point_ids: [seeded.access_point_id!],
    },
  });
  assertEquals(r.status, 400);
});

dbTest('grants: phone must be E.164', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

  const r = await app.request('POST', '/access/grants', {
    token: u.access_token,
    json: {
      phone_e164: '0821234567', // missing +country
      ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      access_point_ids: [seeded.access_point_id!],
    },
  });
  assertEquals(r.status, 400);
});

dbTest('grants: cannot mix access points from different accounts', async () => {
  await resetData();
  const app = await bootTestApp();
  const a = await registerUser(app);
  const b = await registerUser(app);
  const sa = await seedLocationWithAccessPoint(a.account_id, { withAccessPoint: true });
  const sb = await seedLocationWithAccessPoint(b.account_id, { withAccessPoint: true });

  const r = await app.request('POST', '/access/grants', {
    token: a.access_token,
    json: {
      phone_e164: PHONE,
      ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      access_point_ids: [sa.access_point_id!, sb.access_point_id!],
    },
  });
  // RLS hides B's access point from A's session, so the lookup returns one
  // row instead of two and we surface that as not-found.
  assert(r.status === 404 || r.status === 400, `expected 4xx, got ${r.status}`);
});

dbTest('grants: list shows account grants and revoke flips effective_status', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

  const create = await app.request('POST', '/access/grants', {
    token: u.access_token,
    json: {
      phone_e164: PHONE,
      ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      access_point_ids: [seeded.access_point_id!],
    },
  });
  const grantId = (create.body as { id: string }).id;

  const list = await app.request('GET', '/access/grants', { token: u.access_token });
  assertEquals(list.status, 200);
  const lb = list.body as { grants: { id: string; effective_status: string }[] };
  assertEquals(lb.grants.length, 1);
  assertEquals(lb.grants[0]!.effective_status, 'active');

  const revoke = await app.request('POST', `/access/grants/${grantId}/revoke`, {
    token: u.access_token,
  });
  assertEquals(revoke.status, 200);
  assertEquals((revoke.body as { effective_status: string }).effective_status, 'revoked');

  // Already revoked → second call returns 404 (not revocable).
  const revoke2 = await app.request('POST', `/access/grants/${grantId}/revoke`, {
    token: u.access_token,
  });
  assertEquals(revoke2.status, 404);
});

dbTest('grants: cross-tenant — user B cannot see or revoke user A\'s grants', async () => {
  await resetData();
  const app = await bootTestApp();
  const a = await registerUser(app);
  const b = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(a.account_id, { withAccessPoint: true });

  const create = await app.request('POST', '/access/grants', {
    token: a.access_token,
    json: {
      phone_e164: PHONE,
      ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      access_point_ids: [seeded.access_point_id!],
    },
  });
  const grantId = (create.body as { id: string }).id;

  const listAsB = await app.request('GET', '/access/grants', { token: b.access_token });
  assertEquals(listAsB.status, 200);
  assertEquals((listAsB.body as { grants: unknown[] }).grants.length, 0);

  const getAsB = await app.request('GET', `/access/grants/${grantId}`, { token: b.access_token });
  assertEquals(getAsB.status, 404);

  const revokeAsB = await app.request('POST', `/access/grants/${grantId}/revoke`, {
    token: b.access_token,
  });
  assertEquals(revokeAsB.status, 404);
});

dbTest('grants: tryConsumeGrant returns the grant id and increments uses atomically', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

  await app.request('POST', '/access/grants', {
    token: u.access_token,
    json: {
      phone_e164: PHONE,
      ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      max_uses: 2,
      access_point_ids: [seeded.access_point_id!],
    },
  });

  const first = await tryConsumeGrant(PHONE, seeded.access_point_id!);
  assertExists(first);
  const second = await tryConsumeGrant(PHONE, seeded.access_point_id!);
  assertExists(second);
  assertEquals(first, second, 'same grant should be re-used until exhausted');

  // Third call exhausted.
  const third = await tryConsumeGrant(PHONE, seeded.access_point_id!);
  assertEquals(third, null);

  // Underlying counter actually moved.
  const rows = await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) =>
      await tx<{ uses_count: number }[]>`
        select uses_count from temporary_access_grants where id = ${first!}
      `,
  );
  assertEquals(rows[0]!.uses_count, 2);
});

dbTest('grants: tryConsumeGrant rejects pending (before starts_at) and expired (after ends_at)', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

  // Future window
  const future = await app.request('POST', '/access/grants', {
    token: u.access_token,
    json: {
      phone_e164: PHONE,
      starts_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ends_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      access_point_ids: [seeded.access_point_id!],
    },
  });
  assertEquals(future.status, 201);
  assertEquals(await tryConsumeGrant(PHONE, seeded.access_point_id!), null);

  // Make the grant retroactively expired by rewinding ends_at.
  await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      await tx`
        update temporary_access_grants
        set starts_at = now() - interval '2 hours',
            ends_at   = now() - interval '1 hour'
        where phone_e164 = ${PHONE}
      `;
    },
  );
  assertEquals(await tryConsumeGrant(PHONE, seeded.access_point_id!), null);
});

dbTest('grants: tryConsumeGrant rejects revoked grants and grants for other access points', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const ap1 = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
  const ap2 = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

  const r = await app.request('POST', '/access/grants', {
    token: u.access_token,
    json: {
      phone_e164: PHONE,
      ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      access_point_ids: [ap1.access_point_id!],
    },
  });
  const grantId = (r.body as { id: string }).id;

  // Wrong access point → null.
  assertEquals(await tryConsumeGrant(PHONE, ap2.access_point_id!), null);

  // Correct access point → ok.
  assertExists(await tryConsumeGrant(PHONE, ap1.access_point_id!));

  // Revoke, then no further consumption.
  await app.request('POST', `/access/grants/${grantId}/revoke`, { token: u.access_token });
  assertEquals(await tryConsumeGrant(PHONE, ap1.access_point_id!), null);
});

dbTest('grants: only account admins can create (not random outsiders)', async () => {
  await resetData();
  const app = await bootTestApp();
  const owner = await registerUser(app);
  const outsider = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(owner.account_id, { withAccessPoint: true });

  const r = await app.request('POST', '/access/grants', {
    token: outsider.access_token,
    json: {
      phone_e164: PHONE,
      ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      access_point_ids: [seeded.access_point_id!],
    },
  });
  // Outsider's RLS hides the access point entirely → not_found.
  assert(r.status === 403 || r.status === 404, `got ${r.status}`);
});
