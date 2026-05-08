// Thin Paystack client — initialize transaction, verify transaction, and
// HMAC-SHA512 webhook signature check. Native amount is ZAR cents (kobo for
// Paystack), passed through unchanged.

import { getEnv } from './env.ts';

const API_BASE = 'https://api.paystack.co';

export type PaystackInitInput = {
  email: string;
  amountCents: number;
  reference: string;
  currency?: string; // defaults to ZAR
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
};

export type PaystackInitData = {
  authorization_url: string;
  access_code: string;
  reference: string;
};

export type PaystackVerifyData = {
  id: number;
  reference: string;
  status: 'success' | 'failed' | 'abandoned' | string;
  amount: number; // kobo (ZAR cents)
  currency: string;
  paid_at: string | null;
  channel: string | null;
  customer?: { customer_code?: string; email?: string };
  metadata?: Record<string, unknown> | null;
  gateway_response?: string;
};

type Envelope<T> = { status: boolean; message: string; data: T };

function secret(): string {
  const k = getEnv().PAYSTACK_SECRET_KEY;
  if (!k) throw new Error('PAYSTACK_SECRET_KEY not configured');
  return k;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Envelope<T> | null = null;
  try {
    parsed = text ? (JSON.parse(text) as Envelope<T>) : null;
  } catch {
    // fall through
  }
  if (!res.ok || !parsed || parsed.status !== true) {
    const msg = parsed?.message ?? `paystack_http_${res.status}`;
    throw new Error(`paystack ${method} ${path} failed: ${msg}`);
  }
  return parsed.data;
}

export async function initializeTransaction(input: PaystackInitInput): Promise<PaystackInitData> {
  return await call<PaystackInitData>('POST', '/transaction/initialize', {
    email: input.email,
    amount: input.amountCents,
    reference: input.reference,
    currency: input.currency ?? 'ZAR',
    callback_url: input.callbackUrl,
    metadata: input.metadata,
  });
}

export async function verifyTransaction(reference: string): Promise<PaystackVerifyData> {
  return await call<PaystackVerifyData>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
}

// HMAC-SHA512 of the raw request body using the secret key. Constant-time compare.
export async function verifyWebhookSignature(rawBody: string, signature: string): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret()),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return timingSafeEqual(expected, signature.toLowerCase());
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export function newReference(prefix = 'wt'): string {
  // Paystack accepts up to 100 chars, alphanumerics + -=._
  const rnd = crypto.randomUUID().replace(/-/g, '');
  return `${prefix}_${Date.now().toString(36)}_${rnd.slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Transfers (payouts)
// ---------------------------------------------------------------------------

export type CreateRecipientInput = {
  name: string;
  account_number: string;
  bank_code: string;
  currency?: string; // default ZAR
  email?: string;
};

export type RecipientData = {
  recipient_code: string;
  active: boolean;
  details: { account_number: string; account_name: string | null; bank_code: string };
};

export type InitiateTransferInput = {
  amountCents: number;
  recipientCode: string;
  reference: string;
  reason?: string;
};

export type TransferData = {
  id: number;
  transfer_code: string;
  reference: string;
  status: 'pending' | 'success' | 'failed' | 'reversed' | string;
  amount: number;
  currency: string;
};

export async function createTransferRecipient(
  input: CreateRecipientInput,
): Promise<RecipientData> {
  return await call<RecipientData>('POST', '/transferrecipient', {
    type: 'basa', // South African bank recipient (Paystack ZA)
    name: input.name,
    account_number: input.account_number,
    bank_code: input.bank_code,
    currency: input.currency ?? 'ZAR',
    email: input.email,
  });
}

export async function initiateTransfer(input: InitiateTransferInput): Promise<TransferData> {
  return await call<TransferData>('POST', '/transfer', {
    source: 'balance',
    amount: input.amountCents,
    recipient: input.recipientCode,
    reference: input.reference,
    reason: input.reason ?? 'whatsacc referral payout',
  });
}

// ---------------------------------------------------------------------------
// Charge a previously-authorized card. Used by the subscription renewal cron:
// the account's first wallet topup or first subscription charge captures an
// authorization_code, which we replay against /transaction/charge_authorization
// for recurring renewals.
// ---------------------------------------------------------------------------

export type ChargeAuthorizationInput = {
  email: string;
  amountCents: number;
  authorizationCode: string;
  reference: string;
  currency?: string;
  metadata?: Record<string, unknown>;
};

export async function chargeAuthorization(
  input: ChargeAuthorizationInput,
): Promise<PaystackVerifyData> {
  return await call<PaystackVerifyData>('POST', '/transaction/charge_authorization', {
    email: input.email,
    amount: input.amountCents,
    authorization_code: input.authorizationCode,
    reference: input.reference,
    currency: input.currency ?? 'ZAR',
    metadata: input.metadata,
  });
}
