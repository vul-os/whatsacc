import { defineConfig, devices } from '@playwright/test';

// Real-browser E2E against a real gateway binary — see e2e-browser/README.md
// for why this lives here and not in e2e/ (that's a Go cross-module harness
// for gateway<->controller wire interop; this is Chromium against the
// embedded portal).
export default defineConfig({
  testDir: './e2e-browser',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e-browser/global-setup.ts',
  globalTeardown: './e2e-browser/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // Two spec files today, each booting its own gateway process; cap workers
  // so CI runners don't try to boot a pile of gateway processes at once.
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 45_000,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // OpenGate.tsx / AccessPointAction.tsx ask for geolocation before
    // opening a gate. Grant a fixed real-world location deterministically
    // instead of leaving it to whatever the runner's permission-denial
    // timing happens to be.
    geolocation: { latitude: -33.9249, longitude: 18.4241 }, // Cape Town
    permissions: ['geolocation'],
    locale: 'en-ZA',
    timezoneId: 'Africa/Johannesburg',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
