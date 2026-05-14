import { DocLead, DocSection, CodeBlock } from './DocsLayout';

export default function GeofenceSafety() {
  return (
    <>
      <DocLead
        kicker="02 · Concepts"
        title="Geofence safety"
        intro="A geofence stops people from opening your gate when they're nowhere near it. It's optional — off by default for homes, on by default for complexes — and pairs with phone-number identity to form a defence-in-depth layer, not a magic shield."
      />

      <DocSection heading="How it works">
        <p>
          When geofence is enabled on a location, every open request must include a recent
          location signal from the sender. whatsacc accepts two sources:
        </p>
        <ul className="list-disc pl-6 space-y-2">
          <li>A WhatsApp <strong>shared location</strong> attached to the open message.</li>
          <li>A <strong>live-location ping</strong> the user has shared with whatsacc within the last 5 minutes.</li>
        </ul>
        <p>
          If the lat/lng is outside the configured radius, we return a polite decline message
          and write the verdict to the audit log. The actual GPS distance is recorded so admins
          can investigate.
        </p>
      </DocSection>

      <DocSection heading="Configuring it">
        <CodeBlock lang="json" title="PATCH /v1/locations/loc_oak/policy">{`{
  "geofence": {
    "enabled": true,
    "radius_m": 200,
    "max_signal_age_s": 300,
    "on_missing_signal": "ask",
    "on_outside": "deny"
  }
}`}</CodeBlock>
        <ul className="list-disc pl-6 space-y-2">
          <li><code>radius_m</code> — distance from the location anchor (set when you created it).</li>
          <li><code>max_signal_age_s</code> — drop signals older than this. 300 s is a sane default.</li>
          <li><code>on_missing_signal</code> — <code>ask</code> (default) or <code>deny</code>. <code>ask</code> sends a "share your location to continue" reply.</li>
          <li><code>on_outside</code> — <code>deny</code> (default) or <code>flag</code>. Flag lets the open through but tags the event for audit review — useful while you tune the radius.</li>
        </ul>
      </DocSection>

      <DocSection heading="Choosing a radius">
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>50 m</strong> — very strict. People must be at the gate already.</li>
          <li><strong>200 m</strong> — sane default for complexes. Catches most cars approaching.</li>
          <li><strong>1 km</strong> — relaxed. Useful when residents start the open from the freeway off-ramp.</li>
        </ul>
        <p>
          GPS accuracy on phones in built-up areas is typically <strong>10–40 m</strong>, sometimes
          worse near tall buildings. A radius below 50 m will produce false denies in those areas;
          start with <strong>200 m</strong> and tighten only if you see drift.
        </p>
      </DocSection>

      <DocSection heading="Decline messages users see">
        <CodeBlock lang="plain" title="WhatsApp">{`whatsacc 14:02   Hi Yusuf — share your location and try again.
                 (we need it once per 5 min while geofence is on)

whatsacc 14:09   Sorry, you're 1.8 km from Sunset Apartments.
                 Geofence radius is 200 m. Try again when you're closer.`}</CodeBlock>
        <p>
          Both lines are templated and translatable per location. Owners on the Business plan can
          override the copy in <strong>Settings → Messaging</strong>.
        </p>
      </DocSection>

      <DocSection heading="Edge cases we handle">
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>Spoofed location.</strong> Phones with deliberately spoofed location are flagged via WhatsApp&rsquo;s metadata, but we don&rsquo;t rely on that as the only check — combined with phone-number identity it&rsquo;s a meaningful layer, not a silver bullet.</li>
          <li><strong>No location attached.</strong> The gate stays shut and we ask the sender to share their location. The original message stays in their thread so they can re-trigger.</li>
          <li><strong>Stale signal.</strong> If the only signal we have is older than <code>max_signal_age_s</code>, treat as missing.</li>
          <li><strong>Device offline.</strong> If the controller is offline when the geofence check passes, we queue the open for 30 s and retry on reconnect.</li>
          <li><strong>Anchor not set.</strong> If the location has no map pin, geofence cannot be enabled — the policy update is rejected with <code>geofence_anchor_required</code>.</li>
        </ul>
      </DocSection>

      <DocSection heading="Auditing">
        <p>
          Every geofence verdict is logged whether the open succeeded or not. Use it to spot
          residents who are constantly at the radius edge and might benefit from a wider window:
        </p>
        <CodeBlock lang="bash">{`curl -G https://api.whatsacc.com/v1/events \\
  -H "Authorization: Bearer wacc_live_xxxxxxxxxxxxxxxx" \\
  --data-urlencode "location=loc_oak" \\
  --data-urlencode "kind=open.geofence_check" \\
  --data-urlencode "since=2026-05-01"`}</CodeBlock>
        <CodeBlock lang="json">{`{
  "events": [
    {
      "id": "ev_01HZ4G…",
      "kind": "open.geofence_check",
      "verdict": "deny_outside_radius",
      "distance_m": 1842,
      "radius_m": 200,
      "actor": { "phone": "+27821234567" },
      "at": "2026-05-14T14:09:31Z"
    }
  ]
}`}</CodeBlock>
      </DocSection>
    </>
  );
}
