import { assertEquals } from '../helpers/assert.ts';
import { bootTestApp } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { registerUser, seedLocationWithAccessPoint } from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';

dbTest('analytics: location summary counts opens vs closes', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
  const locId = seeded.location_id;
  const apId = seeded.access_point_id!;

  // 3 opens, 1 close
  for (let i = 0; i < 3; i++) {
    await app.request('POST', `/access/access-points/${apId}/open`, {
      token: u.access_token,
      json: { source: 'web' },
    });
  }
  await app.request('POST', `/access/access-points/${apId}/close`, {
    token: u.access_token,
    json: { source: 'web' },
  });

  const summary = await app.request('GET', `/analytics/locations/${locId}/summary`, {
    token: u.access_token,
  });
  assertEquals(summary.status, 200);
  const body = summary.body as { opens: number; closes: number; total: number; location_id: string };
  assertEquals(body.opens, 3);
  assertEquals(body.closes, 1);
  assertEquals(body.total, 4);
  assertEquals(body.location_id, locId);
});

dbTest('analytics requires authentication', async () => {
  await resetData();
  const app = await bootTestApp();
  const r = await app.request('GET', '/analytics/locations/00000000-0000-0000-0000-000000000000/summary');
  assertEquals(r.status, 401);
});
