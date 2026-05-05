// Stubs Paystack network calls by hijacking globalThis.fetch for any request
// targeting api.paystack.co. All other URLs fall through to the real fetch.
//
// Tracks the calls it observed so tests can assert on them.

export type PaystackCall = {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
};

export type PaystackOverrides = {
  initialize?: (body: unknown) => unknown;
  verify?: (reference: string) => unknown;
  createRecipient?: (body: unknown) => unknown;
  transfer?: (body: unknown) => unknown;
};

export type PaystackStub = {
  calls: PaystackCall[];
  restore: () => void;
  setOverrides: (o: PaystackOverrides) => void;
  initializeCount(): number;
  transferCount(): number;
  recipientCount(): number;
};

let lastTransferId = 100_000;

export function installPaystackStub(initial: PaystackOverrides = {}): PaystackStub {
  const realFetch = globalThis.fetch;
  const calls: PaystackCall[] = [];
  let overrides: PaystackOverrides = { ...initial };

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes('api.paystack.co')) {
      return await realFetch(input as RequestInfo, init);
    }

    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => (headers[k.toLowerCase()] = v));
    }
    let body: unknown = null;
    if (init?.body) {
      const raw = typeof init.body === 'string' ? init.body : await (init.body as Blob).text();
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
    }
    calls.push({ method, path: u.pathname, body, headers });

    const ok = (data: unknown) =>
      new Response(JSON.stringify({ status: true, message: 'ok', data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    if (method === 'POST' && u.pathname === '/transaction/initialize') {
      const data = overrides.initialize
        ? overrides.initialize(body)
        : defaultInitialize(body);
      return ok(data);
    }
    if (method === 'GET' && u.pathname.startsWith('/transaction/verify/')) {
      const reference = decodeURIComponent(u.pathname.replace('/transaction/verify/', ''));
      const data = overrides.verify
        ? overrides.verify(reference)
        : defaultVerify(reference, body);
      return ok(data);
    }
    if (method === 'POST' && u.pathname === '/transferrecipient') {
      const data = overrides.createRecipient
        ? overrides.createRecipient(body)
        : defaultRecipient(body);
      return ok(data);
    }
    if (method === 'POST' && u.pathname === '/transfer') {
      const data = overrides.transfer ? overrides.transfer(body) : defaultTransfer(body);
      return ok(data);
    }

    return new Response(
      JSON.stringify({ status: false, message: `unhandled paystack stub ${method} ${u.pathname}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
    setOverrides: (o: PaystackOverrides) => {
      overrides = { ...overrides, ...o };
    },
    initializeCount: () =>
      calls.filter((c) => c.method === 'POST' && c.path === '/transaction/initialize').length,
    transferCount: () =>
      calls.filter((c) => c.method === 'POST' && c.path === '/transfer').length,
    recipientCount: () =>
      calls.filter((c) => c.method === 'POST' && c.path === '/transferrecipient').length,
  };
}

function defaultInitialize(body: unknown) {
  const reference =
    (body as { reference?: string } | null)?.reference ?? `wt_${Date.now()}_test`;
  return {
    authorization_url: `https://checkout.paystack.com/${reference}`,
    access_code: `ac_${reference}`,
    reference,
  };
}

function defaultVerify(reference: string, _body: unknown) {
  return {
    id: 4_242_424,
    reference,
    status: 'success',
    amount: 100_00,
    currency: 'ZAR',
    paid_at: new Date().toISOString(),
    channel: 'card',
    customer: { customer_code: 'CUS_test', email: 'test@example.com' },
    metadata: null,
    gateway_response: 'Approved',
  };
}

function defaultRecipient(body: unknown) {
  const b = (body ?? {}) as { account_number?: string };
  const code = `RCP_${(b.account_number ?? 'unknown').slice(-6)}_test`;
  return {
    recipient_code: code,
    active: true,
    details: {
      account_number: b.account_number ?? '',
      account_name: 'Test Holder',
      bank_code: '198765',
    },
  };
}

function defaultTransfer(body: unknown) {
  lastTransferId += 1;
  const b = (body ?? {}) as { reference?: string; amount?: number };
  return {
    id: lastTransferId,
    transfer_code: `TRF_${lastTransferId}_test`,
    reference: b.reference ?? `po_${lastTransferId}`,
    status: 'pending',
    amount: b.amount ?? 0,
    currency: 'ZAR',
  };
}
