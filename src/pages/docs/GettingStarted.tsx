import { Link } from 'react-router-dom';
import { DocLead, DocSection, CodeBlock } from './DocsLayout';

export default function GettingStarted() {
  return (
    <>
      <DocLead
        kicker="01 · Start here"
        title="Getting started"
        intro="whatsacc gets you from 'I'd like to text my gate open' to actually doing it in about an evening — assuming the controller hardware is mounted. Here's the full path."
      />

      <DocSection heading="What you'll need">
        <ul className="list-disc pl-6 space-y-2">
          <li>A gate, door or barrier with a <strong>dry-contact relay input</strong> (almost every motorised gate built since 2005 has one).</li>
          <li>A <strong>whatsacc ACC controller</strong>, or a supported third-party controller (Centurion, BFT, Came, Nice, ET Blue).</li>
          <li>A <strong>WhatsApp number</strong> that you control (most setups use a fresh secondary line).</li>
          <li>About <strong>10 minutes of ladder time</strong> to wire the controller in parallel with your existing motor.</li>
          <li>Wi-Fi or LTE coverage at the gate (LTE controllers ship with a Vodacom-roaming SIM by default in ZA).</li>
        </ul>
      </DocSection>

      <DocSection heading="The five steps">
        <ol className="list-decimal pl-6 space-y-3">
          <li><Link to="/signup" className="underline underline-offset-4 decoration-terracotta">Create an account</Link> on your gateway. Free — whatsacc has no plans and no billing.</li>
          <li><Link to="/docs/linking-whatsapp" className="underline underline-offset-4 decoration-terracotta">Link your WhatsApp number</Link>. We&rsquo;ll walk you through verification.</li>
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
whatsacc 14:02   ✅ Front gate opening — Sunset Apartments
                 1.8s · GPS within 240 m · audited as ev_01HZ…

You      14:09   close
whatsacc 14:09   🔒 Front gate closing — Sunset Apartments`}</CodeBlock>
        <p>
          The trigger word is configurable per location. People text things like <em>oop</em>,
          <em> hey gate</em>, <em>buzz me in</em>, or just a thumbs-up emoji. If the phrase is on
          the allow-list for your role, it works.
        </p>
      </DocSection>

      <DocSection heading="What happens behind a single 'open'">
        <p>
          Every message that reaches whatsacc goes through the same five-step pipeline before
          we send a relay pulse:
        </p>
        <ol className="list-decimal pl-6 space-y-2">
          <li><strong>Verify the sender</strong>. The WhatsApp number must match a member or invited guest.</li>
          <li><strong>Resolve the location</strong>. We pick the right gate using your role and (if enabled) GPS.</li>
          <li><strong>Check the schedule</strong>. Time-of-day window, day-of-week, expiring guest grants.</li>
          <li><strong>Pulse the relay</strong>. The controller fires for the configured contact time (250 ms default).</li>
          <li><strong>Audit + reply</strong>. Every event is logged and you get a one-line confirmation.</li>
        </ol>
        <p className="text-ink/55 text-[14px]">
          Median open latency is <strong>1.8 seconds</strong>, end-to-end, in South Africa.
        </p>
      </DocSection>

      <DocSection heading="Quick CLI sanity check (optional)">
        <p>
          If you have an API token (Settings → API tokens), you can fire an open without WhatsApp.
          Useful for dashboards, integrations, and ops health checks:
        </p>
        <CodeBlock lang="bash" title="curl">{`# replace ap_ABC123 with your access point id and wacc_live_… with your token
curl -X POST https://api.whatsacc.com/v1/access-points/ap_ABC123/open \\
  -H "Authorization: Bearer wacc_live_xxxxxxxxxxxxxxxx" \\
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
          <li><Link to="/docs/permissions-members" className="underline underline-offset-4 decoration-terracotta">Invite members &amp; set roles</Link> — owners, admins, residents, guests.</li>
          <li><Link to="/docs/geofence-safety" className="underline underline-offset-4 decoration-terracotta">Geofence safety</Link> — only allow opens when the sender is physically near.</li>
          <li><Link to="/docs/api-reference" className="underline underline-offset-4 decoration-terracotta">API reference</Link> — REST + webhooks for integrations.</li>
        </ul>
      </DocSection>
    </>
  );
}
