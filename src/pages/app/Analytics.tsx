import { PageHeader } from './AppLayout';
import { Card, StatBlock } from '@/components/ui/Card';

const days = [
  ['Mon', 86, 2],
  ['Tue', 92, 1],
  ['Wed', 104, 4],
  ['Thu', 88, 0],
  ['Fri', 138, 3],
  ['Sat', 162, 2],
  ['Sun', 118, 3],
] as const;

const breakdown = [
  { label: 'Oakridge · Main gate', val: 412 },
  { label: 'Oakridge · Pedestrian', val: 188 },
  { label: 'Oakridge · Parking barrier', val: 142 },
  { label: '50 Riebeek · Lobby', val: 96 },
  { label: 'House Bertrand · Front gate', val: 64 },
];

const max = Math.max(...days.map((d) => d[1]));

export default function Analytics() {
  return (
    <>
      <PageHeader
        kicker="Insights"
        title="Analytics"
        description="The shape of your week. Use this when you're sizing up a plan or chasing down anomalies."
      />

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card><StatBlock label="Opens · 7d" value="788" hint="+11% week-over-week" /></Card>
        <Card><StatBlock label="Denied · 7d" value="15" hint="2% of attempts" /></Card>
        <Card><StatBlock label="Avg open" value="1.8s" hint="signed → opened" /></Card>
        <Card><StatBlock label="Active members" value="167" hint="of 193" /></Card>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <Card className="lg:col-span-8">
          <div className="flex items-center justify-between mb-6">
            <h2 className="font-display text-2xl">Last 7 days</h2>
            <div className="flex items-center gap-4 text-xs text-ink/60">
              <span className="inline-flex items-center gap-2">
                <span className="h-1.5 w-3 bg-ink" />
                opens
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="h-1.5 w-3 bg-terracotta" />
                denied
              </span>
            </div>
          </div>

          <div className="flex items-end gap-3 h-72 px-2">
            {days.map(([d, opens, denied]) => (
              <div key={d} className="flex-1 flex flex-col items-center gap-2">
                <div className="w-full flex-1 flex items-end gap-1">
                  <span
                    className="flex-1 bg-ink rounded-t-md"
                    style={{ height: `${(opens / max) * 100}%` }}
                  />
                  <span
                    className="w-2 bg-terracotta rounded-t-sm self-end"
                    style={{ height: `${(denied / max) * 100 + 4}%` }}
                  />
                </div>
                <span className="text-[11px] uppercase tracking-[0.18em] text-ink/45">{d}</span>
                <span className="font-display text-sm">{opens}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="lg:col-span-4">
          <h2 className="font-display text-2xl mb-4">By access point</h2>
          <ul className="space-y-3">
            {breakdown.map((b) => (
              <li key={b.label}>
                <div className="flex items-baseline justify-between mb-1.5 text-sm">
                  <span className="text-ink/80 truncate pr-3">{b.label}</span>
                  <span className="font-display tabular-nums">{b.val}</span>
                </div>
                <div className="h-1.5 bg-ink/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-ink"
                    style={{ width: `${(b.val / breakdown[0].val) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
