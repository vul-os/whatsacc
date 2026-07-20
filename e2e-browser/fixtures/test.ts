// Extends Playwright's `test` with an auto-fixture that fails a test loudly
// if the page:
//   - logs a console.error
//   - throws an uncaught exception / unhandled promise rejection
//   - crashes
//   - receives a 2xx response under /v1/* whose body isn't JSON
//
// The last one is the specific trap this whole suite exists to catch: the
// gateway's embedded portal answers any unmatched path with 200 + index.html
// (see gateway/internal/portal/portal.go's SPA fallback) instead of 404. A
// frontend call to a route that doesn't exist (or a typo'd path) silently
// "succeeds" with HTML bytes unless something asserts on it. src/lib/api.ts
// already guards this in-app (ApiError with UNAVAILABLE_CODE), but that guard
// itself could regress, and some call sites intentionally swallow it (see
// Dashboard.tsx's `.catch(() => null)` on analytics calls) — so this fixture
// checks the wire directly, independent of app-level handling.
import type { Page } from '@playwright/test';
import { test as base, expect } from '@playwright/test';

type Violation = { kind: string; detail: string };

// A test that deliberately provokes a browser-level error (e.g.
// auth-flows.spec.ts corrupting the access token to reproduce a real 401)
// calls this BEFORE doing so, to declare that one specific, expected error
// as not a violation. Chromium logs any non-2xx fetch/XHR response to the
// console as an "error" regardless of whether application code handles it
// gracefully — same mechanism as the localhost:8787 probe below, just
// per-test instead of global, since which requests are "deliberately
// expected to fail" varies per test.
const extraAllowedConsoleErrors = new WeakMap<
  Page,
  Array<(text: string, locationUrl: string) => boolean>
>();

export function allowExpectedConsoleError(
  page: Page,
  predicate: (text: string, locationUrl: string) => boolean,
): void {
  const arr = extraAllowedConsoleErrors.get(page) ?? [];
  arr.push(predicate);
  extraAllowedConsoleErrors.set(page, arr);
}

// Routes src/lib/api.ts's own doc comments document as NOT IMPLEMENTED on
// the gateway, where the call site already wraps the call so it degrades
// honestly (ApiError(UNAVAILABLE_CODE) -> a graceful fallback, never a crash
// or fabricated data). Real, live examples caught by a first run of this
// suite: Signup.tsx calls `api.countries()` on mount (falls back to a
// static ZA-only list), and Dashboard.tsx calls `api.accountSummary()` on
// mount (falls back to an honest "not available" message) — both documented
// as unported in api.ts and both already handled correctly.
//
// This allowlist exists so THOSE specific, acknowledged gaps don't drown out
// a genuinely new one: any /v1/* SPA-fallback hit NOT on this list still
// fails the suite loudly, which is the whole point of the check (see the
// module doc comment below).
const KNOWN_UNAVAILABLE_V1_PATHS = new Set([
  '/v1/reference/countries',
  '/v1/phones/me/phones',
  '/v1/auth/me/slack',
  '/v1/auth/me/profile',
  '/v1/auth/forgot-password',
  '/v1/auth/reset-password',
  '/v1/auth/verify-email',
  '/v1/auth/google/start',
]);
const KNOWN_UNAVAILABLE_V1_PREFIXES = ['/v1/analytics/'];

function isKnownUnavailableV1Route(pathname: string): boolean {
  if (KNOWN_UNAVAILABLE_V1_PATHS.has(pathname)) return true;
  return KNOWN_UNAVAILABLE_V1_PREFIXES.some((p) => pathname.startsWith(p));
}

// src/components/gateway/GatewayGate.tsx probes this exact hardcoded
// fallback URL (src/lib/gateway.ts's FALLBACK_BASE_URL) on boot whenever no
// gateway is stored yet and the build has no VITE_API_BASE_URL — which is
// every test here, since driving the real "Connect to your gateway" picker
// is the point (see money-path.spec.ts). Nothing listens on that port in
// this suite, so Chromium logs a `net::ERR_CONNECTION_REFUSED` console error
// for the probe — the app's own testGatewayUrl() already catches it
// (src/lib/gateway.ts) and correctly shows the picker. This is expected,
// by-design behavior, not a bug: DevTools logs failed network requests to
// the console regardless of whether application code catches them.
const EXPECTED_GATEWAY_PROBE_HOST = 'localhost:8787';

export const test = base.extend<{ cleanPage: void }>({
  cleanPage: [
    // eslint-disable-next-line no-empty-pattern
    async ({ page }, use) => {
      const violations: Violation[] = [];

      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        // Chromium's "Failed to load resource: net::..." console message
        // does NOT include the URL in msg.text() — the failing request's
        // URL only shows up in msg.location().url. Check both.
        const text = msg.text();
        const locationUrl = msg.location().url ?? '';
        if (
          text.includes(EXPECTED_GATEWAY_PROBE_HOST) ||
          locationUrl.includes(EXPECTED_GATEWAY_PROBE_HOST)
        ) {
          return;
        }
        const extra = extraAllowedConsoleErrors.get(page) ?? [];
        if (extra.some((predicate) => predicate(text, locationUrl))) return;
        violations.push({ kind: 'console.error', detail: `${text} (${locationUrl})` });
      });
      page.on('pageerror', (err) => {
        violations.push({ kind: 'pageerror', detail: err.stack ?? err.message });
      });
      page.on('crash', () => {
        violations.push({ kind: 'crash', detail: 'page process crashed' });
      });

      // Belt-and-braces: forward `unhandledrejection` to console.error from
      // inside the page too. Playwright's `pageerror` is documented to catch
      // uncaught exceptions; unhandled promise rejections are less
      // consistently surfaced across Chromium/CDP versions, so don't rely on
      // pageerror alone for the exact failure mode a broken `await` would
      // produce in React event handlers.
      await page.addInitScript(() => {
        window.addEventListener('unhandledrejection', (e) => {
          const reason = e.reason as unknown;
          const detail =
            reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
          // eslint-disable-next-line no-console
          console.error('[unhandledrejection]', detail);
        });
      });

      page.on('response', (res) => {
        let url: URL;
        try {
          url = new URL(res.url());
        } catch {
          return;
        }
        if (!url.pathname.startsWith('/v1/')) return;
        const status = res.status();
        if (status < 200 || status >= 300 || status === 204) return;
        if (isKnownUnavailableV1Route(url.pathname)) return;
        const contentType = res.headers()['content-type'] ?? '';
        if (!contentType.includes('application/json')) {
          violations.push({
            kind: 'spa-fallback-trap',
            detail:
              `${res.request().method()} ${url.pathname} -> ${status} ` +
              `content-type="${contentType}" (expected application/json; this is the ` +
              `embedded portal's SPA-fallback page, not a real API response — see ` +
              `gateway/internal/portal/portal.go and src/lib/api.ts's UNAVAILABLE_CODE)`,
          });
        }
      });

      await use();

      expect(
        violations,
        violations.length
          ? `page produced ${violations.length} unexpected error(s):\n` +
            violations.map((v) => `  [${v.kind}] ${v.detail}`).join('\n')
          : undefined,
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
