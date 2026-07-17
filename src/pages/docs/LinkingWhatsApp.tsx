import { DocLead, DocSection, CodeBlock } from './DocsLayout';

export default function LinkingWhatsApp() {
  return (
    <>
      <DocLead
        kicker="01 · Start here"
        title="Linking your WhatsApp number"
        intro="whatsacc speaks to residents through a WhatsApp number that belongs to you. This is the number people text 'open' to. Here's how to set one up — and how to choose between a personal number and a dedicated one."
      />

      <DocSection heading="Personal vs. dedicated number">
        <p>
          You can either link your <strong>existing personal WhatsApp number</strong>, or — recommended for
          anything beyond a single house — a <strong>dedicated number</strong> for the property.
        </p>
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>Personal</strong>: zero friction, but residents see your profile picture, status and "last seen". Fine for a holiday house.</li>
          <li><strong>Dedicated</strong>: a clean brand presence — display name, photo, business hours all controlled by you. Required at scale because programmatic replies need WhatsApp Business.</li>
        </ul>
        <p>
          For a fresh number, most users buy a prepaid SIM (R10–R50 in ZA) or a virtual number from a
          provider like Vonage or Twilio, then register it once with WhatsApp Business in the official
          app.
        </p>
      </DocSection>

      <DocSection heading="The link flow">
        <ol className="list-decimal pl-6 space-y-3">
          <li>In the dashboard, go to <strong>Settings → WhatsApp</strong> and click <em>Link a number</em>.</li>
          <li>You&rsquo;ll receive a 6-digit code. Reply to the gateway&rsquo;s verification message with that code from the number you want to link. The gateway never stores your message contents.</li>
          <li>Within a few seconds the dashboard flips to <em>Linked</em>. The number is now your control channel.</li>
        </ol>
        <p>
          The verification challenge is rate-limited and the code expires after 5 minutes. If your
          first attempt times out, just request a new one — there&rsquo;s no penalty.
        </p>
      </DocSection>

      <DocSection heading="What gets stored">
        <p>
          Linking a number persists this much, and nothing else:
        </p>
        <CodeBlock lang="json" title="profile_phone_numbers row">{`{
  "id": "ph_01HZ3X…",
  "phone_e164": "+27821234567",
  "is_primary": true,
  "verified_at": "2026-05-14T09:21:04Z"
}`}</CodeBlock>
        <p>
          The gateway doesn&rsquo;t store messages, conversation history, contacts, or media. Inbound messages
          flow through a stateless pipeline that classifies the intent, fires the relay, and writes
          one event row.
        </p>
      </DocSection>

      <DocSection heading="If the link fails">
        <p>
          The most common cause is that the WhatsApp number isn&rsquo;t registered with WhatsApp
          Business. Switch the number from regular WhatsApp to WhatsApp Business in the official
          app, then retry the link. Personal-only numbers are not supported because they don&rsquo;t
          allow programmatic replies.
        </p>
        <p>Other common reasons:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>Wrong country code.</strong> Numbers must be in E.164 format with the leading <code>+</code>.</li>
          <li><strong>Already linked elsewhere.</strong> A WhatsApp number can only be the primary on one whatsacc account at a time.</li>
          <li><strong>Slow network at the gate.</strong> If your controller is on flaky LTE, verification can complete but the first <em>open</em> times out — the controller will resync within a minute and subsequent opens are normal.</li>
        </ul>
      </DocSection>

      <DocSection heading="Programmatic check">
        <p>
          You can confirm a number is linked + verified via the API at any time:
        </p>
        <CodeBlock lang="bash">{`curl -H "Authorization: Bearer wacc_live_xxxxxxxxxxxxxxxx" \\
  https://<your-gateway>/v1/phones/me`}</CodeBlock>
        <CodeBlock lang="json">{`{
  "phones": [
    {
      "phone_e164": "+27821234567",
      "is_primary": true,
      "verified_at": "2026-05-14T09:21:04Z"
    }
  ]
}`}</CodeBlock>
      </DocSection>
    </>
  );
}
