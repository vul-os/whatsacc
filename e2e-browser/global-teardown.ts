// Removes the scratch build directory created by global-setup.ts (the built
// gateway binary + the intermediate frontend build). Per-test scratch data
// dirs are each spec file's own responsibility (fixtures/gateway.ts's
// `stop()`, called from every spec's `test.afterAll`) — this is just the
// one-time build output.
import fs from 'node:fs';

export default async function globalTeardown(): Promise<void> {
  const scratch = process.env.LINTEL_E2E_BUILD_SCRATCH;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
}
