import { DocLead, DocSection } from './DocsLayout';

export default function PermissionsMembers() {
  return (
    <>
      <DocLead
        kicker="02 · Concepts"
        title="Permissions & Members"
        intro="Members are people whose phone numbers can text the gate. Roles control what they can do beyond opening it."
      />

      <DocSection heading="The four roles">
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>Owner</strong> — the account holder. Billing, danger-zone settings, can transfer ownership.</li>
          <li><strong>Admin</strong> — can manage devices, members, and policies for assigned locations.</li>
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
      </DocSection>

      <DocSection heading="Inviting members">
        <ol className="list-decimal pl-6 space-y-3">
          <li>Members → <em>Invite</em>. Paste a phone number or upload a CSV.</li>
          <li>Pick a role and the location(s) to bind to.</li>
          <li>Optional: set an expiry — useful for guests and contractors.</li>
          <li>The invitee receives a one-line WhatsApp message confirming they&rsquo;re in.</li>
        </ol>
      </DocSection>

      <DocSection heading="Revoking">
        <p>
          Open the member, hit Revoke. The next message they send to the gate is rejected.
          The audit log keeps the record forever — revocation is not deletion.
        </p>
      </DocSection>
    </>
  );
}
