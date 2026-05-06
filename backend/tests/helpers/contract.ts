// Helpers for contract tests against real third-party services.
// Each contract test is skipped unless its required env var is set.

export type ContractEnv =
  | 'PAYSTACK_TEST_SECRET_KEY'
  | 'PAYSTACK_TEST_PUBLIC_KEY'
  | 'RESEND_TEST_API_KEY'
  | 'RESEND_TEST_TO_EMAIL';

export function envValue(name: ContractEnv): string | null {
  const v = (Deno.env.get(name) ?? '').trim();
  return v || null;
}

export function contractTest(
  name: string,
  required: ContractEnv[],
  fn: () => Promise<void>,
): void {
  const missing = required.filter((k) => !envValue(k));
  Deno.test({
    name: missing.length ? `${name} [SKIP — missing ${missing.join(', ')}]` : name,
    ignore: missing.length > 0,
    sanitizeResources: false,
    sanitizeOps: false,
    fn,
  });
}

/** Random reference safe for Paystack (max 100 chars, alphanumerics + -=._). */
export function uniqRef(prefix: string): string {
  const rnd = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}

/** Random unique email so reused signups don't collide on Paystack's side.
 * Uses example.com (RFC 2606 reserved) instead of .local — Paystack's email
 * validator rejects .local as an invalid TLD. */
export function uniqEmail(): string {
  return `whatsacc-contract-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

export async function paystackCall<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: boolean; message: string; data: T }> {
  const key = envValue('PAYSTACK_TEST_SECRET_KEY');
  if (!key) throw new Error('PAYSTACK_TEST_SECRET_KEY required');
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: { status: boolean; message: string; data: T };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`paystack ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  return parsed;
}
