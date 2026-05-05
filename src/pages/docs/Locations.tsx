import { DocLead, DocSection } from './DocsLayout';

export default function LocationsDoc() {
  return (
    <>
      <DocLead
        kicker="02 · Concepts"
        title="Creating a Location"
        intro="A Location is the physical place whatsacc protects. Everything else — access points, devices, members, geofences — hangs off it."
      />

      <DocSection heading="The four kinds">
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>House</strong> — a single residence. Typically one access point.</li>
          <li><strong>Complex</strong> — a residential estate. Can contain houses as nested locations and have multiple access points (main gate, pedestrian, parking).</li>
          <li><strong>Building</strong> — an apartment block or office. Doors, lobbies, parking barriers.</li>
          <li><strong>Other</strong> — workshops, warehouses, storage yards, anything else.</li>
        </ul>
      </DocSection>

      <DocSection heading="Nesting">
        <p>
          A complex can contain houses. A house belongs to one complex. Members of the complex
          do not automatically get access to its child houses — that&rsquo;s by design. The
          opposite is also true.
        </p>
        <p>
          You can move a house between complexes without re-pairing devices. Members and roles
          travel with the house, not the complex.
        </p>
      </DocSection>

      <DocSection heading="Creating one">
        <ol className="list-decimal pl-6 space-y-3">
          <li>From the dashboard sidebar, click <strong>Locations</strong> then <em>New location</em>.</li>
          <li>Pick the kind, give it a name (residents see this), and a city.</li>
          <li>Optional: drop a pin on the map. This anchors the geofence if you turn it on later.</li>
          <li>You&rsquo;re ready to add an access point.</li>
        </ol>
      </DocSection>
    </>
  );
}
