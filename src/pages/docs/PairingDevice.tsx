import { DocLead, DocSection, CodeBlock } from './DocsLayout';

export default function PairingDevice() {
  return (
    <>
      <DocLead
        kicker="02 · Concepts"
        title="Pairing a Device"
        intro="A Device is the controller box that physically opens your gate. Pairing binds it to a specific access point on a specific location, and gives it its own signing key. Done once per device, takes about a minute."
      />

      <DocSection heading="What you'll see in the box">
        <ul className="list-disc pl-6 space-y-2">
          <li>The whatsacc ACC controller — a sealed box about the size of a deck of cards (IP65).</li>
          <li>A short pigtail with two bare leads for the relay output.</li>
          <li>A QR-code sticker on the back of the controller.</li>
          <li>A 12 V power adapter — most installs share the gate motor&rsquo;s 12 V supply instead.</li>
        </ul>
      </DocSection>

      <DocSection heading="Wiring (in 30 seconds)">
        <p>
          The controller&rsquo;s relay sits in <strong>parallel</strong> with your existing remote
          receiver&rsquo;s relay. Find the two leads on your gate motor that the remote pulses
          (often labelled <code>COM</code> and <code>NO</code>). Tap into them. That&rsquo;s the
          entire wiring job.
        </p>
        <p>For 24 V or AC motors, use the included optoisolator pigtail. Don&rsquo;t skip this
          step — the bare relay is rated 30 V DC max.
        </p>
        <CodeBlock lang="plain" title="Diagram">{`     ┌───────────────┐
     │  Gate motor   │
     │   COM   NO    │
     │    │    │     │
     │    └─┐  ┌─┐   │
     │      │  │ │   │   ┌─────────────┐
     │      └──┴─┴───┼───┤ ACC relay   │
     │   (existing   │   │  COM    NO  │
     │    receiver)  │   └─────────────┘
     └───────────────┘`}</CodeBlock>
      </DocSection>

      <DocSection heading="Pairing in the app">
        <ol className="list-decimal pl-6 space-y-3">
          <li>Open <strong>Devices → Pair new</strong>.</li>
          <li>Scan the QR code on the controller. The app fetches the device public key.</li>
          <li>Pick the access point you wired it to (e.g. <em>Sunset Apartments · Main gate</em>).</li>
          <li>Power the controller. Its LED pulses orange while it negotiates a session, then turns solid green.</li>
          <li>Hit <em>Send test pulse</em>. If the gate moves, you&rsquo;re done.</li>
        </ol>
      </DocSection>

      <DocSection heading="LED reference">
        <CodeBlock lang="plain">{`solid green     online, idle, ready
blink green     pulsing relay (during open)
solid orange    paired but offline (no network)
blink orange    unpaired, waiting for QR scan
solid red       firmware fault — power-cycle to recover
blink red       relay miswired or short detected`}</CodeBlock>
      </DocSection>

      <DocSection heading="Under the hood">
        <p>
          Each device has a unique <strong>Ed25519 keypair</strong> generated on first boot. The
          public key is uploaded during pairing; the private key never leaves the device. Open
          commands are signed with a sliding nonce, so a captured packet can&rsquo;t be replayed.
        </p>
        <CodeBlock lang="http" title="device → gateway">{`POST /v1/devices/dev_oak_main/open HTTP/1.1
Host: your-gateway.example.com
Authorization: Bearer wacc_dev_session_xxxxxxxxxxxx
Content-Type: application/json

{
  "nonce": "01HZ4B7Q2K7VJABX",
  "issued_at": 1778753320,
  "signature": "ed25519:dN3w…/L8w=="
}`}</CodeBlock>
        <p>
          The gateway verifies the signature, checks the nonce hasn&rsquo;t been used in the last
          120 seconds, and only then commits the open event. If verification fails, the request is
          dropped without a relay pulse <em>and</em> an audit row is written so the controller
          appears in your tamper-detection feed.
        </p>
      </DocSection>

      <DocSection heading="Re-pairing &amp; rotation">
        <p>
          You can re-pair a device at any time (e.g. moving it to another access point) — old
          sessions are revoked atomically and the device is forced to renegotiate. Keys are rotated
          automatically every 90 days. No action is required.
        </p>
      </DocSection>
    </>
  );
}
