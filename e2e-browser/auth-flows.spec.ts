// The two auth paths nobody had exercised against a real gateway:
//   1. logout — does it actually kill the session (client AND server), or
//      just clear localStorage and hope?
//   2. 401 -> refresh -> retry — src/lib/api.ts's apiFetch() has a one-shot
//      "401, refresh, retry" path (see its doRequest/refreshAccessToken).
//      The original bug (RefreshResponse assumed flat tokens; the gateway
//      nests them under `tokens`) would live exactly here: a real access
//      token expiring mid-session. Since the real TTL is 15 minutes
//      (gateway/internal/httpapi/auth.go's accessTTL) and nobody's about to
//      wait that out in CI, this reproduces "expired access token, still-
//      valid refresh token" directly instead.
import { startGateway, type LiveGateway } from './fixtures/gateway';
import { allowExpectedConsoleError, expect, test } from './fixtures/test';

test.describe.configure({ mode: 'serial' });

let gw: LiveGateway;

test.beforeAll(async () => {
  gw = await startGateway('auth-flows');
});

test.afterAll(async () => {
  await gw.stop();
});

async function connectAndSignUp(
  page: import('@playwright/test').Page,
  email: string,
): Promise<void> {
  await page.goto(gw.url('/signup'));
  await page.getByLabel('Gateway URL', { exact: true }).fill(gw.baseUrl);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Your name', { exact: true }).fill('Auth Flow Tester');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill('correct horse battery staple 1');
  await page.getByRole('button', { name: 'Continue →', exact: true }).click();
  await page.getByRole('button', { name: 'Continue →', exact: true }).click(); // account-kind step
  await page.getByLabel('Location name').fill('Auth Flow House');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: "You're in." })).toBeVisible();
  await page.getByRole('button', { name: 'Go to dashboard', exact: true }).click();
  await expect(page).toHaveURL(`${gw.baseUrl}/app`);
}

test('logout clears the session locally and server-side, and protected routes bounce to /login', async ({
  page,
}) => {
  await connectAndSignUp(page, `e2e-logout-${Date.now()}@example.com`);

  expect(await page.evaluate(() => localStorage.getItem('lintel.access_token'))).not.toBeNull();

  const logoutResponsePromise = page.waitForResponse(
    (r) => r.url() === gw.url('/v1/auth/logout') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const logoutResponse = await logoutResponsePromise;
  expect(logoutResponse.status()).toBe(200);

  await expect(page).toHaveURL(`${gw.baseUrl}/login`);
  expect(await page.evaluate(() => localStorage.getItem('lintel.access_token'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('lintel.refresh_token'))).toBeNull();

  // Not just a client-side illusion: hitting a protected route again must
  // still bounce to /login (no stale in-memory auth state surviving nav).
  await page.goto(gw.url('/app'));
  await expect(page).toHaveURL(`${gw.baseUrl}/login`);
});

test('a stale access token triggers a transparent 401 -> refresh -> retry', async ({ page }) => {
  await connectAndSignUp(page, `e2e-refresh-${Date.now()}@example.com`);

  const originalRefresh = await page.evaluate(() => localStorage.getItem('lintel.refresh_token'));
  expect(originalRefresh).not.toBeNull();

  // Corrupt the access token so the next authenticated request 401s, while
  // leaving the real refresh token in place — this is "access token expired
  // mid-session" without waiting out the real 15-minute TTL.
  await page.evaluate(() => {
    localStorage.setItem('lintel.access_token', 'corrupted.not-a-real.jwt');
  });
  // The 401 below is this test's deliberate premise, not a bug — but
  // Chromium logs any non-2xx fetch response to the console as an "error"
  // regardless of apiFetch's graceful auto-refresh handling it correctly, so
  // declare it expected rather than let the cleanPage fixture flag it.
  allowExpectedConsoleError(
    page,
    (text, locationUrl) => text.includes('401') && locationUrl.endsWith('/v1/auth/me'),
  );

  const meStatuses: number[] = [];
  page.on('response', (res) => {
    if (new URL(res.url()).pathname === '/v1/auth/me') meStatuses.push(res.status());
  });
  const refreshResponsePromise = page.waitForResponse(
    (r) => r.url() === gw.url('/v1/auth/refresh') && r.request().method() === 'POST',
  );

  // AuthProvider's boot effect calls GET /v1/auth/me on mount — reloading
  // with the corrupted token re-triggers it for real, exactly like an
  // access token expiring while the user is sitting on the page.
  await page.reload();

  const refreshResponse = await refreshResponsePromise;
  expect(refreshResponse.status(), 'refresh must succeed with the still-valid refresh token').toBe(
    200,
  );
  const refreshBody = await refreshResponse.json();
  // The exact historical bug this test targets: RefreshResponse assumed
  // flat tokens on the response; the gateway nests them under `tokens`. If
  // that parsing regresses, refreshAccessToken() silently returns false,
  // tokens get cleared, and the assertions below fail loudly instead of the
  // user just getting logged out for no visible reason.
  expect(refreshBody.tokens?.access_token).toEqual(expect.any(String));
  expect(refreshBody.tokens?.refresh_token).toEqual(expect.any(String));

  // The app must recover silently — no forced logout, no crash, no stuck
  // spinner. Still a fresh account with a location but no access points, so
  // the onboarding view is the expected authenticated state.
  await expect(page).toHaveURL(`${gw.baseUrl}/app`);
  await expect(page.getByText('One more step before your first gate opens.')).toBeVisible();

  await expect.poll(() => meStatuses).toContain(401);
  await expect.poll(() => meStatuses).toContain(200);

  const newAccess = await page.evaluate(() => localStorage.getItem('lintel.access_token'));
  const newRefresh = await page.evaluate(() => localStorage.getItem('lintel.refresh_token'));
  expect(newAccess).not.toBe('corrupted.not-a-real.jwt');
  expect(newAccess).toEqual(expect.any(String));
  // Refresh tokens rotate on every use (family reuse-detection, per
  // gateway/internal/httpapi/auth.go's handleRefresh) — the pre-corruption
  // refresh token must no longer be the active one.
  expect(newRefresh).not.toBe(originalRefresh);
});
