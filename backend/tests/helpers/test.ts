// Wrapper around Deno.test that skips the suite cleanly when no test DB is
// configured, and disables resource sanitisation (the postgres pool stays open
// across tests, which is fine for our setup).

import { resolveTestDatabaseUrl } from './db.ts';

const SKIP = resolveTestDatabaseUrl() === null;

export const dbAvailable = !SKIP;

export function dbTest(name: string, fn: () => Promise<void>): void {
  Deno.test({
    name,
    ignore: SKIP,
    sanitizeResources: false,
    sanitizeOps: false,
    fn,
  });
}
