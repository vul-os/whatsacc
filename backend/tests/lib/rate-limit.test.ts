// Unit tests for the pure parts of the rate-limit system: fixed-window
// math, cooldown calculation, and env config parsing. No DB required.

import { test, expect } from 'vitest';
import {
  DAY_S,
  HOUR_S,
  MINUTE_S,
  RATE_LIMIT_DEFAULTS,
  cooldownRemainingS,
  fixedWindowStart,
  parseRateLimitConfig,
  parseRateLimitValue,
  secondsUntilWindowEnd,
  chatDenialMessage,
} from '@/lib/rate-limit.ts';

test('fixedWindowStart floors to UTC epoch-aligned windows', () => {
  const t = new Date('2026-07-17T13:47:23.456Z');
  expect(fixedWindowStart(t, HOUR_S).toISOString()).toBe('2026-07-17T13:00:00.000Z');
  expect(fixedWindowStart(t, MINUTE_S).toISOString()).toBe('2026-07-17T13:47:00.000Z');
  expect(fixedWindowStart(t, DAY_S).toISOString()).toBe('2026-07-17T00:00:00.000Z');
  // Exactly on a boundary stays on the boundary.
  const boundary = new Date('2026-07-17T13:00:00.000Z');
  expect(fixedWindowStart(boundary, HOUR_S).toISOString()).toBe('2026-07-17T13:00:00.000Z');
});

test('secondsUntilWindowEnd counts down to the rollover and never returns 0', () => {
  const t = new Date('2026-07-17T13:59:30.000Z');
  expect(secondsUntilWindowEnd(t, HOUR_S)).toBe(30);
  expect(secondsUntilWindowEnd(t, MINUTE_S)).toBe(30);
  // 1ms before rollover still reports at least 1 second.
  const edge = new Date('2026-07-17T13:59:59.999Z');
  expect(secondsUntilWindowEnd(edge, HOUR_S)).toBe(1);
  // Exactly at a boundary: full window remains.
  const boundary = new Date('2026-07-17T13:00:00.000Z');
  expect(secondsUntilWindowEnd(boundary, HOUR_S)).toBe(HOUR_S);
});

test('cooldownRemainingS is sliding (not window-aligned) and rounds up', () => {
  const last = new Date('2026-07-17T13:00:00.000Z');
  expect(cooldownRemainingS(last, new Date('2026-07-17T13:00:03.000Z'), 10)).toBe(7);
  expect(cooldownRemainingS(last, new Date('2026-07-17T13:00:09.100Z'), 10)).toBe(1);
  expect(cooldownRemainingS(last, new Date('2026-07-17T13:00:10.000Z'), 10)).toBe(0);
  expect(cooldownRemainingS(last, new Date('2026-07-17T13:05:00.000Z'), 10)).toBe(0);
});

test('parseRateLimitValue: valid ints pass, 0 is explicit, junk falls back', () => {
  expect(parseRateLimitValue('15', 10)).toBe(15);
  expect(parseRateLimitValue('0', 10)).toBe(0); // explicit disable/kill-switch
  expect(parseRateLimitValue(undefined, 10)).toBe(10);
  expect(parseRateLimitValue('', 10)).toBe(10);
  expect(parseRateLimitValue('  ', 10)).toBe(10);
  expect(parseRateLimitValue('-5', 10)).toBe(10);
  expect(parseRateLimitValue('3.5', 10)).toBe(10);
  expect(parseRateLimitValue('lots', 10)).toBe(10);
});

test('parseRateLimitConfig applies documented defaults (10s / 30h / 10m / 500h)', () => {
  expect(parseRateLimitConfig({})).toEqual(RATE_LIMIT_DEFAULTS);
  expect(RATE_LIMIT_DEFAULTS).toEqual({
    openCooldownS: 10,
    opensPerHour: 30,
    chatMsgsPerMin: 10,
    accountOpensPerHour: 500,
  });
  expect(
    parseRateLimitConfig({
      RATE_OPEN_COOLDOWN_S: '5',
      RATE_OPENS_PER_HOUR: '60',
      RATE_CHAT_MSGS_PER_MIN: 'bogus',
      RATE_ACCOUNT_OPENS_PER_HOUR: '1000',
    }),
  ).toEqual({ openCooldownS: 5, opensPerHour: 60, chatMsgsPerMin: 10, accountOpensPerHour: 1000 });
});

test('chatDenialMessage renders honest, distinct copy per reason', async () => {
  // chatDenialMessage reads APP_PUBLIC_URL through getEnv(), which requires
  // the base env vars — provide inert values for the no-DB unit run.
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused.invalid/unused';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
  process.env.APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || 'http://test.local';
  const { resetEnvCache } = await import('@/lib/env.ts');
  resetEnvCache();
  const rate = chatDenialMessage({ reason: 'rate_limited', retry_after_s: 90 });
  expect(rate).toContain('Too many opens');
  expect(rate).toContain('~2 min');
  const rateShort = chatDenialMessage({ reason: 'rate_limited', retry_after_s: 5 });
  expect(rateShort).toContain('~1 min'); // never "~0 min"
  const quota = chatDenialMessage({ reason: 'quota_exceeded', retry_after_s: 3600 });
  expect(quota).toContain('Daily limit reached');
  expect(quota).toContain('contact your admin');
  expect(quota).toContain('/app');
});
