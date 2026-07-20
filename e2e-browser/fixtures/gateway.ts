// Boots a REAL gateway binary (the one built by ../global-setup.ts with
// `-tags portal`, so it serves the actual React SPA the same way the shipped
// product does) on a scratch SQLite data dir and a free port. No mocks: every
// request a test makes goes over real HTTP into the real Go process.
//
// One gateway per spec FILE (not per test, not a single shared instance) —
// call `startGateway()` in `test.beforeAll` and `stop()` in `test.afterAll`.
// Playwright fixtures only offer 'test' or 'worker' scope, neither of which
// cleanly maps to "once per file", so this is deliberately a plain helper
// rather than a fixture.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export type LiveGateway = {
  /** e.g. http://127.0.0.1:54321 — no trailing slash. */
  baseUrl: string;
  /** Convenience: baseUrl + path. */
  url: (pathname: string) => string;
  dataDir: string;
  /** Passed to `-admin-claim-token`; POST /v1/admin/claim redeems it once. */
  adminClaimToken: string;
  /** Kills the process (SIGTERM, then SIGKILL after a grace period) and
   * removes the scratch data dir. Safe to call more than once. */
  stop: () => Promise<void>;
};

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : null;
      srv.close(() => {
        if (port) resolve(port);
        else reject(new Error('could not determine a free port'));
      });
    });
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        if (body?.ok) return;
        lastErr = new Error(`unexpected /health body: ${JSON.stringify(body)}`);
      } else {
        lastErr = new Error(`/health responded ${res.status}`);
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`gateway never became healthy at ${url}: ${String(lastErr)}`);
}

/**
 * Spawn a fresh gateway process on an isolated scratch data dir + free port.
 * `label` only affects the temp dir name / claim token prefix — pick
 * something identifying the spec file (e.g. "money-path").
 */
export async function startGateway(label: string): Promise<LiveGateway> {
  const bin = process.env.LINTEL_E2E_GATEWAY_BIN;
  if (!bin || !fs.existsSync(bin)) {
    throw new Error(
      'LINTEL_E2E_GATEWAY_BIN is not set (or points at a missing file) — ' +
        'e2e-browser/global-setup.ts did not run, or failed to build the gateway ' +
        'binary. Run the suite via `npm run test:e2e`, not `npx playwright test` ' +
        'with a config that skips globalSetup.',
    );
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `lintel-e2e-${label}-`));
  const port = await getFreePort();
  const adminClaimToken = `e2e-claim-${label}-${Math.random().toString(36).slice(2, 10)}`;

  const proc: ChildProcessWithoutNullStreams = spawn(
    bin,
    ['-data', dataDir, '-listen', `127.0.0.1:${port}`, '-admin-claim-token', adminClaimToken],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let log = '';
  proc.stdout.on('data', (d: Buffer) => (log += d.toString()));
  proc.stderr.on('data', (d: Buffer) => (log += d.toString()));
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(`${baseUrl}/health`, 20_000);
  } catch (err) {
    if (!exited) proc.kill('SIGKILL');
    throw new Error(
      `${(err as Error).message}\n--- gateway[${label}] stdout/stderr ---\n${log || '(empty)'}`,
    );
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (!exited) {
      await new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!exited) proc.kill('SIGKILL');
        }, 3_000).unref();
      });
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  return { baseUrl, url: (p: string) => `${baseUrl}${p}`, dataDir, adminClaimToken, stop };
}
