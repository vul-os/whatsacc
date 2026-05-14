import { DocLead, DocSection, CodeBlock } from './DocsLayout';

export default function LocationsDoc() {
  return (
    <>
      <DocLead
        kicker="02 · Concepts"
        title="Creating a Location"
        intro="A Location is the physical place whatsacc protects. Everything else — access points, devices, members, geofences, billing — hangs off it. Most accounts have one; estates have several with nested children."
      />

      <DocSection heading="The four kinds">
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>House</strong> — a single residence. Typically one access point.</li>
          <li><strong>Complex</strong> — a residential estate. Can contain houses as nested locations and have multiple access points (main gate, pedestrian, parking).</li>
          <li><strong>Building</strong> — an apartment block or office. Doors, lobbies, parking barriers.</li>
          <li><strong>Other</strong> — workshops, warehouses, storage yards, anything else.</li>
        </ul>
        <p className="text-ink/55 text-[14px]">
          The kind controls UI defaults (icons, billing copy, dashboard hints) but not authorisation.
          Permissions are always per-location.
        </p>
      </DocSection>

      <DocSection heading="Nesting rules">
        <p>
          A complex can contain houses. A house belongs to one complex. <strong>Members of a complex
          do not automatically get access to its child houses</strong> — that&rsquo;s by design.
          The opposite is also true: a house resident can&rsquo;t open the main gate unless they&rsquo;re
          also a member of the complex.
        </p>
        <p>
          You can move a house between complexes without re-pairing devices. Members and roles
          travel with the house, not the complex.
        </p>
      </DocSection>

      <DocSection heading="Creating one">
        <ol className="list-decimal pl-6 space-y-3">
          <li>From the dashboard sidebar, click <strong>Locations</strong> then <em>New location</em>.</li>
          <li>Pick the kind, give it a name (residents see this in their WhatsApp replies), and a city.</li>
          <li>Optional: drop a pin on the map. This anchors the geofence if you turn it on later.</li>
          <li>You&rsquo;re ready to add an access point.</li>
        </ol>
      </DocSection>

      <DocSection heading="Or via the API">
        <CodeBlock lang="bash">{`curl -X POST https://api.whatsacc.com/v1/locations \\
  -H "Authorization: Bearer wacc_live_xxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "kind": "complex",
    "name": "Sunset Apartments",
    "city": "Cape Town",
    "country_code": "ZA",
    "anchor": { "lat": -33.918, "lng": 18.423 }
  }'`}</CodeBlock>
        <CodeBlock lang="json">{`{
  "id": "loc_oak",
  "kind": "complex",
  "name": "Sunset Apartments",
  "city": "Cape Town",
  "country_code": "ZA",
  "anchor": { "lat": -33.918, "lng": 18.423 },
  "access_points": [],
  "created_at": "2026-05-14T10:21:04Z"
}`}</CodeBlock>
      </DocSection>

      <DocSection heading="Naming gates well">
        <p>
          Residents see the location name in every reply. Two patterns work:
        </p>
        <CodeBlock lang="plain" title="Good">{`Sunset Apartments        — single gate, no ambiguity
Sunset Apartments · Main — multi-gate, clear which one
Oak Street House         — house inside Sunset Apartments`}</CodeBlock>
        <CodeBlock lang="plain" title="Avoid">{`Gate                     — ambiguous when you add a second
TheGate1                 — reads like a server hostname
GATE_PROD                — yes, we've seen this`}</CodeBlock>
      </DocSection>

      <DocSection heading="Schema (for the curious)">
        <CodeBlock lang="ts" title="locations.types.ts">{`export type LocationKind = 'house' | 'complex' | 'building' | 'other';

export interface Location {
  id: string;            // 'loc_oak'
  kind: LocationKind;
  name: string;
  city: string;
  country_code: string;  // ISO-3166-1 alpha-2
  anchor: { lat: number; lng: number } | null;
  parent_id: string | null;      // null for top-level
  access_points: AccessPoint[];
  created_at: string;            // ISO-8601
}`}</CodeBlock>
      </DocSection>
    </>
  );
}
