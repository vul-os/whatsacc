import { test } from 'vitest';

import { resolveTestDatabaseUrl } from './db.ts';

const SKIP = resolveTestDatabaseUrl() === null;

export const dbAvailable = !SKIP;

export function dbTest(name: string, fn: () => Promise<void>, timeoutMs?: number): void {
  const runner = SKIP ? test.skip : test;
  runner(name, fn, timeoutMs);
}
