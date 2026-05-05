import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { members, type Role } from '@/mocks/members';

const roleStyles: Record<Role, string> = {
  owner: 'bg-ink text-paper',
  admin: 'bg-terracotta text-paper',
  member: 'bg-paper-warm text-ink border border-ink/10',
  guest: 'bg-gold/30 text-ink',
};

export default function MembersPage() {
  return (
    <>
      <PageHeader
        kicker="People"
        title="Members"
        description="Anyone whose phone number is allowed to text the gate. Roles inherit down the location tree."
        actions={
          <>
            <Button variant="outline">Import CSV</Button>
            <Button variant="ink">Invite member</Button>
          </>
        }
      />

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink/10">
              {['Name', 'Phone', 'Role', 'Location', 'Joined', 'Last active', ''].map((c) => (
                <th key={c} className="text-left px-6 py-4 text-[11px] uppercase tracking-[0.18em] text-ink/55 font-normal">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b border-ink/8 last:border-0 hover:bg-paper-warm/40 transition-colors">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <span className="grid h-8 w-8 place-items-center rounded-full bg-ink/10 text-ink text-xs font-medium">
                      {m.name.split(' ').map((s) => s[0]).join('').slice(0, 2)}
                    </span>
                    <span className="font-medium">{m.name}</span>
                  </div>
                </td>
                <td className="px-6 py-4 font-mono text-xs text-ink/70">{m.phone}</td>
                <td className="px-6 py-4">
                  <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] ${roleStyles[m.role]}`}>
                    {m.role}
                  </span>
                </td>
                <td className="px-6 py-4 text-ink/75">{m.location}</td>
                <td className="px-6 py-4 text-ink/65">{m.joined}</td>
                <td className="px-6 py-4 text-ink/65">{m.last}</td>
                <td className="px-6 py-4 text-right">
                  <button className="text-xs text-ink/55 hover:text-terracotta">Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
