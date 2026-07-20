import { DocLead, DocSection, CodeBlock } from './DocsLayout';

export default function PermissionsMembers() {
  return (
    <>
      <DocLead
        kicker="02 · Concepts"
        title="Permissions & Members"
        intro="Members are people invited onto an account by email; their phone number is what lets them text the gate. Roles control what they can do beyond opening it."
      />

      <DocSection heading="The four roles">
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>Owner</strong> — the account holder. Danger-zone settings, can transfer ownership. Exactly one per account.</li>
          <li><strong>Admin</strong> — can manage devices, members, and policies for the account.</li>
          <li><strong>Member</strong> — can open gates on the account. Can&rsquo;t change settings.</li>
          <li><strong>Viewer</strong> — read-only: sees locations, devices and activity but can&rsquo;t manage them.</li>
        </ul>
        <p className="text-ink/55 text-[14px]">
          Roles are account-wide today — there&rsquo;s no separate role per location or
          access point yet, and no built-in expiry on a membership. For one-off,
          time-bound access that shouldn&rsquo;t become a standing membership (a
          contractor, a weekend guest), use a temporary access grant instead — see the
          app&rsquo;s Grants page.
        </p>
      </DocSection>

      <DocSection heading="Inviting members">
        <ol className="list-decimal pl-6 space-y-3">
          <li>Members → <em>Invite</em>. You&rsquo;ll need the invitee&rsquo;s email and their phone number.</li>
          <li>Pick a role: owner, admin, member or viewer.</li>
          <li>They get an accept link, valid for 7 days. Accepting binds their phone number to the account — that&rsquo;s what lets them text the gate.</li>
        </ol>
      </DocSection>

      <DocSection heading="Programmatic invites">
        <CodeBlock lang="bash">{`curl -X POST https://<your-gateway>/v1/accounts/acc_oak/invites \\
  -H "Authorization: Bearer lintel_live_xxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "lebogang@example.com",
    "phone_e164": "+27821234567",
    "role": "member"
  }'`}</CodeBlock>
        <CodeBlock lang="json">{`{
  "id": "inv_01HZ4D…",
  "email_sent": false,
  "whatsapp_sent": false
}`}</CodeBlock>
        <p>
          The accept token itself is never returned here — it&rsquo;s delivered straight
          to the invitee, never to the inviter. <code>email_sent</code>/
          <code>whatsapp_sent</code> report whether delivery is wired up on your
          gateway; a half-configured install still creates the invite, it just can&rsquo;t
          tell the invitee about it yet.
        </p>
      </DocSection>

      <DocSection heading="Revoking access">
        <div className="rounded-2xl border border-gold/40 bg-gold/[0.06] px-5 py-4 sm:px-6 sm:py-5">
          <p className="text-[11px] uppercase tracking-[0.18em] text-ink/55 font-mono">
            Status: not implemented
          </p>
          <p className="mt-2 text-[15px] text-ink/80 leading-relaxed">
            There is currently no route to remove a member or revoke their access once
            they&rsquo;ve accepted an invite — not in the gateway API, not in the
            reference backend, not in the app. (Temporary access <em>grants</em> are
            different and do revoke instantly — <code>POST /v1/grants/{'{id}'}/revoke</code> —
            this gap is specifically about standing memberships.) Until member
            offboarding ships, pulling a phone number&rsquo;s access means asking your
            instance admin to edit the <code>account_members</code> row directly on the
            gateway&rsquo;s own database.
          </p>
        </div>
      </DocSection>
    </>
  );
}
