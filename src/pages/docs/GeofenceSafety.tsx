import { DocLead, DocSection, CodeBlock } from './DocsLayout';

export default function GeofenceSafety() {
  return (
    <>
      <DocLead
        kicker="02 · Concepts"
        title="Geofence safety"
        intro="A geofence would stop people from opening your gate when they're nowhere near it — off by default for homes, on by default for complexes, pairing with phone-number identity to form a defence-in-depth layer, not a magic shield. It's designed and documented here in full; it is not built."
      />

      <div className="mb-10 sm:mb-12 rounded-2xl border border-gold/40 bg-gold/[0.06] px-5 py-4 sm:px-6 sm:py-5">
        <p className="text-[11px] uppercase tracking-[0.18em] text-ink/55 font-mono">
          Status: designed, not implemented
        </p>
        <p className="mt-2 text-[15px] text-ink/80 leading-relaxed">
          Nothing on this page runs today. There is no geofencing code in the Go gateway
          or the reference backend — no location field on the open path, no radius
          config, no <code>open.geofence_check</code> event. Everything below is the
          intended design, kept here so operators know what's coming and implementers
          know the target. Read it as a spec, not a live control, until this notice is
          removed. Current, verified status lives in the{' '}
          <a
            href="https://github.com/vul-os/lintel#features"
            className="underline underline-offset-4 decoration-terracotta"
          >
            README
          </a>
          .
        </p>
      </div>

      <DocSection heading="How it would work">
        <p>
          When geofence is enabled on a location, every open request would need to include
          a recent location signal from the sender. The design accepts two sources:
        </p>
        <ul className="list-disc pl-6 space-y-2">
          <li>A WhatsApp <strong>shared location</strong> attached to the open message.</li>
          <li>A <strong>live-location ping</strong> the user has shared with lintel within the last 5 minutes.</li>
        </ul>
        <p>
          If the lat/lng is outside the configured radius, the plan is to return a polite
          decline message and write the verdict to the audit log, recording the actual GPS
          distance so admins can investigate.
        </p>
      </DocSection>

      <DocSection heading="Configuring it (proposed)">
        <p className="text-ink/55 text-[14px]">
          This endpoint and payload do not exist yet — shown as the target shape for the
          feature, not something you can call today.
        </p>
        <CodeBlock lang="json" title="PATCH /v1/locations/loc_oak/policy (proposed, not implemented)">{`{
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

      <DocSection heading="Decline messages users would see">
        <p className="text-ink/55 text-[14px]">
          Illustrative only — no such reply exists today since nothing triggers it.
        </p>
        <CodeBlock lang="plain" title="WhatsApp (mockup, not sent by lintel today)">{`lintel 14:02   Hi Yusuf — share your location and try again.
                 (we need it once per 5 min while geofence is on)

lintel 14:09   Sorry, you're 1.8 km from Sunset Apartments.
                 Geofence radius is 200 m. Try again when you're closer.`}</CodeBlock>
        <p>
          The plan is for both lines to be templated and translatable per location, with
          owners able to override the copy in <strong>Settings → Messaging</strong>.
        </p>
      </DocSection>

      <DocSection heading="Edge cases the design would need to handle">
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>Spoofed location.</strong> Phones with deliberately spoofed location can be flagged via WhatsApp&rsquo;s metadata, but the design doesn&rsquo;t rely on that as the only check — combined with phone-number identity it would be a meaningful layer, not a silver bullet.</li>
          <li><strong>No location attached.</strong> The gate would stay shut and the sender would be asked to share their location, with the original message staying in their thread so they can re-trigger.</li>
          <li><strong>Stale signal.</strong> A signal older than <code>max_signal_age_s</code> would be treated as missing.</li>
          <li><strong>Device offline.</strong> If the controller is offline when the geofence check passes, the open would queue for 30 s and retry on reconnect.</li>
          <li><strong>Anchor not set.</strong> If the location has no map pin, geofence couldn&rsquo;t be enabled — the policy update would be rejected with <code>geofence_anchor_required</code>.</li>
        </ul>
      </DocSection>

      <DocSection heading="Auditing (proposed)">
        <p>
          The plan is for every geofence verdict to be logged whether the open succeeded or
          not, so admins can spot residents who are constantly at the radius edge and might
          benefit from a wider window. Neither the query below nor the
          <code> open.geofence_check</code> event kind exists yet:
        </p>
        <CodeBlock lang="bash" title="proposed, not implemented">{`curl -G https://<your-gateway>/v1/events \\
  -H "Authorization: Bearer lintel_live_xxxxxxxxxxxxxxxx" \\
  --data-urlencode "location=loc_oak" \\
  --data-urlencode "kind=open.geofence_check" \\
  --data-urlencode "since=2026-05-01"`}</CodeBlock>
        <CodeBlock lang="json" title="proposed shape">{`{
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
