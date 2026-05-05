import { DocLead, DocSection, CodeBlock } from './DocsLayout';

export default function ApiReference() {
  return (
    <>
      <DocLead
        kicker="03 · Reference"
        title="API reference"
        intro="The HTTP API isn't required to use whatsacc — most users only ever touch the WhatsApp interface. But if you're integrating with property management software, this is for you."
      />

      <DocSection heading="Authentication">
        <p>
          Issue tokens from the dashboard under <strong>Settings → API tokens</strong>. Tokens
          are scoped to specific locations.
        </p>
        <CodeBlock>{`Authorization: Bearer wacc_live_<token>`}</CodeBlock>
      </DocSection>

      <DocSection heading="Open an access point">
        <CodeBlock>{`POST /v1/access-points/:id/open

{
  "actor": { "phone": "+27825550144" },
  "location_signal": { "lat": -33.918, "lng": 18.423 }
}`}</CodeBlock>
      </DocSection>

      <DocSection heading="List events">
        <CodeBlock>{`GET /v1/events?location=loc_oak&since=2026-05-01

200 OK
{
  "events": [
    { "id": "ev_...", "kind": "open", "at": "2026-05-04T14:02:11Z", ... }
  ]
}`}</CodeBlock>
      </DocSection>

      <DocSection heading="Webhooks">
        <p>
          Subscribe to <code>open.succeeded</code>, <code>open.denied</code>, <code>device.offline</code>,
          and <code>member.revoked</code>. Payloads are signed with HMAC-SHA256. Verify with the
          shared secret shown when you create the subscription.
        </p>
      </DocSection>

      <DocSection heading="Rate limits">
        <p>
          1,000 requests / minute per token, soft. We&rsquo;ll never deny an open because of rate
          limits — those are routed to a separate fast path.
        </p>
      </DocSection>
    </>
  );
}
