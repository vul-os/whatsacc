import { DocLead, DocSection, CodeBlock } from './DocsLayout';

export default function PairingDevice() {
  return (
    <>
      <DocLead
        kicker="02 · Concepts"
        title="Pairing a Device"
        intro="A Device is the controller box that physically opens your gate. Pairing binds it to a specific access point on a specific location, and gives it its own signing key."
      />

      <DocSection heading="What you'll see in the box">
        <ul className="list-disc pl-6 space-y-2">
          <li>The whatsacc ACC controller — a sealed box about the size of a deck of cards.</li>
          <li>A short cable with two bare leads for the relay output.</li>
          <li>A QR-code sticker on the back of the controller.</li>
          <li>A 12V power adapter — most installs share the gate motor&rsquo;s 12V supply instead.</li>
        </ul>
      </DocSection>

      <DocSection heading="Wiring (in 30 seconds)">
        <p>
          The controller&rsquo;s relay sits in parallel with your existing remote receiver&rsquo;s
          relay. Find the two leads on your gate motor that the remote pulses (often labelled
          <code>COM</code> and <code>NO</code>). Tap into them. That&rsquo;s the entire wiring job.
        </p>
        <p>
          For 24V or AC motors, use the included optoisolator pigtail.
        </p>
      </DocSection>

      <DocSection heading="Pairing in the app">
        <ol className="list-decimal pl-6 space-y-3">
          <li>Open <strong>Devices → Pair new</strong>.</li>
          <li>Scan the QR code on the controller. The app fetches the device public key.</li>
          <li>Pick the access point you wired it to (e.g. Oakridge · Main gate).</li>
          <li>Power the controller. Its LED pulses orange while it negotiates a session, then turns solid.</li>
          <li>Hit <em>Send test pulse</em>. If the gate moves, you&rsquo;re done.</li>
        </ol>
      </DocSection>

      <DocSection heading="Under the hood">
        <p>
          Each device has a unique keypair generated on first boot. The public key is uploaded
          during pairing; the private key never leaves the device. Open commands are signed with
          a sliding nonce, so a captured packet can&rsquo;t be replayed.
        </p>
        <CodeBlock>{`POST /v1/devices/:id/open
Authorization: Bearer <session>
Body:
{
  "nonce": "01HV...",
  "issued_at": 1735660800,
  "signature": "ed25519:..."
}`}</CodeBlock>
      </DocSection>
    </>
  );
}
