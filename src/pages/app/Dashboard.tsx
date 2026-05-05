import { Link } from 'react-router-dom';
import { PageHeader } from './AppLayout';
import { Card, StatBlock } from '@/components/ui/Card';
import { activity } from '@/mocks/activity';
import { locations } from '@/mocks/locations';

export default function Dashboard() {
  return (
    <>
      <PageHeader
        kicker="Today"
        title="Good afternoon, Yusuf."
        description="Three of your locations have had activity in the last hour. Everything is running."
      />

      <section className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <Card className="lg:col-span-8 p-0 overflow-hidden">
          <div className="px-6 lg:px-8 pt-7 pb-2 flex items-center justify-between">
            <h2 className="font-display text-2xl">Recent activity</h2>
            <Link to="/app/analytics" className="text-sm text-ink/60 hover:text-ink">
              View all
            </Link>
          </div>
          <ul className="divide-y divide-ink/10">
            {activity.map((a) => (
              <li
                key={a.id}
                className="px-6 lg:px-8 py-3.5 flex items-center gap-4 text-sm hover:bg-paper-warm/50 transition-colors"
              >
                <span className="font-mono text-xs text-ink/55 w-12">{a.time}</span>
                <Verdict kind={a.kind} />
                <span className="font-medium">{a.who}</span>
                <span className="text-ink/55">·</span>
                <span className="text-ink/65 flex-1 min-w-0 truncate">{a.where}</span>
                {a.note && (
                  <span className="text-xs text-ink/50 hidden md:inline">{a.note}</span>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <div className="lg:col-span-4 grid grid-cols-2 gap-4 content-start">
          <Card className="col-span-2 bg-ink text-paper">
            <StatBlock label="Opens today" value="118" hint="+12 vs yesterday" className="text-paper [&_*]:!text-paper" />
          </Card>
          <Card>
            <StatBlock label="Locations" value={String(locations.length)} hint="active" />
          </Card>
          <Card>
            <StatBlock label="Members" value="193" hint="across portfolio" />
          </Card>
          <Card className="col-span-2 bg-paper-warm">
            <p className="text-[11px] uppercase tracking-[0.18em] text-ink/55 mb-3">
              Wallet
            </p>
            <p className="font-display text-3xl">1,243 / 2,000</p>
            <p className="text-sm text-ink/60 mt-1">messages this month</p>
            <div className="mt-4 h-1.5 rounded-full bg-ink/10 overflow-hidden">
              <div className="h-full bg-terracotta" style={{ width: '62%' }} />
            </div>
          </Card>
        </div>

        <Card className="lg:col-span-12">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-display text-2xl">Locations</h2>
            <Link to="/app/locations" className="text-sm text-ink/60 hover:text-ink">
              Manage
            </Link>
          </div>
          <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {locations.map((loc) => (
              <li key={loc.id} className="rounded-2xl border border-ink/10 p-5 hover:border-ink/30 transition-colors">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-[0.18em] text-ink/50">
                    {loc.kind}
                  </span>
                  <span className="text-xs text-ink/45">{loc.city}</span>
                </div>
                <p className="font-display text-xl mt-2">{loc.name}</p>
                <p className="text-sm text-ink/55 mt-2">
                  {loc.accessPoints} access points · {loc.members} members
                </p>
                <p className="text-xs text-ink/45 mt-3">last opened {loc.lastOpened}</p>
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </>
  );
}

function Verdict({ kind }: { kind: string }) {
  const map: Record<string, { dot: string; label: string }> = {
    open: { dot: 'bg-moss', label: 'open' },
    denied: { dot: 'bg-terracotta', label: 'denied' },
    paired: { dot: 'bg-gold', label: 'paired' },
    invite: { dot: 'bg-ink', label: 'invite' },
    note: { dot: 'bg-slate', label: 'note' },
  };
  const m = map[kind] ?? map.note;
  return (
    <span className="inline-flex items-center gap-2 w-20 text-xs text-ink/70 uppercase tracking-wider">
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}
