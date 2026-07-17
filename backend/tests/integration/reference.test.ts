import { assert, assertEquals } from '../helpers/assert.ts';
import { bootTestApp } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { dbTest } from '../helpers/test.ts';

dbTest('GET /reference/countries returns seeded countries with ZA present', async () => {
  await resetData();
  const app = await bootTestApp();
  const r = await app.request('GET', '/reference/countries');
  assertEquals(r.status, 200);
  const body = r.body as {
    countries: Array<{ code: string; name: string; flag: string }>;
  };
  assert(body.countries.length >= 10, `expected seeded countries, got ${body.countries.length}`);
  const za = body.countries.find((c) => c.code === 'ZA');
  assert(za, 'expected ZA in seeded countries');
  assertEquals(za!.name, 'South Africa');
});
