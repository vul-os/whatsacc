import { DocLead, DocSection } from './DocsLayout';

export default function LinkingWhatsApp() {
  return (
    <>
      <DocLead
        kicker="01 · Start here"
        title="Linking your WhatsApp number"
        intro="whatsacc speaks to residents through a WhatsApp number that belongs to you. This is the number people text 'open' to. Here's how to set one up."
      />

      <DocSection heading="Two options">
        <p>
          You can either use your existing personal WhatsApp number, or — recommended — a dedicated
          number for the property. The latter is cleaner for complexes, since residents
          shouldn&rsquo;t see your personal profile picture and status.
        </p>
        <p>
          For a fresh number, most users buy a SIM (or a virtual number from a provider like
          Vonage or Twilio) and register it with WhatsApp Business once. After that, whatsacc
          handles the rest.
        </p>
      </DocSection>

      <DocSection heading="The link flow">
        <ol className="list-decimal pl-6 space-y-3">
          <li>In the dashboard, go to <strong>Settings → WhatsApp</strong> and click <em>Link a number</em>.</li>
          <li>You&rsquo;ll receive a 6-digit code. Reply to our shown verification message with that code from the number you want to link. We never store your message contents.</li>
          <li>Within a few seconds the dashboard updates to <em>Linked</em>. The number is now your control channel.</li>
        </ol>
      </DocSection>

      <DocSection heading="If the link fails">
        <p>
          The most common cause is that the WhatsApp number isn&rsquo;t registered with WhatsApp
          Business — switch the number from regular WhatsApp to WhatsApp Business in the
          official app, then retry the link. Personal-only numbers are not supported because
          they don&rsquo;t allow programmatic replies.
        </p>
      </DocSection>
    </>
  );
}
