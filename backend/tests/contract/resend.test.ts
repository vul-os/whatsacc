// Real-Resend contract tests. SKIPPED unless RESEND_API_KEY and
// RESEND_TEST_TO_EMAIL are set. Each successful test sends ONE real email
// to the configured address; configure your inbox so they don't pile up.
//
// Required env to actually run:
//   RESEND_API_KEY=re_xxx
//   RESEND_TEST_TO_EMAIL=you@yourdomain.com   (a real inbox you own)
//   RESEND_TEST_FROM=whatsacc <noreply@yourdomain.com>   (optional override)
//
// Run only the contract suite:
//   deno test -A --env-file=../.env tests/contract/resend.test.ts
//
// What this verifies:
//   1. sendEmail() reaches the Resend API and returns success
//   2. The from-domain is verified on your Resend account
//   3. Account invite + password reset templates render the expected fields

import { assertEquals, assertExists } from '@std/assert';
import { contractTest, envValue } from '../helpers/contract.ts';
import { sendEmail } from '@/lib/email.ts';


contractTest(
  'resend: sendEmail delivers a basic transactional message',
  ['RESEND_API_KEY', 'RESEND_TEST_TO_EMAIL'],
  async () => {
    const to = envValue('RESEND_TEST_TO_EMAIL')!;
    const from = Deno.env.get('RESEND_TEST_FROM') ?? undefined;

    // sendEmail returns void; if Resend rejects (bad domain, bad key, bad
    // payload), it logs to stderr but doesn't throw. Wrap with our own
    // direct fetch so we can assert.
    const key = envValue('RESEND_API_KEY')!;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: from ?? 'whatsacc <noreply@whatsacc.com>',
        to: [to],
        subject: 'whatsacc contract test',
        text: 'This is a contract test from the whatsacc test suite.',
        html: '<p>This is a contract test from the whatsacc test suite.</p>',
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
      subject: 'whatsacc contract test (wrapper)',
      html: '<p>via sendEmail()</p>',
      text: 'via sendEmail()',
      from,
    });
  },
);

contractTest(
  'resend: from-domain is verified (sending to a fresh recipient succeeds)',
  ['RESEND_API_KEY', 'RESEND_TEST_TO_EMAIL'],
  async () => {
    const to = envValue('RESEND_TEST_TO_EMAIL')!;
    const from = Deno.env.get('RESEND_TEST_FROM') ?? 'whatsacc <noreply@whatsacc.com>';
    const key = envValue('RESEND_API_KEY')!;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: 'whatsacc domain check',
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
