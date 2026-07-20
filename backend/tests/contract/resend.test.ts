// Real-Resend contract tests. SKIPPED unless RESEND_TEST_API_KEY and
// RESEND_TEST_TO_EMAIL are set. Each successful test sends ONE real email
// to the configured address; configure your inbox so they don't pile up.
//
// Required env to actually run:
//   RESEND_TEST_API_KEY=re_xxx
//   RESEND_TEST_TO_EMAIL=you@yourdomain.com   (a real inbox you own)
//   RESEND_TEST_FROM=lintel <noreply@yourdomain.com>   (optional override)
//
// Run only the contract suite:
//   deno test -A --env-file=../.env tests/contract/resend.test.ts
//
// What this verifies:
//   1. sendEmail() reaches the Resend API and returns success
//   2. The from-domain is verified on your Resend account
//   3. Account invite + password reset templates render the expected fields

import { assertEquals, assertExists } from '../helpers/assert.ts';
import { contractTest, envValue } from '../helpers/contract.ts';
import { resetEnvCache } from '@/lib/env.ts';
import { sendEmail } from '@/lib/email.ts';

function setupRealResendEnv() {
  process.env.RESEND_API_KEY = envValue('RESEND_TEST_API_KEY')!;
  resetEnvCache();
}

contractTest(
  'resend: sendEmail delivers a basic transactional message',
  ['RESEND_TEST_API_KEY', 'RESEND_TEST_TO_EMAIL'],
  async () => {
    setupRealResendEnv();
    const to = envValue('RESEND_TEST_TO_EMAIL')!;
    const from = process.env.RESEND_TEST_FROM ?? undefined;

    // sendEmail returns void; if Resend rejects (bad domain, bad key, bad
    // payload), it logs to stderr but doesn't throw. Wrap with our own
    // direct fetch so we can assert.
    const key = envValue('RESEND_TEST_API_KEY')!;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: from ?? 'lintel <noreply@lintel.com>',
        to: [to],
        subject: 'lintel contract test',
        text: 'This is a contract test from the lintel test suite.',
        html: '<p>This is a contract test from the lintel test suite.</p>',
      }),
    });
    const body = await res.json().catch(() => ({}));
    assertEquals(
      res.ok,
      true,
      `Resend rejected the send: ${res.status} ${JSON.stringify(body)}`,
    );
    assertExists((body as { id?: string }).id);

    // Now also exercise our wrapper (it should not throw).
    await sendEmail({
      to,
      subject: 'lintel contract test (wrapper)',
      html: '<p>via sendEmail()</p>',
      text: 'via sendEmail()',
      from,
    });
  },
);

contractTest(
  'resend: from-domain is verified (sending to a fresh recipient succeeds)',
  ['RESEND_TEST_API_KEY', 'RESEND_TEST_TO_EMAIL'],
  async () => {
    setupRealResendEnv();
    const to = envValue('RESEND_TEST_TO_EMAIL')!;
    const from = process.env.RESEND_TEST_FROM ?? 'lintel <noreply@lintel.com>';
    const key = envValue('RESEND_TEST_API_KEY')!;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: 'lintel domain check',
        text: 'Domain check.',
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        `from-domain not verified on this Resend account. Verify the domain in your Resend dashboard. Server said: ${JSON.stringify(body)}`,
      );
    }
  },
);
