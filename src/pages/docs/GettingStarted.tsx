import { Link } from 'react-router-dom';
import { DocLead, DocSection } from './DocsLayout';

export default function GettingStarted() {
  return (
    <>
      <DocLead
        kicker="01 · Start here"
        title="Getting started"
        intro="whatsacc gets you from 'I'd like to text my gate open' to actually doing it in about an evening — assuming the controller hardware is mounted. Here's the path."
      />

      <DocSection heading="What you'll need">
        <ul className="list-disc pl-6 space-y-2">
          <li>A gate, door or barrier with a dry-contact relay input.</li>
          <li>A whatsacc ACC controller, or a supported third-party controller.</li>
          <li>A WhatsApp number that you control (most setups use a fresh one).</li>
          <li>10 minutes of ladder time to wire the controller in parallel with your existing motor.</li>
        </ul>
      </DocSection>

      <DocSection heading="The five steps">
        <ol className="list-decimal pl-6 space-y-3">
          <li><Link to="/signup" className="underline underline-offset-4 decoration-terracotta">Create an account</Link>. Free plan is real — no credit card.</li>
          <li><Link to="/docs/linking-whatsapp" className="underline underline-offset-4 decoration-terracotta">Link your WhatsApp number</Link>. We&rsquo;ll walk you through verification.</li>
          <li><Link to="/docs/locations" className="underline underline-offset-4 decoration-terracotta">Create a Location</Link>. House, complex, building, or other.</li>
          <li><Link to="/docs/pairing-device" className="underline underline-offset-4 decoration-terracotta">Pair a Device</Link>. Scan the QR on the controller, name it, assign it to an access point.</li>
          <li>Send your first <code>open</code>. The reply tells you what happened, in plain language.</li>
        </ol>
      </DocSection>

      <DocSection heading="A note on commands">
        <p>
          The default trigger word is <code>open</code>, but we accept any phrase you configure
          per location. People text things like <em>oop</em>, <em>hey gate</em>, <em>buzz me in</em>, or just
          a single thumbs-up emoji. If it&rsquo;s on your allow-list, it works.
        </p>
      </DocSection>
    </>
  );
}
