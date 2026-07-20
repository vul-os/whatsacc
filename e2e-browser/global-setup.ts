// Builds the actual shipped artifact ONCE before any test runs: the frontend
// (vite build) embedded into the real gateway binary via `-tags portal` (see
// gateway/internal/portal/portal.go and gateway/Makefile's `portal` +
// `build-portal` targets). Every test then boots that exact binary — no
// mocked backend, no dev server proxying to a mocked backend.
//
// Why the embedded build and not `vite dev` pointed at the gateway: the
// embedded SPA is what actually ships (the gateway binary embeds it and
// serves it itself; the Tauri desktop shell reuses the same bundle). Testing
// against a separately-run Vite dev server would exercise a topology that
// doesn't exist in production (two origins, HMR-only code paths) and would
// dodge the exact bug class this suite exists to catch: the embedded
// portal's SPA-fallback (any unmatched path -> 200 + index.html) only
// matters when the frontend and the gateway are actually the same origin,
// which `-tags portal` is the only way to reproduce faithfully.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// package.json has "type": "module", so this file runs as ESM — no
// __dirname. Derive it the same way vite.config.ts does.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GATEWAY_DIR = path.join(ROOT, 'gateway');
const EMBED_DIR = path.join(GATEWAY_DIR, 'internal', 'portal', 'dist');

export default async function globalSetup(): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lintel-e2e-build-'));
  const frontendDist = path.join(scratch, 'frontend-dist');

  console.log('[e2e-browser] building the frontend (vite build) ->', frontendDist);
  execFileSync(
    'npx',
    ['vite', 'build', '--outDir', frontendDist, '--emptyOutDir'],
    { cwd: ROOT, stdio: 'inherit' },
  );

  // Populate the embed seam the same way `make portal` does, but into the
  // real gateway/internal/portal/dist path — go:embed requires the directory
  // to live inside the module, there's no way to point it elsewhere without
  // editing gateway source (out of scope). This path is gitignored (matches
  // the repo's blanket `dist` rule) so it's disposable build output, exactly
  // like the top-level dist/ this repo already regenerates routinely.
  fs.rmSync(EMBED_DIR, { recursive: true, force: true });
  fs.cpSync(frontendDist, EMBED_DIR, { recursive: true });

  const binPath = path.join(scratch, process.platform === 'win32' ? 'gateway-e2e.exe' : 'gateway-e2e');
  console.log('[e2e-browser] building the gateway (-tags portal) ->', binPath);
  // `-a` forces a full rebuild, bypassing Go's build cache entirely. This is
  // not paranoia: a bare (non -a) `-tags portal` build was observed, on this
  // exact repo, to silently link in a STALE cached binary that served an old
  // placeholder page (from before the product's whatsacc->lintel rename)
  // even though gateway/internal/portal/dist on disk had genuinely fresh
  // content matching the current build. That's exactly the class of
  // silent-wrong-artifact failure this whole suite exists to catch, so the
  // ~15s extra cost here is non-negotiable — never trust the cache for the
  // binary under test.
  execFileSync(
    'go',
    ['build', '-a', '-tags', 'portal', '-o', binPath, './cmd/gateway'],
    { cwd: GATEWAY_DIR, stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0' } },
  );

  // Workers are spawned (as child processes) after globalSetup returns, and
  // inherit process.env as it stands at that point — this is the documented
  // way to hand data from Playwright's globalSetup to test workers.
  process.env.LINTEL_E2E_GATEWAY_BIN = binPath;
  process.env.LINTEL_E2E_BUILD_SCRATCH = scratch;
}
