// Drives the actual "money path" of the product through a real Chromium
// browser against a real gateway binary: sign up, sign out, sign back in,
// create a location, create an access point, attempt an open with no
// controller paired, and read it back out of the audit log — the exact
// sequence src/lib/api.ts's rewrite was supposed to make work, and that
// nobody had driven end-to-end in a browser before this suite existed (see
// e2e-browser/README.md).
import { startGateway, type LiveGateway } from './fixtures/gateway';
import { expect, test } from './fixtures/test';

test.describe.configure({ mode: 'serial' });

let gw: LiveGateway;

test.beforeAll(async () => {
  gw = await startGateway('money-path');
});

test.afterAll(async () => {
  await gw.stop();
});

const RUN_ID = Date.now();
const EMAIL = `e2e-money-${RUN_ID}@example.com`;
const PASSWORD = 'correct horse battery staple 1';
const DISPLAY_NAME = 'Money Path Tester';
const LOCATION_NAME = 'E2E Test House';
const AP_NAME = 'Front Gate';

test('sign up, sign in, create a location + access point, attempt an open, read the audit log', async ({
  page,
}) => {
  // ── Connect to the gateway ────────────────────────────────────────────
  // A fresh self-hosted build with no VITE_API_BASE_URL baked in (the
  // documented `make portal` recipe doesn't set one) and no stored gateway
  // choice always boots into this picker first — see
  // src/components/gateway/GatewayGate.tsx's decideBoot(). That's real
  // first-run UX for the embedded portal, not a test seam, so it's driven
  // for real here rather than pre-seeding localStorage.
  await page.goto(gw.url('/signup'));
  await expect(page.getByRole('heading', { name: 'Connect to your gateway' })).toBeVisible();
  await page.getByLabel('Gateway URL', { exact: true }).fill(gw.baseUrl);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();

  // ── Step 1/3 — account basics ─────────────────────────────────────────
  await page.getByLabel('Your name', { exact: true }).fill(DISPLAY_NAME);
  await page.getByLabel('Email', { exact: true }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue →', exact: true }).click();

  // ── Step 2/3 — account kind (leave default "Personal") ────────────────
  await expect(page.getByRole('heading', { name: 'What is this for?' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue →', exact: true }).click();

  // ── Step 3/3 — first location: the "create a location" step of the
  // money path. POST /v1/auth/register bundles account + this location into
  // one call (gateway/internal/httpapi/auth.go's handleRegister) — there is
  // no join-only registration mode, so this is genuinely how every account's
  // first location gets created on this product.
  await expect(page.getByRole('heading', { name: 'Your first location' })).toBeVisible();
  await page.getByLabel('Location name').fill(LOCATION_NAME);

  const registerResponsePromise = page.waitForResponse(
    (r) => r.url() === gw.url('/v1/auth/register') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  const registerResponse = await registerResponsePromise;
  expect(registerResponse.status(), 'registration must succeed against the real gateway').toBe(
    201,
  );
  const registerBody = await registerResponse.json();
  // The historical bug this suite guards against: tokens used to be assumed
  // flat on the response; the gateway nests them under `tokens`.
  expect(registerBody.tokens?.access_token).toEqual(expect.any(String));
  expect(registerBody.tokens?.refresh_token).toEqual(expect.any(String));
  expect(registerBody.location?.name).toBe(LOCATION_NAME);

  await expect(page.getByRole('heading', { name: "You're in." })).toBeVisible();
  await page.getByRole('button', { name: 'Go to dashboard', exact: true }).click();
  await expect(page).toHaveURL(`${gw.baseUrl}/app`);

  // ── Sign out ────────────────────────────────────────────────────────
  // Signup already leaves the session signed in; sign out and do a REAL
  // fresh login as its own driven step — nobody has exercised Login.tsx
  // against a live gateway either, and it's a separate code path
  // (signInWithPassword vs registerWithPassword in src/lib/auth.tsx).
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(`${gw.baseUrl}/login`);
  expect(await page.evaluate(() => localStorage.getItem('lintel.access_token'))).toBeNull();

  // ── Log back in ─────────────────────────────────────────────────────
  const loginResponsePromise = page.waitForResponse(
    (r) => r.url() === gw.url('/v1/auth/login') && r.request().method() === 'POST',
  );
  await page.getByLabel('Email', { exact: true }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.status()).toBe(200);
  const loginBody = await loginResponse.json();
  expect(loginBody.tokens?.access_token).toEqual(expect.any(String));
  await expect(page).toHaveURL(`${gw.baseUrl}/app`);

  // ── Create an access point (uses the location created during signup) ──
  await expect(page.getByText('One more step before your first gate opens.')).toBeVisible();
  await page.getByRole('button', { name: 'Add access point →', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add access point' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(AP_NAME);

  const apCreateResponsePromise = page.waitForResponse(
    (r) => r.url() === gw.url('/v1/access-points') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Add access point', exact: true }).click();
  const apCreateResponse = await apCreateResponsePromise;
  expect(apCreateResponse.status()).toBe(201);
  const accessPoint = await apCreateResponse.json();
  expect(accessPoint.name).toBe(AP_NAME);
  expect(accessPoint.device_id, 'no controller was paired').toBeNull();

  // ── Attempt an open with no controller paired ──────────────────────────
  // This must be an honest, auditable "no device to dispatch to" outcome —
  // HTTP 200, delivery: "no_device" (gateway/internal/httpapi/open.go's
  // dispatchCommand) — not a crash and not a fabricated "acked".
  await page.goto(gw.url('/app/open'));
  await expect(page.getByText(AP_NAME).first()).toBeVisible();
  await page.getByRole('button', { name: 'I want to open this', exact: true }).click();

  const openResponsePromise = page.waitForResponse(
    (r) => /\/v1\/access-points\/.+\/open$/.test(r.url()) && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Yes, open the gate', exact: true }).click();
  const openResponse = await openResponsePromise;
  expect(openResponse.status(), 'an open on an unpaired AP is a real, audited success').toBe(200);
  const openBody = await openResponse.json();
  expect(
    openBody.delivery,
    'no controller is paired, so delivery must be the honest no_device state',
  ).toBe('no_device');
  await expect(page.getByText('The command was logged.')).toBeVisible();

  // ── Audit log: dates must render as real dates, not 1970 ──────────────
  // The original bug fed raw Unix-seconds integers straight into
  // `new Date()` (which expects milliseconds), rendering every timestamp as
  // 1 Jan 1970. src/lib/time.ts's fromUnix() is the fix; confirm it actually
  // reaches the screen. The dashboard's own "Recent activity" panel can't
  // prove this — GET /analytics/accounts/{id}/summary isn't ported on the
  // gateway yet (api.ts's accountSummary doc comment), so it always shows
  // the honest "not available" message instead of real rows. The admin
  // audit log (GET /v1/admin/audit) is real and populated by the open above,
  // so claim the one-shot instance-admin token to reach it.
  await page.goto(gw.url('/app/admin'));
  await expect(page.getByRole('heading', { name: 'Claim this instance' })).toBeVisible();
  await page.getByLabel('Claim token', { exact: true }).fill(gw.adminClaimToken);
  await page.getByRole('button', { name: 'Claim instance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Instance admin' })).toBeVisible();

  await page.getByRole('link', { name: 'Audit', exact: true }).click();
  const auditRows = page.locator('table tbody tr');
  await expect(auditRows.first()).toBeVisible();
  const firstRowText = await auditRows.first().innerText();
  expect(firstRowText).not.toContain('1970');
  expect(firstRowText).not.toContain('Invalid Date');
  expect(firstRowText).not.toContain('NaN');
  // fmtDateTime (src/pages/app/admin/shared.tsx) renders "DD Mon HH:MM" —
  // assert the day-of-month is today's, proving this is a real "now"
  // timestamp and not an epoch artifact wearing a plausible-looking format.
  const todayDay = String(new Date().getDate()).padStart(2, '0');
  expect(firstRowText).toContain(todayDay);
});
