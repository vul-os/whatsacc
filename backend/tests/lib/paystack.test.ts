import { assert, assertEquals, assertFalse } from '../helpers/assert.ts';
import { resetEnvCache } from '@/lib/env.ts';
import { newReference, verifyWebhookSignature } from '@/lib/paystack.ts';

// Use the same secret as the integration suite so we don't poison
// downstream tests via the cached env (getEnv() caches PAYSTACK_SECRET_KEY).
const SECRET = 'sk_test_dummy';

function setTestEnv() {
  if (!process.env.DATABASE_URL) {
    // Stand-alone runs with no DB configured: buildEnv requires the var but
    // the paystack module never opens a connection, so any value works.
    process.env.DATABASE_URL = 'postgres://localhost/__no_connect__';
  }
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'unused';
  process.env.PAYSTACK_SECRET_KEY = SECRET;
  resetEnvCache();
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

test('paystack webhook signature: accepts a valid HMAC-SHA512 over the raw body', async () => {
  setTestEnv();
  const body = JSON.stringify({ event: 'charge.success', data: { id: 1, reference: 'wt_x' } });
  const sig = await hmacHex(SECRET, body);
  assert(await verifyWebhookSignature(body, sig));
});

test('paystack webhook signature: rejects tampered body', async () => {
  setTestEnv();
  const body = JSON.stringify({ event: 'charge.success', data: { id: 1, reference: 'wt_x' } });
  const sig = await hmacHex(SECRET, body);
  const tampered = body.replace('wt_x', 'wt_y');
  assertFalse(await verifyWebhookSignature(tampered, sig));
});

test('paystack webhook signature: rejects empty signature', async () => {
  setTestEnv();
  assertFalse(await verifyWebhookSignature('any', ''));
});

test('paystack newReference: prefixed and unique', () => {
  const a = newReference('wt');
  const b = newReference('wt');
  assert(a.startsWith('wt_'));
  assertEquals(a === b, false);
});
