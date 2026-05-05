import { assert, assertEquals } from '@std/assert';
import { bootTestApp } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { dbTest } from '../helpers/test.ts';

dbTest('GET /reference/countries returns seeded countries with ZA present', async () => {
  await resetData();
  const app = await bootTestApp();
  const r = await app.request('GET', '/reference/countries');
  assertEquals(r.status, 200);
  const body = r.body as {
    countries: Array<{ code: string; name: string; flag: string; currency_code: string; msg_cost_zar: number }>;
  };
  assert(body.countries.length >= 10, `expected seeded countries, got ${body.countries.length}`);
  const za = body.countries.find((c) => c.code === 'ZA');
  assert(za, 'expected ZA in seeded countries');
  assertEquals(za!.currency_code, 'ZAR');
  assert(za!.msg_cost_zar > 0);
});

dbTest('GET /reference/currencies returns currencies with FX rates', async () => {
  await resetData();
  const app = await bootTestApp();
  const r = await app.request('GET', '/reference/currencies');
  assertEquals(r.status, 200);
  const body = r.body as {
    currencies: Array<{ code: string; symbol: string; decimals: number; fx_to_zar: number | null }>;
  };
  const zar = body.currencies.find((c) => c.code === 'ZAR');
  assert(zar, 'expected ZAR currency');
  assertEquals(zar!.fx_to_zar, 1);
  assertEquals(zar!.decimals, 2);
});
