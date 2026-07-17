// Outbound HTTP interception for provider sends (Meta Graph, Slack, Telegram).
//
// The suites boot the real Hono app in-process (app.fetch), so globalThis.fetch
// is only ever reached by the outbound send libs (src/lib/whatsapp.ts,
// src/lib/slack.ts, src/lib/telegram.ts) — email is short-circuited by
// APP_ENV=test in tests/helpers/app.ts. Replacing globalThis.fetch here both
// captures the exact payloads sent to each provider (so tests can assert the
// conversational contract) and guarantees the tests never perform real
// network I/O. Any fetch to an unrecognized host throws, so an accidental
// real outbound call fails the test instead of silently escaping.

export type OutboundCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Request body, JSON-parsed when possible, otherwise the raw string. */
  body: unknown;
};

export type OutboundIntercept = {
  /** All captured calls, in send order. */
  calls: OutboundCall[];
  /** Captured calls whose URL contains the given substring. */
  to(urlPart: string): OutboundCall[];
  /** Reinstall the real fetch. Always call from finally. */
  restore(): void;
};

/**
 * Replace globalThis.fetch with a recorder that answers provider endpoints
 * with canned success responses:
 *
 *   graph.facebook.com  → { messages: [{ id: 'wamid.mock-N' }] }
 *   slack.com/api/      → { ok: true, ts: 'mock.N' }
 *   api.telegram.org    → { ok: true, result: { message_id: N } }
 */
export function interceptOutbound(): OutboundIntercept {
  const realFetch = globalThis.fetch;
  const calls: OutboundCall[] = [];
  let seq = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    const method = (req?.method ?? init?.method ?? 'GET').toUpperCase();

    let bodyText = '';
    if (req) bodyText = await req.clone().text();
    else if (typeof init?.body === 'string') bodyText = init.body;

    let body: unknown = bodyText;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        // leave as text (e.g. form-encoded)
      }
    }

    const headers: Record<string, string> = {};
    new Headers(req?.headers ?? init?.headers ?? {}).forEach((v, k) => {
      headers[k] = v;
    });

    calls.push({ url, method, headers, body });
    seq += 1;

    if (url.includes('graph.facebook.com')) {
      return Response.json({ messages: [{ id: `wamid.mock-${seq}` }] });
    }
    if (url.includes('slack.com/api/')) {
      return Response.json({ ok: true, ts: `mock.${seq}` });
    }
    if (url.includes('api.telegram.org')) {
      return Response.json({ ok: true, result: { message_id: seq } });
    }
    throw new Error(`unexpected outbound fetch in tests: ${method} ${url}`);
  }) as typeof fetch;

  return {
    calls,
    to: (urlPart: string) => calls.filter((c) => c.url.includes(urlPart)),
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}
