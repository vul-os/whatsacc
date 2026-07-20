import { DocLead, DocSection, CodeBlock } from './DocsLayout';

export default function ApiReference() {
  return (
    <>
      <DocLead
        kicker="03 · Reference"
        title="API reference"
        intro="The HTTP API isn't required to use lintel — most users only ever touch the WhatsApp interface. But if you're integrating with property management software, building a kiosk, or wiring a Slack bot, this is for you. JSON in, JSON out, REST-shaped, no GraphQL."
      />

      <DocSection heading="Base URL">
        <p>
          lintel is self-hosted, so the base URL is wherever <em>you</em> deployed the
          gateway. Every example below uses a placeholder — substitute your own host.
        </p>
        <CodeBlock lang="plain">{`Your gateway   https://<your-gateway>/v1
Local dev      http://localhost:8080/v1  (default -listen for ./gateway)`}</CodeBlock>
      </DocSection>

      <DocSection heading="Authentication">
        <p>
          Tokens are scoped to specific locations and roles. Carry them in the{' '}
          <code>Authorization</code> header on every request. A{' '}
          <strong>Settings → API tokens</strong> screen in the dashboard is <em>planned</em> —
          until it lands, tokens are provisioned on the gateway itself.
        </p>
        <CodeBlock lang="http" title="every request">{`Authorization: Bearer lintel_live_xxxxxxxxxxxxxxxx
Accept: application/json`}</CodeBlock>
        <p>
          Token prefixes:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li><code>lintel_live_</code> — production traffic, opens real gates.</li>
          <li><code>lintel_test_</code> — sandbox, never opens a real gate.</li>
          <li><code>lintel_dev_</code> — device-to-gateway session token, cycles automatically.</li>
        </ul>
      </DocSection>

      <DocSection heading="Errors">
        <p>
          All errors share one shape. The <code>error</code> code is stable; the <code>detail</code>
          is human-readable and may change over time.
        </p>
        <CodeBlock lang="json">{`{
  "error": "invalid_token",
  "detail": "Token missing, malformed, or revoked."
}`}</CodeBlock>
        <p>Common codes you can program against:</p>
        <CodeBlock lang="plain">{`401  invalid_token              token missing, malformed, or revoked
403  not_account_admin          token doesn't have the required role
404  not_found                  lookup miss for an event / resource id
400  validation_error           shape doesn't match the schema (issues[] included)
429  rate_limited               cool down + retry; never affects opens
500  internal_error             check your gateway logs; the request id is in X-Request-Id`}</CodeBlock>
      </DocSection>

      <DocSection heading="Open an access point">
        <p>The bread-and-butter endpoint. Same code path as a WhatsApp <em>open</em>.</p>
        <CodeBlock lang="bash" title="curl">{`curl -X POST https://<your-gateway>/v1/access-points/ap_ABC123/open \\
  -H "Authorization: Bearer lintel_live_xxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "actor": { "phone": "+27825550144" }
  }'`}</CodeBlock>
        <CodeBlock lang="ts" title="TypeScript (fetch)">{`const r = await fetch(
  'https://<your-gateway>/v1/access-points/ap_ABC123/open',
  {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${process.env.LINTEL_TOKEN}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      actor: { phone: '+27825550144' },
    }),
  },
);
const event = await r.json();`}</CodeBlock>
        <CodeBlock lang="python" title="Python (requests)">{`import os, requests

r = requests.post(
    "https://<your-gateway>/v1/access-points/ap_ABC123/open",
    headers={"Authorization": f"Bearer {os.environ['LINTEL_TOKEN']}"},
    json={
        "actor": {"phone": "+27825550144"},
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
        "actor": map[string]string{"phone": "+27825550144"},
    })
    req, _ := http.NewRequest(
        "POST",
        "https://<your-gateway>/v1/access-points/ap_ABC123/open",
        bytes.NewReader(body),
    )
    req.Header.Set("Authorization", "Bearer "+os.Getenv("LINTEL_TOKEN"))
    req.Header.Set("Content-Type", "application/json")
    return http.DefaultClient.Do(req)
}`}</CodeBlock>
        <CodeBlock lang="json" title="200 OK">{`{
  "event_id": "ev_01HZ4B7Q2K7VJ",
  "status": "succeeded",
  "opened_at": "2026-05-14T14:02:11.842Z",
  "latency_ms": 1834
}`}</CodeBlock>
      </DocSection>

      <DocSection heading="List events">
        <p>
          Read-only feed of everything that has happened on a location, paginated. Filterable by
          <code> kind</code>, <code>actor</code>, <code>since</code>, <code>until</code>.
        </p>
        <CodeBlock lang="bash">{`curl -G https://<your-gateway>/v1/events \\
  -H "Authorization: Bearer lintel_live_xxxxxxxxxxxxxxxx" \\
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

      <DocSection heading="Webhooks (proposed, not implemented)">
        <p>
          There is no outbound webhook/subscription system in the gateway today — nothing
          below can be configured or called yet. This is the intended design: subscribe to
          <code> open.succeeded</code>, <code>open.denied</code>,
          <code> device.offline</code>, <code>device.online</code>, and <code>member.revoked</code>,
          with payloads signed HMAC-SHA256 and verified against a shared secret shown when
          you create the subscription. Kept here as the target shape.
        </p>
        <CodeBlock lang="ts" title="Verify a webhook (Node / Hono)">{`import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyLintelWebhook(rawBody: string, signature: string, secret: string) {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}`}</CodeBlock>
        <CodeBlock lang="python" title="Verify a webhook (Python / Flask)">{`import hmac, hashlib

def verify_lintel_webhook(raw_body: bytes, signature: str, secret: str) -> bool:
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
          The open path itself is rate-limited — cooldowns, hourly caps, and any admin-set
          daily quotas — enforced at one choke point shared by the portal, the API and every
          chat channel, so no path can be picked to bypass it. A denied open returns{' '}
          <code>429</code> with a <code>Retry-After</code> header; the reason lands in{' '}
          <code>error</code>. See <a
            href="https://github.com/vul-os/lintel/blob/main/site/docs/limits.md"
            className="underline underline-offset-4 decoration-terracotta"
          >Rate limits &amp; quotas</a> for the exact defaults. A separate, generic
          per-token throttle across the rest of the HTTP API (with <code>X-RateLimit-*</code>{' '}
          headers) is a reasonable future addition but doesn&rsquo;t exist yet — don&rsquo;t
          program against those headers today.
        </p>
        <CodeBlock lang="http" title="response when the open path is limited">{`HTTP/1.1 429 Too Many Requests
Retry-After: 12
Content-Type: application/json

{ "error": "rate_limited", "detail": "Slow down and try again shortly." }`}</CodeBlock>
      </DocSection>

      <DocSection heading="SDK (preview)">
        <p>
          A first-party TypeScript SDK is planned. Until it lands in npm, the recommended path is
          a small wrapper around <code>fetch</code>:
        </p>
        <CodeBlock lang="ts" title="lib/lintel.ts">{`export class Lintel {
  constructor(
    private token: string,
    private base = 'https://<your-gateway>/v1',
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
}
export interface OpenEvent {
  event_id: string;
  status: 'succeeded' | 'denied' | 'queued';
  opened_at: string;
  latency_ms: number;
}`}</CodeBlock>
      </DocSection>
    </>
  );
}
