import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { locations } from '@/mocks/locations';

export default function LocationsPage() {
  return (
    <>
      <PageHeader
        kicker="Portfolio"
        title="Locations"
        description="Every property under your account. A house belongs to a complex; a complex contains its access points."
        actions={<Button variant="ink">New location</Button>}
      />

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink/10">
              {['Name', 'Kind', 'City', 'Members', 'Access points', 'Last opened'].map((c) => (
                <th
                  key={c}
                  className="text-left px-6 py-4 text-[11px] uppercase tracking-[0.18em] text-ink/55 font-normal"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {locations.map((l) => (
              <tr key={l.id} className="border-b border-ink/8 last:border-0 hover:bg-paper-warm/40 transition-colors">
                <td className="px-6 py-5">
                  <p className="font-display text-lg">{l.name}</p>
                </td>
                <td className="px-6 py-5 capitalize">
                  <span className="inline-flex items-center gap-2">
                    <KindDot kind={l.kind} />
                    {l.kind}
                  </span>
                </td>
                <td className="px-6 py-5 text-ink/70">{l.city}</td>
                <td className="px-6 py-5">{l.members}</td>
                <td className="px-6 py-5">{l.accessPoints}</td>
                <td className="px-6 py-5 text-ink/70">{l.lastOpened}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function KindDot({ kind }: { kind: string }) {
  const c =
    kind === 'house'
      ? 'bg-gold'
      : kind === 'complex'
        ? 'bg-terracotta'
        : kind === 'building'
          ? 'bg-moss'
          : 'bg-slate';
  return <span className={`h-1.5 w-1.5 rounded-full ${c}`} />;
}
