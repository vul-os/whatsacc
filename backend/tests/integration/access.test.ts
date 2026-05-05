import { assert, assertEquals, assertExists } from '@std/assert';
import { bootTestApp } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { registerUser, seedLocationWithAccessPoint } from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';

dbTest('opening a gate logs an access record and advances the wear meter', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, {
    withAccessPoint: true,
    gateMovementMperOp: 4,
  });
  const apId = seeded.access_point_id!;

  // Initial state: meter at 0 (or null), zero opens.
  const initial = await app.request('GET', `/access/access-points/${apId}`, {
    token: u.access_token,
  });
  assertEquals(initial.status, 200);
  const before = initial.body as { meter: { movement_m: number; total_opens: number } };
  assertEquals(before.meter.total_opens, 0);
  assertEquals(before.meter.movement_m, 0);

  // Open three times; each open should add 4 m of movement.
  for (let i = 0; i < 3; i++) {
    const op = await app.request('POST', `/access/access-points/${apId}/open`, {
      token: u.access_token,
      json: { source: 'web' },
    });
    assertEquals(op.status, 200);
  }

  const after = await app.request('GET', `/access/access-points/${apId}`, {
    token: u.access_token,
  });
  const meterBody = after.body as {
    meter: { movement_m: number; total_opens: number; total_closes: number };
  };
  assertEquals(meterBody.meter.total_opens, 3);
  assertEquals(meterBody.meter.movement_m, 12); // 3 × 4 m
});

dbTest('logging a service event resets the wear baseline + sets next-due', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, {
    withAccessPoint: true,
    gateMovementMperOp: 5,
  });
  const apId = seeded.access_point_id!;

  for (let i = 0; i < 4; i++) {
    await app.request('POST', `/access/access-points/${apId}/open`, {
      token: u.access_token,
      json: { source: 'web' },
    });
  }

  const ev = await app.request('POST', `/access/access-points/${apId}/maintenance`, {
    token: u.access_token,
    json: {
      kind: 'service',
      technician_name: 'Themba',
      next_due_in_days: 180,
      next_due_movement_m: 100,
    },
  });
  assertEquals(ev.status, 201);
  const evBody = ev.body as { id: string; movement_m_at_event: number };
  assertExists(evBody.id);
  assertEquals(evBody.movement_m_at_event, 20); // 4 × 5

  const after = await app.request('GET', `/access/access-points/${apId}`, {
    token: u.access_token,
  });
  const apBody = after.body as {
    maintenance: {
      last_serviced_at: string | null;
      last_service_movement_m: number | null;
      next_due_movement_m: number | null;
      next_due_at: string | null;
      due_now: boolean;
    };
  };
  assert(apBody.maintenance.last_serviced_at !== null);
  assertEquals(apBody.maintenance.last_service_movement_m, 20);
  assertEquals(apBody.maintenance.next_due_movement_m, 100);
  assert(apBody.maintenance.next_due_at !== null);
  assertEquals(apBody.maintenance.due_now, false);
});

dbTest('inspection events do NOT reset the wear baseline', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, {
    withAccessPoint: true,
    gateMovementMperOp: 5,
  });
  const apId = seeded.access_point_id!;

  await app.request('POST', `/access/access-points/${apId}/open`, {
    token: u.access_token,
    json: { source: 'web' },
  });

  const ev = await app.request('POST', `/access/access-points/${apId}/maintenance`, {
    token: u.access_token,
    json: { kind: 'inspection', notes: 'looks fine' },
  });
  assertEquals(ev.status, 201);

  const after = await app.request('GET', `/access/access-points/${apId}`, {
    token: u.access_token,
  });
  const apBody = after.body as {
    maintenance: { last_serviced_at: string | null; next_due_movement_m: number | null };
  };
  assertEquals(apBody.maintenance.last_serviced_at, null);
  assertEquals(apBody.maintenance.next_due_movement_m, null);
});

dbTest('maintenance events list returns most recent first', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
  const apId = seeded.access_point_id!;

  for (const kind of ['inspection', 'service', 'inspection']) {
    const r = await app.request('POST', `/access/access-points/${apId}/maintenance`, {
      token: u.access_token,
      json: { kind, next_due_in_days: kind === 'service' ? 180 : undefined },
    });
    assertEquals(r.status, 201);
  }

  const list = await app.request('GET', `/access/access-points/${apId}/maintenance`, {
    token: u.access_token,
  });
  assertEquals(list.status, 200);
  const body = list.body as { events: Array<{ kind: string }> };
  assertEquals(body.events.length, 3);
  // Newest first.
  assertEquals(body.events[0]!.kind, 'inspection');
  assertEquals(body.events[2]!.kind, 'inspection');
});
