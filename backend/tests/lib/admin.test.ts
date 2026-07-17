// Unit tests for the instance-admin primitives:
//   - constant-time claim-token comparison
//   - rate-limit config resolution order (db override > env > default)
//   - honest chat copy for suspended accounts

import { test } from 'vitest';
import { assert, assertEquals, assertFalse, assertStringIncludes } from '../helpers/assert.ts';
import { timingSafeEqualStr } from '@/lib/admin.ts';
import {
  RATE_LIMIT_DEFAULTS,
  chatDenialMessage,
  mergeRateLimitConfig,
  parseRateLimitConfig,
  parseStoredOverrides,
} from '@/lib/rate-limit.ts';

// ---------------------------------------------------------------------------
// timingSafeEqualStr
// ---------------------------------------------------------------------------

test('claim compare: equal strings match', async () => {
  assert(await timingSafeEqualStr('sekrit-token-123', 'sekrit-token-123'));
  assert(await timingSafeEqualStr('', ''));
  assert(await timingSafeEqualStr('ünïcode-⚡', 'ünïcode-⚡'));
});

test('claim compare: different strings do not match', async () => {
  assertFalse(await timingSafeEqualStr('sekrit-token-123', 'sekrit-token-124'));
  assertFalse(await timingSafeEqualStr('a', 'b'));
  // Differing lengths (naive === compares length first; the digest form must
  // still simply return false).
  assertFalse(await timingSafeEqualStr('short', 'a-much-longer-token-value'));
  assertFalse(await timingSafeEqualStr('', 'x'));
  // Prefix relationship must not match.
  assertFalse(await timingSafeEqualStr('token', 'token-with-suffix'));
});

// ---------------------------------------------------------------------------
// Override parsing (defensive against corrupted settings rows)
// ---------------------------------------------------------------------------

test('overrides: parseStoredOverrides accepts only non-negative integers', () => {
  assertEquals(parseStoredOverrides(null), {});
  assertEquals(parseStoredOverrides(undefined), {});
  assertEquals(parseStoredOverrides('garbage'), {});
  assertEquals(parseStoredOverrides([1, 2, 3]), {});
  assertEquals(parseStoredOverrides({}), {});
  assertEquals(
    parseStoredOverrides({ opens_per_hour: 1, open_cooldown_s: 0 }),
    { opens_per_hour: 1, open_cooldown_s: 0 },
  );
  // Negatives, floats, strings, unknown keys: dropped.
  assertEquals(
    parseStoredOverrides({
      opens_per_hour: -1,
      open_cooldown_s: 2.5,
      chat_msgs_per_min: '7',
      totally_unknown: 9,
      account_opens_per_hour: 200,
    }),
    { account_opens_per_hour: 200 },
  );
});

// ---------------------------------------------------------------------------
// Resolution order: db override > env > default
// ---------------------------------------------------------------------------

test('resolution: built-in defaults when neither env nor db set', () => {
  const envCfg = parseRateLimitConfig({});
  assertEquals(envCfg, RATE_LIMIT_DEFAULTS);
  assertEquals(mergeRateLimitConfig(envCfg, {}), RATE_LIMIT_DEFAULTS);
});

test('resolution: env beats default; db beats env; db 0 is a valid override', () => {
  const envCfg = parseRateLimitConfig({
    RATE_OPENS_PER_HOUR: '50',
    RATE_OPEN_COOLDOWN_S: '20',
  });
  // env > default
  assertEquals(envCfg.opensPerHour, 50);
  assertEquals(envCfg.openCooldownS, 20);
  assertEquals(envCfg.chatMsgsPerMin, RATE_LIMIT_DEFAULTS.chatMsgsPerMin);

  // db > env (and db 0 counts — kill switch / disabled cooldown)
  const merged = mergeRateLimitConfig(envCfg, { opens_per_hour: 5, open_cooldown_s: 0 });
  assertEquals(merged.opensPerHour, 5);
  assertEquals(merged.openCooldownS, 0);
  // fields without a db override keep the env/default value
  assertEquals(merged.chatMsgsPerMin, RATE_LIMIT_DEFAULTS.chatMsgsPerMin);
  assertEquals(merged.accountOpensPerHour, RATE_LIMIT_DEFAULTS.accountOpensPerHour);
});

test('resolution: merge never mutates the base config', () => {
  const envCfg = parseRateLimitConfig({});
  mergeRateLimitConfig(envCfg, { opens_per_hour: 1 });
  assertEquals(envCfg.opensPerHour, RATE_LIMIT_DEFAULTS.opensPerHour);
});

// ---------------------------------------------------------------------------
// Suspension chat copy
// ---------------------------------------------------------------------------

test('chat copy: account_suspended reply is honest and actionable', () => {
  const msg = chatDenialMessage({ reason: 'account_suspended', retry_after_s: 0 });
  assertStringIncludes(msg.toLowerCase(), 'suspended');
  assertStringIncludes(msg.toLowerCase(), 'operator');
});
