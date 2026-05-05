// Helpers for contract tests against real third-party services.
// Each contract test is skipped unless its required env var is set.

export type ContractEnv =
  | 'PAYSTACK_SECRET_KEY'
  | 'PAYSTACK_PUBLIC_KEY'
  | 'RESEND_API_KEY'
  | 'RESEND_TEST_TO_EMAIL';

export function envValue(name: ContractEnv): string | null {
  const v = (Deno.env.get(name) ?? '').trim();
  return v || null;
}

/**
 * Refuse to run contract tests against a Paystack LIVE key. Test mode keys
 * start with `sk_test_…`; live keys start with `sk_live_…`. The contract
 * tests create real recipients + dispatch real transfers, so live mode
 * would draw real money.
 */
function paystackKeyIsLive(): boolean {
  const k = envValue('PAYSTACK_SECRET_KEY') ?? '';
  return k.startsWith('sk_live_');
}

export function contractTest(
  name: string,
  required: ContractEnv[],
  fn: () => Promise<void>,
): void {
  const missing = required.filter((k) => !envValue(k));
  const usesPaystack = required.includes('PAYSTACK_SECRET_KEY');
  const blockedLive = usesPaystack && paystackKeyIsLive();
  const ignore = missing.length > 0 || blockedLive;
  let suffix = '';
  if (missing.length) suffix = ` [SKIP — missing ${missing.join(', ')}]`;
  else if (blockedLive) suffix = ' [SKIP — refuses to run against sk_live_ Paystack key]';
  Deno.test({
    name: name + suffix,
    ignore,
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

/** Random unique email so reused signups don't collide on Paystack's side. */
export function uniqEmail(): string {
  return `whatsacc-contract-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

export async function paystackCall<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: boolean; message: string; data: T }> {
  const key = envValue('PAYSTACK_SECRET_KEY');
  if (!key) throw new Error('PAYSTACK_SECRET_KEY required');
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
