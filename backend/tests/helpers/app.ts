// Test app harness. Boots the real Hono app in-process and exposes a tiny
// fetch-style helper that handles JSON, bearer tokens, and raw bodies.

import { createApp } from '@/app.ts';
import { setupTestDb } from './db.ts';

const TEST_ORIGIN = 'http://test.local';

export type AppHandle = {
  fetch: (req: Request) => Promise<Response>;
  request: TestRequest;
};

export type TestRequest = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  opts?: TestRequestOpts,
) => Promise<TestResponse>;

export type TestRequestOpts = {
  json?: unknown;
  rawBody?: string;
  contentType?: string;
  token?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
};

export type TestResponse = {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
};

export async function bootTestApp(): Promise<AppHandle> {
  // Ensure test DB is migrated and DATABASE_URL is pointed at it.
  await setupTestDb();
  // Required env vars for the production code paths to work in tests.
  if (!Deno.env.get('JWT_SECRET')) Deno.env.set('JWT_SECRET', 'test-jwt-secret');
  if (!Deno.env.get('APP_PUBLIC_URL')) Deno.env.set('APP_PUBLIC_URL', 'http://test.local');
  if (!Deno.env.get('APP_ENV')) Deno.env.set('APP_ENV', 'test');
  if (!Deno.env.get('PAYSTACK_SECRET_KEY')) Deno.env.set('PAYSTACK_SECRET_KEY', 'sk_test_dummy');

  const app = createApp();
  const fetch = async (req: Request) => await app.fetch(req);

  const request: TestRequest = async (method, path, opts = {}) => {
    let url = path.startsWith('http') ? path : `${TEST_ORIGIN}${path}`;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const sep = url.includes('?') ? '&' : '?';
      const s = qs.toString();
      if (s) url = `${url}${sep}${s}`;
    }
    const headers = new Headers(opts.headers ?? {});
    if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);

    let body: BodyInit | undefined;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
      if (opts.contentType) headers.set('Content-Type', opts.contentType);
    } else if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(new Request(url, { method, headers, body }));
    const text = await res.text();
    let parsed: unknown = text;
    const ct = res.headers.get('Content-Type') ?? '';
    if (ct.includes('application/json') && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // leave as text
      }
    }
    return { status: res.status, headers: res.headers, body: parsed, text };
  };

  return { fetch, request };
}
