import { DocLead, DocSection, CodeBlock } from './DocsLayout';

export default function ApiReference() {
  return (
    <>
      <DocLead
        kicker="03 · Reference"
        title="API reference"
        intro="The HTTP API isn't required to use whatsacc — most users only ever touch the WhatsApp interface. But if you're integrating with property management software, building a kiosk, or wiring a Slack bot, this is for you. JSON in, JSON out, REST-shaped, no GraphQL."
      />

      <DocSection heading="Base URL">
        <CodeBlock lang="plain">{`Production    https://api.whatsacc.com/v1
Dev sandbox   https://api-dev.whatsacc.com/v1`}</CodeBlock>
      </DocSection>

      <DocSection heading="Authentication">
        <p>
          Issue tokens from the dashboard under <strong>Settings → API tokens</strong>. Tokens
          are scoped to specific locations and roles. Carry them in the <code>Authorization</code>
          header on every request.
        </p>
        <CodeBlock lang="http" title="every request">{`Authorization: Bearer wacc_live_xxxxxxxxxxxxxxxx
Accept: application/json`}</CodeBlock>
        <p>
          Token prefixes:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li><code>wacc_live_</code> — production traffic, billed.</li>
          <li><code>wacc_test_</code> — sandbox, never opens a real gate.</li>
          <li><code>wacc_dev_</code> — device-to-cloud session token, cycles automatically.</li>
        </ul>
      </DocSection>

      <DocSection heading="Errors">
        <p>
          All errors share one shape. The <code>error</code> code is stable; the <code>detail</code>
          is human-readable and may change over time.
        </p>
        <CodeBlock lang="json">{`{
  "error": "card_required",
  "detail": "No saved card. Use subscription-checkout to add one."
}`}</CodeBlock>
        <p>Common codes you can program against:</p>
        <CodeBlock lang="plain">{`401  invalid_token              token missing, malformed, or revoked
403  not_account_admin          token doesn't have the required role
404  intent_not_found           lookup miss for a payment intent / event id
400  validation_error           shape doesn't match the schema (issues[] included)
400  already_on_plan            no-op plan switch
400  card_required              paid plan but no saved card
400  card_declined              Paystack rejected the charge
429  rate_limited               cool down + retry; never affects opens
500  internal_error             page us; the request id is in X-Request-Id`}</CodeBlock>
      </DocSection>

      <DocSection heading="Open an access point">
        <p>The bread-and-butter endpoint. Same code path as a WhatsApp <em>open</em>.</p>
        <CodeBlock lang="bash" title="curl">{`curl -X POST https://api.whatsacc.com/v1/access-points/ap_ABC123/open \\
  -H "Authorization: Bearer wacc_live_xxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "actor": { "phone": "+27825550144" },
    "location_signal": { "lat": -33.918, "lng": 18.423 }
  }'`}</CodeBlock>
        <CodeBlock lang="ts" title="TypeScript (fetch)">{`const r = await fetch(
  'https://api.whatsacc.com/v1/access-points/ap_ABC123/open',
  {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${process.env.WACC_TOKEN}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      actor: { phone: '+27825550144' },
      location_signal: { lat: -33.918, lng: 18.423 },
    }),
  },
);
const event = await r.json();`}</CodeBlock>
        <CodeBlock lang="python" title="Python (requests)">{`import os, requests

r = requests.post(
    "https://api.whatsacc.com/v1/access-points/ap_ABC123/open",
    headers={"Authorization": f"Bearer {os.environ['WACC_TOKEN']}"},
    json={
        "actor": {"phone": "+27825550144"},
        "location_signal": {"lat": -33.918, "lng": 18.423},
    },
    timeout=10,
)
r.raise_for_status()
event = r.json()`}</CodeBlock>
        <CodeBlock lang="go" title="Go (net/http)">{`package main

import (
    "bytes"
    "encoding/json"
    "net/http"
    "os"
)

func openGate() (*http.Response, error) {
    body, _ := json.Marshal(map[string]any{
        "actor":           map[string]string{"phone": "+27825550144"},
        "location_signal": map[string]float64{"lat": -33.918, "lng": 18.423},
    })
    req, _ := http.NewRequest(
        "POST",
        "https://api.whatsacc.com/v1/access-points/ap_ABC123/open",
        bytes.NewReader(body),
    )
    req.Header.Set("Authorization", "Bearer "+os.Getenv("WACC_TOKEN"))
    req.Header.Set("Content-Type", "application/json")
    return http.DefaultClient.Do(req)
}`}</CodeBlock>
        <CodeBlock lang="json" title="200 OK">{`{
  "event_id": "ev_01HZ4B7Q2K7VJ",
  "status": "succeeded",
  "opened_at": "2026-05-14T14:02:11.842Z",
  "latency_ms": 1834,
  "policy_checks": {
    "geofence": "ok",
    "schedule": "ok"
  }
}`}</CodeBlock>
      </DocSection>

      <DocSection heading="List events">
        <p>
          Read-only feed of everything that has happened on a location, paginated. Filterable by
          <code> kind</code>, <code>actor</code>, <code>since</code>, <code>until</code>.
        </p>
        <CodeBlock lang="bash">{`curl -G https://api.whatsacc.com/v1/events \\
  -H "Authorization: Bearer wacc_live_xxxxxxxxxxxxxxxx" \\
  --data-urlencode "location=loc_oak" \\
  --data-urlencode "since=2026-05-01" \\
  --data-urlencode "kind=open.succeeded"`}</CodeBlock>
        <CodeBlock lang="json">{`{
  "events": [
    {
      "id": "ev_01HZ4B7Q2K7VJ",
      "kind": "open.succeeded",
      "actor": { "phone": "+27825550144" },
      "access_point_id": "ap_ABC123",
      "at": "2026-05-04T14:02:11Z",
      "latency_ms": 1834
    }
  ],
  "next_cursor": "evc_01HZ4G…"
}`}</CodeBlock>
      </DocSection>

      <DocSection heading="Webhooks">
        <p>
          Subscribe to <code>open.succeeded</code>, <code>open.denied</code>,
          <code> device.offline</code>, <code>device.online</code>, and <code>member.revoked</code>.
          Payloads are signed with HMAC-SHA256 — verify with the shared secret shown when you
          create the subscription.
        </p>
        <CodeBlock lang="ts" title="Verify a webhook (Node / Hono)">{`import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWaccWebhook(rawBody: string, signature: string, secret: string) {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}`}</CodeBlock>
        <CodeBlock lang="python" title="Verify a webhook (Python / Flask)">{`import hmac, hashlib

def verify_wacc_webhook(raw_body: bytes, signature: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)`}</CodeBlock>
        <CodeBlock lang="json" title="open.succeeded payload">{`{
  "id": "wh_01HZ4G…",
  "type": "open.succeeded",
  "delivered_at": "2026-05-14T14:02:13Z",
  "data": {
    "event_id": "ev_01HZ4B7Q2K7VJ",
    "location_id": "loc_oak",
    "access_point_id": "ap_ABC123",
    "actor": { "phone": "+27825550144" },
    "latency_ms": 1834
  }
}`}</CodeBlock>
      </DocSection>

      <DocSection heading="Rate limits">
        <p>
          1,000 requests / minute per token, soft. We never deny an open because of rate limits —
          those are routed through a separate fast path with its own budget. The HTTP API will
          return <code>429</code> with a <code>Retry-After</code> header for everything else.
        </p>
        <CodeBlock lang="http" title="response when limited">{`HTTP/1.1 429 Too Many Requests
Retry-After: 12
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1778753400
Content-Type: application/json

{ "error": "rate_limited", "detail": "Slow down — 1000/minute on this token." }`}</CodeBlock>
      </DocSection>

      <DocSection heading="SDK (preview)">
        <p>
          A first-party TypeScript SDK is in beta. Until it lands in npm, the recommended path is
          a small wrapper around <code>fetch</code>:
        </p>
        <CodeBlock lang="ts" title="lib/wacc.ts">{`export class Wacc {
  constructor(
    private token: string,
    private base = 'https://api.whatsacc.com/v1',
  ) {}

  async open(accessPointId: string, body: OpenBody): Promise<OpenEvent> {
    const r = await fetch(\`\${this.base}/access-points/\${accessPointId}/open\`, {
      method: 'POST',
      headers: {
        Authorization: \`Bearer \${this.token}\`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await r.json();
    return await r.json();
  }
}

export interface OpenBody {
  actor: { phone: string };
  location_signal?: { lat: number; lng: number };
}
export interface OpenEvent {
  event_id: string;
  status: 'succeeded' | 'denied' | 'queued';
  opened_at: string;
  latency_ms: number;
  policy_checks: Record<string, 'ok' | 'denied' | 'skipped'>;
}`}</CodeBlock>
      </DocSection>
    </>
  );
}
