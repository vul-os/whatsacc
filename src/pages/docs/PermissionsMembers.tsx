import { DocLead, DocSection, CodeBlock } from './DocsLayout';

export default function PermissionsMembers() {
  return (
    <>
      <DocLead
        kicker="02 · Concepts"
        title="Permissions & Members"
        intro="Members are people whose phone numbers can text the gate. Roles control what they can do beyond opening it. Inheritance and explicit overrides let you express estate-scale policies without hand-curating every access point."
      />

      <DocSection heading="The four roles">
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>Owner</strong> — the account holder. Danger-zone settings, can transfer ownership. Exactly one per account.</li>
          <li><strong>Admin</strong> — can manage devices, members, and policies for assigned locations. Cannot delete the account.</li>
          <li><strong>Member</strong> — can open gates they have access to. Can&rsquo;t change settings.</li>
          <li><strong>Guest</strong> — like a member, but typically time-bound. Perfect for contractors and weekend visitors.</li>
        </ul>
      </DocSection>

      <DocSection heading="Inheritance">
        <p>
          A role on a complex applies to all access points within it, unless overridden. You can,
          for example, make someone an Admin of the whole estate and then explicitly deny them
          opening rights to one specific access point.
        </p>
        <CodeBlock lang="yaml" title="Effective policy example">{`# Estate-wide
- subject: yusuf@example.com
  role: admin
  on: complex/sunset-apartments

# But explicitly denied at one access point
- subject: yusuf@example.com
  effect: deny
  action: open
  on: access_point/loading-bay`}</CodeBlock>
      </DocSection>

      <DocSection heading="Inviting members">
        <ol className="list-decimal pl-6 space-y-3">
          <li>Members → <em>Invite</em>. Paste a phone number or upload a CSV.</li>
          <li>Pick a role and the location(s) to bind to.</li>
          <li>Optional: set an expiry — useful for guests and contractors.</li>
          <li>The invitee receives a one-line WhatsApp message confirming they&rsquo;re in.</li>
        </ol>
        <p>CSV format is permissive — only <code>phone</code> is required:</p>
        <CodeBlock lang="plain" title="members.csv">{`phone,name,role,expires_at
+27821234567,Lebogang Pillay,member,
+27839998877,Cleaner Mon-Fri,guest,2026-12-31T17:00:00+02:00
+27834447766,Solar contractor,guest,2026-05-20T17:00:00+02:00`}</CodeBlock>
      </DocSection>

      <DocSection heading="Programmatic invites">
        <CodeBlock lang="bash">{`curl -X POST https://<your-gateway>/v1/locations/loc_oak/invites \\
  -H "Authorization: Bearer wacc_live_xxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "phone": "+27821234567",
    "role": "guest",
    "expires_at": "2026-05-20T17:00:00Z"
  }'`}</CodeBlock>
        <CodeBlock lang="json">{`{
  "invite_id": "inv_01HZ4D…",
  "status": "sent",
  "channel": "whatsapp",
  "phone": "+27821234567",
  "expires_at": "2026-05-20T17:00:00Z"
}`}</CodeBlock>
      </DocSection>

      <DocSection heading="Revoking">
        <p>
          Open the member, hit <em>Revoke</em>. The next message they send to the gate is rejected
          with a polite "your access has ended" reply. The audit log keeps the record forever —
          revocation is not deletion. To purge a phone number entirely (e.g. GDPR-style request),
          contact your instance admin — the data lives on your gateway's own database.
        </p>
        <CodeBlock lang="bash">{`curl -X DELETE https://<your-gateway>/v1/locations/loc_oak/members/+27821234567 \\
  -H "Authorization: Bearer wacc_live_xxxxxxxxxxxxxxxx"`}</CodeBlock>
      </DocSection>

      <DocSection heading="Audit trail">
        <p>
          Every role change writes one row. Filter by subject phone or by admin to answer "who gave
          this person access?" later:
        </p>
        <CodeBlock lang="json">{`{
  "id": "ev_01HZ4G…",
  "kind": "member.granted",
  "actor": { "user_id": "u_owner", "ip": "102.220.208.91" },
  "subject_phone": "+27821234567",
  "role": "guest",
  "expires_at": "2026-05-20T17:00:00Z",
  "at": "2026-05-14T14:02:11Z"
}`}</CodeBlock>
      </DocSection>
    </>
  );
}
