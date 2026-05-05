import { DocLead, DocSection } from './DocsLayout';

export default function GeofenceSafety() {
  return (
    <>
      <DocLead
        kicker="02 · Concepts"
        title="Geofence safety"
        intro="A geofence stops people from opening your gate when they're nowhere near it. It's optional. We turn it off by default because most homeowners don't want it. We turn it on by default for complexes."
      />

      <DocSection heading="How it works">
        <p>
          When geofence is enabled on a location, every open request must include a recent
          location signal from the sender. whatsacc accepts two sources:
        </p>
        <ul className="list-disc pl-6 space-y-2">
          <li>A WhatsApp shared location attached to the open message.</li>
          <li>A live-location ping the user has shared with whatsacc within the last 5 minutes.</li>
        </ul>
        <p>
          If the latitude/longitude is outside the configured radius, we return a polite
          decline message and write the verdict to the audit log. The actual GPS distance is
          recorded so admins can investigate.
        </p>
      </DocSection>

      <DocSection heading="Choosing a radius">
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>50 m</strong> — very strict. People must be at the gate already.</li>
          <li><strong>200 m</strong> — sane default for complexes. Catches most cars approaching.</li>
          <li><strong>1 km</strong> — relaxed. Useful when residents start the open from the freeway off-ramp.</li>
        </ul>
      </DocSection>

      <DocSection heading="Edge cases we handle">
        <ul className="list-disc pl-6 space-y-2">
          <li>Phones with deliberately spoofed location are flagged via WhatsApp&rsquo;s metadata, but we don&rsquo;t lean on it as the only check — that&rsquo;s why combined with phone-number identity it&rsquo;s a meaningful layer, not a magic one.</li>
          <li>If the user has no location attached and geofence is enabled, the gate stays shut and we ask them to share location.</li>
          <li>If the device is offline when the open succeeds, we queue the command for 30 seconds.</li>
        </ul>
      </DocSection>
    </>
  );
}
