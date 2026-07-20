import { Link } from 'react-router-dom';
import { DocLead, DocSection, CodeBlock } from './DocsLayout';

export default function GettingStarted() {
  return (
    <>
      <DocLead
        kicker="01 · Start here"
        title="Getting started"
        intro="lintel gets you from 'I'd like to text my gate open' to actually doing it in about an evening — assuming the controller hardware is mounted. Here's the full path."
      />

      <DocSection heading="What you'll need">
        <ul className="list-disc pl-6 space-y-2">
          <li>A gate, door or barrier with a <strong>dry-contact relay input</strong> (almost every motorised gate built since 2005 has one).</li>
          <li>A <strong>controller</strong> that can pulse that relay from your gateway. The lintel ACC controller is <em>in development</em>, designed for standard dry-contact gate motors (Centurion, BFT, Came, Nice, ET Blue); vendor-specific integrations are on the roadmap.</li>
          <li>A <strong>WhatsApp number</strong> that you control (most setups use a fresh secondary line).</li>
          <li>About <strong>10 minutes of ladder time</strong> to wire the controller in parallel with your existing motor.</li>
          <li>Wi-Fi or LTE coverage at the gate.</li>
        </ul>
      </DocSection>

      <DocSection heading="The five steps">
        <ol className="list-decimal pl-6 space-y-3">
          <li><Link to="/signup" className="underline underline-offset-4 decoration-terracotta">Create an account</Link> on your gateway. Free — lintel has no plans and no billing.</li>
          <li><Link to="/docs/linking-whatsapp" className="underline underline-offset-4 decoration-terracotta">Link your WhatsApp number</Link>. The dashboard walks you through verification.</li>
          <li><Link to="/docs/locations" className="underline underline-offset-4 decoration-terracotta">Create a Location</Link>. House, complex, building, or other.</li>
          <li><Link to="/docs/pairing-device" className="underline underline-offset-4 decoration-terracotta">Pair a Device</Link>. Scan the QR on the controller, name it, assign it to an access point.</li>
          <li>Send your first <code>open</code>. The reply tells you what happened, in plain language.</li>
        </ol>
      </DocSection>

      <DocSection heading="Your first conversation">
        <p>
          Once a location has at least one access point and your number is linked, this is what
          a successful exchange looks like:
        </p>
        <CodeBlock lang="plain" title="WhatsApp">{`You      14:02   open
lintel 14:02   ✅ Front gate opening — Sunset Apartments
                 1.8s · audited as ev_01HZ…

You      14:09   close
lintel 14:09   🔒 Front gate closing — Sunset Apartments`}</CodeBlock>
        <p>
          The trigger word is configurable per location. People text things like <em>oop</em>,
          <em> hey gate</em>, <em>buzz me in</em>, or just a thumbs-up emoji. If the phrase is on
          the allow-list for your role, it works.
        </p>
      </DocSection>

      <DocSection heading="What happens behind a single 'open'">
        <p>
          Every message that reaches your gateway goes through the same five-step pipeline
          before it sends a relay pulse:
        </p>
        <ol className="list-decimal pl-6 space-y-2">
          <li><strong>Verify the sender</strong>. The WhatsApp number must match a member or invited guest.</li>
          <li><strong>Resolve the location</strong>. The gateway picks the right gate using your role.</li>
          <li><strong>Check the limits</strong>. Open cooldown, hourly caps, any admin-set daily quotas, and — for a phone that isn&rsquo;t a member — whether it holds an active, unexpired temporary access grant.</li>
          <li><strong>Pulse the relay</strong>. The controller fires for the configured contact time (250 ms default).</li>
          <li><strong>Audit + reply</strong>. Every event is logged and you get a one-line confirmation.</li>
        </ol>
        <p className="text-ink/55 text-[14px]">
          A typical open completes in <strong>about two seconds</strong> end-to-end — most of
          that is the WhatsApp round-trip.
        </p>
      </DocSection>

      <DocSection heading="Quick CLI sanity check (optional)">
        <p>
          If you have an API token (a Settings → API tokens screen is planned — see the{' '}
          <Link to="/docs/api-reference" className="underline underline-offset-4 decoration-terracotta">API reference</Link>),
          you can fire an open without WhatsApp. Useful for dashboards, integrations, and ops
          health checks:
        </p>
        <CodeBlock lang="bash" title="curl">{`# replace ap_ABC123 with your access point id and lintel_live_… with your token
curl -X POST https://<your-gateway>/v1/access-points/ap_ABC123/open \\
  -H "Authorization: Bearer lintel_live_xxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"actor":{"phone":"+27825550144"}}'`}</CodeBlock>
        <p>
          A successful response looks like:
        </p>
        <CodeBlock lang="json">{`{
  "event_id": "ev_01HZ4B7Q2K7VJ",
  "status": "succeeded",
  "opened_at": "2026-05-14T14:02:11.842Z",
  "latency_ms": 1834
}`}</CodeBlock>
      </DocSection>

      <DocSection heading="Where to next">
        <ul className="list-disc pl-6 space-y-2">
          <li><Link to="/docs/permissions-members" className="underline underline-offset-4 decoration-terracotta">Invite members &amp; set roles</Link> — owner, admin, member, viewer.</li>
          <li><Link to="/docs/geofence-safety" className="underline underline-offset-4 decoration-terracotta">Geofence safety</Link> — designed, not built yet: only allow opens when the sender is physically near.</li>
          <li><Link to="/docs/api-reference" className="underline underline-offset-4 decoration-terracotta">API reference</Link> — REST + webhooks for integrations.</li>
        </ul>
      </DocSection>
    </>
  );
}
