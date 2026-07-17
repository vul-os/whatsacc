import { assert, assertEquals, assertFalse } from '../helpers/assert.ts';
import { isValidPeriodKey, nextPayoutDate, previousPeriodKey } from '@/lib/payout-period.ts';

test('previousPeriodKey: closes the prior calendar month', () => {
  assertEquals(previousPeriodKey(new Date(Date.UTC(2026, 5, 1))), '2026-05');  // Jun -> May
  assertEquals(previousPeriodKey(new Date(Date.UTC(2026, 0, 1))), '2025-12');  // Jan -> prev Dec
  assertEquals(previousPeriodKey(new Date(Date.UTC(2026, 5, 17))), '2026-05'); // mid-Jun -> May
});

test('previousPeriodKey: zero-pads single-digit months', () => {
  assertEquals(previousPeriodKey(new Date(Date.UTC(2026, 1, 1))), '2026-01'); // Feb -> Jan
  assertEquals(previousPeriodKey(new Date(Date.UTC(2026, 9, 1))), '2026-09'); // Oct -> Sep
});

test('nextPayoutDate: first of next month at 00:00 UTC', () => {
  const d = nextPayoutDate(new Date(Date.UTC(2026, 4, 15)));
  assertEquals(d.toISOString(), '2026-06-01T00:00:00.000Z');
});

test('isValidPeriodKey: format gate', () => {
  assert(isValidPeriodKey('2026-05'));
  assert(isValidPeriodKey('2026-12'));
  assertFalse(isValidPeriodKey('2026-13'));
  assertFalse(isValidPeriodKey('2026-00'));
  assertFalse(isValidPeriodKey('26-05'));
  assertFalse(isValidPeriodKey('2026/05'));
});
