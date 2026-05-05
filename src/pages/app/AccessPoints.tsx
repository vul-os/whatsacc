import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { accessPoints } from '@/mocks/accessPoints';

const statusStyles: Record<string, string> = {
  online: 'bg-moss/15 text-moss',
  offline: 'bg-terracotta/15 text-terracotta-deep',
  'paired-pending': 'bg-gold/20 text-ink/80',
};

export default function AccessPointsPage() {
  return (
    <>
      <PageHeader
        kicker="Hardware"
        title="Access points"
        description="Each access point is one physical opening — gate, door, or barrier — wired through one device."
        actions={<Button variant="ink">Add access point</Button>}
      />

      <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {accessPoints.map((a) => (
          <li key={a.id}>
            <Card className="p-6">
              <div className="flex items-start justify-between mb-3">
                <span
                  className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] ${
                    statusStyles[a.status] ?? ''
                  }`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  {a.status}
                </span>
                <span className="text-[11px] uppercase tracking-[0.18em] text-ink/50">
                  {a.type}
                </span>
              </div>
              <p className="font-display text-2xl">{a.name}</p>
              <p className="text-sm text-ink/60 mt-1">{a.location}</p>

              <div className="mt-5 flex items-center justify-between text-xs text-ink/55">
                <span>device {a.device}</span>
                <span>opened {a.lastOpened}</span>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
