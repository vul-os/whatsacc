// Helpers for contract tests against real third-party services.
// Each contract test is skipped unless its required env var is set.

import { test } from 'vitest';

export type ContractEnv =
  | 'RESEND_TEST_API_KEY'
  | 'RESEND_TEST_TO_EMAIL';

export function envValue(name: ContractEnv): string | null {
  const v = (process.env[name] ?? '').trim();
  return v || null;
}

export function contractTest(
  name: string,
  required: ContractEnv[],
  fn: () => Promise<void>,
): void {
  const missing = required.filter((k) => !envValue(k));
  const title = missing.length ? `${name} [SKIP - missing ${missing.join(', ')}]` : name;
  const runner = missing.length ? test.skip : test;
  runner(title, fn);
}
