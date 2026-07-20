#!/usr/bin/env node
// Automated product screenshot generator.
//
// Usage:  npm run screenshotter
//
// Boots the existing Vite app on a free port, intercepts every backend API
// request with Playwright route mocks (fixtures in scripts/screenshotter-fixtures/),
// seeds an authenticated session, and captures polished PNGs into:
//   site/screenshots/         (light)
//   site/screenshots/dark/    (dark)
//
// No backend (Deno, port 8787/8000) is required. Exits non-zero on any failure.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'screenshotter-fixtures');
const OUT_LIGHT = path.join(ROOT, 'site', 'screenshots');
const OUT_DARK = path.join(OUT_LIGHT, 'dark');
const MIN_BYTES = 30_000; // a real 2x/3x product shot is far bigger than this

// The app ships a real dark theme (src/lib/theme.tsx toggles :root[data-theme]);
// both schemes are captured natively. If the theme is ever removed, flip the flag
// below and light shots get copied into dark/ so references never 404.
const APP_HAS_DARK_MODE = true; // real dark theme via :root[data-theme] (src/lib/theme.tsx)

// ---------------------------------------------------------------------------
// Fixtures: load JSON and substitute {{now±Nu}} tokens (u in s|m|h|d) with
// timestamps relative to run time, so "5 min ago" style UI always looks
// fresh. api.ts's UnixSeconds type doc comment is the source of truth here:
// almost every gateway timestamp is Unix *seconds* (a bare number), not an
// ISO string — the two exceptions (LocationLimits.usage.day_start and
// LocationSummary.today.day_start) are formatted server-side via Go's
// time.RFC3339 and stay actual ISO strings. Getting this wrong renders as
// "Invalid Date" in the portal (fromUnix() on a non-numeric value), not a
// silent fallback, so the token form matters:
//   "{{now-4m}}"        quoted, no suffix -> bare UnixSeconds number (quotes swallowed)
//   "{{now-13d:date}}"  quoted           -> "YYYY-MM-DD" (e.g. AccountInsights.days[].day)
//   "{{now-9h:iso}}"    quoted           -> full ISO string (the day_start exceptions)
// ---------------------------------------------------------------------------
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function loadFixture(name) {
  const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  const substituted = raw
    .replace(/"\{\{now([+-]\d+)([smhd])\}\}"/g, (_, amount, unit) => {
      const ms = Date.now() + Number(amount) * UNIT_MS[unit];
      return String(Math.round(ms / 1000));
    })
    .replace(/\{\{now([+-]\d+)([smhd]):date\}\}/g, (_, amount, unit) =>
      new Date(Date.now() + Number(amount) * UNIT_MS[unit]).toISOString().slice(0, 10),
    )
    .replace(/\{\{now([+-]\d+)([smhd]):iso\}\}/g, (_, amount, unit) =>
      new Date(Date.now() + Number(amount) * UNIT_MS[unit]).toISOString(),
    );
  return substituted;
}

// ---------------------------------------------------------------------------
// Mock API: method + pathname regex -> fixture body
// ---------------------------------------------------------------------------
function buildMockRoutes({ admin = false } = {}) {
  return [
    // The admin context serves a /me with is_platform_admin=true so the
    // "Instance admin" nav item + /app/admin console render.
    { method: 'GET', re: /^\/auth\/me$/, body: () => loadFixture(admin ? 'me-admin.json' : 'me.json') },
    {
      method: 'POST',
      re: /^\/auth\/refresh$/,
      body: () =>
        JSON.stringify({
          access_token: 'screenshotter-access-token',
          refresh_token: 'screenshotter-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
    },
    { method: 'GET', re: /^\/analytics\/accounts\/[^/]+\/summary$/, body: () => loadFixture('summary.json') },
    { method: 'GET', re: /^\/analytics\/accounts\/[^/]+\/insights$/, body: () => loadFixture('insights.json') },
    // Per-location usage-vs-quota summary. Only Silver Oaks has caps set; the
    // handler nulls the caps for every other location id (pick transform) so
    // the dashboard quota chip shows exactly one entry.
    { method: 'GET', re: /^\/analytics\/locations\/[^/]+\/summary$/, body: () => loadFixture('location-summary.json'), pick: 'location-summary' },
    { method: 'GET', re: /^\/locations\/[^/]+\/limits$/, body: () => loadFixture('limits.json') },
    {
      method: 'PATCH',
      re: /^\/locations\/[^/]+\/limits$/,
      body: () =>
        JSON.stringify({
          location_id: 'loc_silveroaks',
          quotas: { max_opens_per_member_per_day: 30, max_opens_per_location_per_day: 50 },
        }),
    },
    { method: 'GET', re: /^\/accounts\/[^/]+\/locations$/, body: () => loadFixture('locations.json') },
    { method: 'GET', re: /^\/accounts\/[^/]+\/members$/, body: () => loadFixture('members.json') },
    { method: 'GET', re: /^\/access-points$/, body: () => loadFixture('access-points.json') },
    { method: 'GET', re: /^\/access-points\/[^/]+$/, body: () => loadFixture('access-points.json'), pick: 'first-access-point' },
    { method: 'GET', re: /^\/access-points\/[^/]+\/maintenance$/, body: () => loadFixture('maintenance.json') },
    { method: 'GET', re: /^\/grants(\?.*)?$/, body: () => loadFixture('grants.json') },
    { method: 'GET', re: /^\/reference\/countries$/, body: () => JSON.stringify({ countries: [
      { code: 'ZA', name: 'South Africa', flag: '\u{1F1FF}\u{1F1E6}' },
    ] }) },
    // Instance-admin console (operator-only; the admin context's me fixture
    // carries is_platform_admin=true so the route guard lets these render).
    { method: 'GET', re: /^\/admin\/claim$/, body: () => JSON.stringify({ claimed: true, claimable: false }) },
    { method: 'GET', re: /^\/admin\/overview$/, body: () => loadFixture('admin-overview.json') },
    { method: 'GET', re: /^\/admin\/accounts$/, body: () => loadFixture('admin-accounts.json') },
    { method: 'GET', re: /^\/admin\/accounts\/[^/]+$/, body: () => loadFixture('admin-account-detail.json') },
    { method: 'GET', re: /^\/admin\/users$/, body: () => loadFixture('admin-users.json') },
    { method: 'GET', re: /^\/admin\/limits$/, body: () => loadFixture('admin-limits.json') },
    { method: 'GET', re: /^\/admin\/audit$/, body: () => loadFixture('admin-audit.json') },
    { method: 'GET', re: /^\/admin\/audit\/actions$/, body: () => loadFixture('admin-audit-actions.json') },
  ];
}

// Every gateway route lives under /v1 (see src/lib/api.ts's API_VERSION_PREFIX).
// The route regexes below are written against the un-prefixed path — the /v1
// is stripped before matching, mirroring how apiFetch builds request URLs.
const API_PREFIX_RE = /^\/v1\//;

async function installApiMocks(context, opts = {}) {
  const routes = buildMockRoutes(opts);
  await context.route(
    (url) => API_PREFIX_RE.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const pathname = url.pathname.replace(/^\/v1/, '');
      const pathWithQuery = pathname + url.search;
      const match = routes.find(
        (r) => r.method === req.method() && (r.re.test(pathname) || r.re.test(pathWithQuery)),
      );
      if (!match) {
        console.warn(`  [mock] no fixture for ${req.method()} ${url.pathname} -> 404`);
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'not_found' }),
        });
        return;
      }
      let body = match.body();
      if (match.pick === 'first-access-point') {
        body = JSON.stringify(JSON.parse(body).access_points[0]);
      }
      if (match.pick === 'location-summary') {
        // /analytics/locations/:id/summary → echo the requested id and only
        // keep the quota caps for Silver Oaks so other locations read as
        // "no cap set" (keeps the dashboard chip to a single, real entry).
        const j = JSON.parse(body);
        const id = pathname.split('/')[3];
        j.location_id = id;
        if (id !== 'loc_silveroaks') {
          j.today.opens = 6;
          j.today.max_opens_per_member_per_day = null;
          j.today.max_opens_per_location_per_day = null;
        }
        body = JSON.stringify(j);
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body });
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Vite dev server did not become ready at ${url} within ${timeoutMs}ms`);
}

function ensureChromium(chromium) {
  const exe = chromium.executablePath();
  if (exe && fs.existsSync(exe)) return;
  console.log('Chromium for Playwright is not installed yet — downloading it now');
  console.log('(one-time, ~150 MB; equivalent to `npx playwright install chromium`)...');
  const r = spawnSync('npx', ['playwright', 'install', 'chromium'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    throw new Error(
      'Failed to install Chromium. Run `npx playwright install chromium` manually and retry.',
    );
  }
}

const DETERMINISM_CSS = `
  *, *::before, *::after {
    animation-duration: 0.001s !important;
    animation-delay: 0s !important;
    transition-duration: 0.001s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  html { scrollbar-width: none !important; }
  ::-webkit-scrollbar { display: none !important; }
`;

const AUTH_SEED = `
  try {
    localStorage.setItem('lintel.access_token', 'screenshotter-access-token');
    localStorage.setItem('lintel.refresh_token', 'screenshotter-refresh-token');
  } catch {}
`;

async function capture(page, origin, shot, outFile) {
  await page.goto(origin + shot.path, { waitUntil: 'networkidle', timeout: 45_000 });
  await page.evaluate(() => document.fonts.ready);
  // Let framer-motion entrances and layout settle (reducedMotion is emulated,
  // but a few JS-driven animations still tween briefly).
  await page.waitForTimeout(shot.settleMs ?? 900);

  // Guard against error/empty states leaking into marketing assets.
  const bodyText = await page.evaluate(() => document.body.innerText);
  for (const bad of ['Failed to load', 'No account loaded', 'not_found:', 'http_4', 'http_5']) {
    if (bodyText.includes(bad)) {
      throw new Error(`page ${shot.path} shows error state ("${bad}") — fixtures incomplete?`);
    }
  }
  if (shot.expectText && !bodyText.includes(shot.expectText)) {
    throw new Error(`page ${shot.path} is missing expected text "${shot.expectText}"`);
  }

  // Optional: bring a below-the-fold element into view before capturing
  // (viewport screenshots only — fullPage stays false).
  if (shot.scrollTo) {
    await page.locator(shot.scrollTo).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
  }

  await page.addStyleTag({ content: DETERMINISM_CSS });
  await page.screenshot({
    path: outFile,
    animations: 'disabled',
    caret: 'hide',
    fullPage: false,
  });

  const bytes = fs.statSync(outFile).size;
  if (bytes < MIN_BYTES) {
    throw new Error(`screenshot ${path.basename(outFile)} is suspiciously small (${bytes} bytes)`);
  }
  console.log(`  ok ${path.basename(outFile)} (${Math.round(bytes / 1024)} KB)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('playwright is not installed. Run `npm install` first.');
    process.exit(1);
  }
  ensureChromium(chromium);

  fs.mkdirSync(OUT_DARK, { recursive: true });

  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;

  console.log(`Starting Vite dev server on ${origin} ...`);
  const vite = spawn(
    'npm',
    ['run', 'dev', '--', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Point the API client at the app's own origin so route mocks are
        // same-origin (no CORS preflights) and nothing touches a real backend.
        VITE_API_BASE_URL: origin,
        BROWSER: 'none',
        NO_COLOR: '1',
      },
    },
  );
  let viteLog = '';
  vite.stdout.on('data', (d) => (viteLog += d));
  vite.stderr.on('data', (d) => (viteLog += d));

  const killVite = () => {
    if (vite.pid && vite.exitCode === null) {
      try {
        process.kill(-vite.pid, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-vite.pid, 'SIGKILL');
        } catch {}
      }, 2_000).unref();
    }
  };
  process.on('SIGINT', () => {
    killVite();
    process.exit(130);
  });

  let browser;
  try {
    await waitForServer(origin + '/');
    console.log('Vite is ready. Launching Chromium ...');
    browser = await chromium.launch();

    const desktopShots = [
      { path: '/', file: 'landing-hero.png', settleMs: 1_400, expectText: 'lintel' },
      { path: '/docs', file: 'docs.png' },
      { path: '/security', file: 'security.png' },
      { path: '/app', file: 'portal-dashboard.png', expectText: 'Recent activity' },
      { path: '/app/access-points', file: 'portal-locations.png', expectText: 'Main gate' },
      { path: '/app/analytics', file: 'portal-analytics.png', expectText: 'Analytics' },
      // Usage & limits panel on the access-point detail page (scrolled into
      // view — it sits below the hero + maintenance sections).
      {
        path: '/app/access-points/ap_maingate',
        file: 'portal-limits.png',
        // NB: the "Usage & limits" kicker is CSS-uppercased (innerText follows
        // text-transform), so assert on the untransformed panel heading.
        expectText: 'Daily opens',
        scrollTo: '[data-shot="location-limits"]',
      },
    ];
    // Operator console — captured in a separate context whose /auth/me mock
    // grants is_platform_admin (the admin nav item + route guard key off it).
    const adminShots = [
      // NB: stat-card kickers are CSS-uppercased (innerText follows
      // text-transform), so assert on the untransformed signups heading.
      { path: '/app/admin', file: 'portal-admin.png', expectText: 'Recent signups' },
    ];
    const mobileShots = [
      // No Tauri app exists yet: the tap-to-open gate view at phone size is the
      // closest real "app" surface, standing in for the emergency/open flow.
      { path: '/app/open', file: 'app-emergency.png', expectText: 'Main gate' },
    ];

    const contexts = [
      {
        label: 'desktop 1440x900@2x',
        shots: desktopShots,
        options: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
      },
      {
        label: 'desktop admin 1440x900@2x',
        shots: adminShots,
        admin: true,
        options: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
      },
      {
        label: 'mobile 390x844@3x',
        shots: mobileShots,
        options: {
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        },
      },
    ];

    const written = [];
    for (const scheme of ['light', 'dark']) {
      if (scheme === 'dark' && !APP_HAS_DARK_MODE) break;
      for (const { label, shots, options, admin } of contexts) {
        console.log(`Capturing ${label} (${scheme}) ...`);
        const context = await browser.newContext({
          ...options,
          colorScheme: scheme,
          reducedMotion: 'reduce',
          locale: 'en-ZA',
          timezoneId: 'Africa/Johannesburg',
        });
        await context.addInitScript(AUTH_SEED);
        await context.addInitScript(`window.localStorage.setItem('lintel.theme', '${scheme}');`);
        await installApiMocks(context, { admin: Boolean(admin) });
        const page = await context.newPage();
        page.on('pageerror', (err) => console.warn(`  [pageerror] ${err.message}`));
        const outDir = scheme === 'dark' ? OUT_DARK : OUT_LIGHT;
        for (const shot of shots) {
          const out = path.join(outDir, shot.file);
          await capture(page, origin, shot, out);
          written.push(out);
        }
        await context.close();
      }
    }

    // Fallback: if the app has no dark theme, copy the light shots into dark/
    // so every documented path stays resolvable.
    if (!APP_HAS_DARK_MODE) {
      console.log('App has no dark mode — copying light shots into dark/ ...');
      for (const file of written.slice()) {
        const dst = path.join(OUT_DARK, path.basename(file));
        fs.copyFileSync(file, dst);
        console.log(`  ok dark/${path.basename(dst)}`);
      }
    }

    console.log(`\nDone. ${written.length} light + ${written.length} dark PNGs in site/screenshots/`);
  } catch (err) {
    console.error('\nScreenshotter failed:', err.message ?? err);
    if (viteLog.trim()) {
      console.error('--- vite output (tail) ---');
      console.error(viteLog.split('\n').slice(-25).join('\n'));
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    killVite();
  }
}

main();
