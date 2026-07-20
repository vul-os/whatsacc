import { Link } from 'react-router-dom';
import { DocLead, DocSection, CodeBlock } from './DocsLayout';

export default function LocationsDoc() {
  return (
    <>
      <DocLead
        kicker="02 · Concepts"
        title="Creating a Location"
        intro="A Location is the physical place lintel protects. Everything else — access points, devices, members — hangs off it. Most accounts have one; estates have several with nested children."
      />

      <DocSection heading="The four kinds">
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>House</strong> — a single residence. Typically one access point.</li>
          <li><strong>Complex</strong> — a residential estate. Can contain houses as nested locations and have multiple access points (main gate, pedestrian, parking).</li>
          <li><strong>Building</strong> — an apartment block or office. Doors, lobbies, parking barriers.</li>
          <li><strong>Other</strong> — workshops, warehouses, storage yards, anything else.</li>
        </ul>
        <p className="text-ink/55 text-[14px]">
          The kind controls UI defaults (icons, dashboard hints) but not authorisation.
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
          <li>Optional: drop a pin on the map. This is where a geofence anchor would attach if that
          feature ships — <Link to="/docs/geofence-safety" className="underline underline-offset-4 decoration-terracotta">designed, not built yet</Link>.</li>
          <li>You&rsquo;re ready to add an access point.</li>
        </ol>
      </DocSection>

      <DocSection heading="Or via the API">
        <p>
          Fields are flat — <code>lat</code>/<code>long</code>, not a nested
          <code> anchor</code> object — and the field is <code>type</code>, not
          <code> kind</code>. <code>city</code> isn&rsquo;t its own field; put it inside
          <code> address</code> if you use one.
        </p>
        <CodeBlock lang="bash">{`curl -X POST https://<your-gateway>/v1/locations \\
  -H "Authorization: Bearer lintel_live_xxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "complex",
    "name": "Sunset Apartments",
    "country_code": "ZA",
    "lat": -33.918,
    "long": 18.423
  }'`}</CodeBlock>
        <p>The create response is intentionally minimal:</p>
        <CodeBlock lang="json">{`{
  "id": "loc_oak",
  "account_id": "acc_oak"
}`}</CodeBlock>
        <p>Fetch the full record with a follow-up <code>GET /v1/locations/loc_oak</code>:</p>
        <CodeBlock lang="json">{`{
  "id": "loc_oak",
  "parent_location_id": null,
  "type": "complex",
  "name": "Sunset Apartments",
  "slug": "sunset-apartments",
  "status": "active",
  "address": {},
  "account_id": "acc_oak",
  "lat": -33.918,
  "long": 18.423
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
        <CodeBlock lang="ts" title="locations.types.ts">{`export type LocationType = 'house' | 'complex' | 'building' | 'other';

export interface Location {
  id: string;                    // 'loc_oak'
  parent_location_id: string | null;   // null for top-level
  type: LocationType;
  name: string;
  slug: string;
  status: string;                // 'active' | ...
  address: Record<string, unknown>;    // free-form; put city/street/etc. here
  account_id: string;
  lat: number | null;
  long: number | null;
}`}</CodeBlock>
        <p className="text-ink/55 text-[14px]">
          No <code>country_code</code> or <code>created_at</code> on the location itself —
          country lives on the account, and access points come back from their own
          endpoint, not embedded here.
        </p>
      </DocSection>
    </>
  );
}
