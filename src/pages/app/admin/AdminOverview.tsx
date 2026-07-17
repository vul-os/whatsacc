// Instance overview: totals, open volume, today's denial breakdown, and the
// latest signups. Mono numerals, colour-coded denial reasons.

import { api } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import {
  AdminBadge,
  ErrorNote,
  StatusPill,
  fmtRelative,
  useAdminLoad,
} from './shared';

const DENIAL_ROWS = [
  { key: 'rate_limited', label: 'Rate limited', dot: 'bg-gold', text: 'text-gold' },
  { key: 'quota_exceeded', label: 'Quota exceeded', dot: 'bg-terracotta', text: 'text-terracotta-deep' },
  { key: 'account_suspended', label: 'Account suspended', dot: 'bg-ink', text: 'text-ink' },
  { key: 'other', label: 'Other', dot: 'bg-slate', text: 'text-slate' },
] as const;

export default function AdminOverview() {
  const { data, error, loading } = useAdminLoad(() => api.adminOverview(), []);

  if (loading && !data) {
    return <p className="text-sm text-ink/50 py-10">Loading overview…</p>;
  }
  if (error) return <ErrorNote text={error} />;
  if (!data) return null;

  const totals: Array<{ label: string; value: number }> = [
    { label: 'Users', value: data.totals.users },
    { label: 'Accounts', value: data.totals.accounts },
    { label: 'Locations', value: data.totals.locations },
    { label: 'Devices', value: data.totals.devices },
    { label: 'Access points', value: data.totals.access_points },
  ];
  const denialMax = Math.max(1, ...DENIAL_ROWS.map((r) => data.denials_today[r.key]));

  return (
    <div className="flex flex-col gap-4">
      {/* Row 1: volume + denials */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Card className="bg-ink text-paper p-5">
          <p className="text-[11px] uppercase tracking-[0.18em] text-paper/55">Opens today</p>
          <p className="font-mono text-4xl mt-2 leading-none tabular-nums">
            {data.opens.today.toLocaleString()}
          </p>
          <p className="text-xs text-paper/60 mt-2">successful, instance-wide</p>
        </Card>
        <Card className="p-5">
          <p className="text-[11px] uppercase tracking-[0.18em] text-ink/55">Opens last 7 days</p>
          <p className="font-mono text-4xl mt-2 leading-none tabular-nums">
            {data.opens.last_7d.toLocaleString()}
          </p>
          <p className="text-xs text-ink/55 mt-2">
            ≈ {Math.round(data.opens.last_7d / 7).toLocaleString()} / day
          </p>
        </Card>
        <Card className="p-5">
          <div className="flex items-baseline justify-between">
            <p className="text-[11px] uppercase tracking-[0.18em] text-ink/55">Denials today</p>
            <span className="font-mono text-lg tabular-nums text-ink/85">
              {data.denials_today.total.toLocaleString()}
            </span>
          </div>
          <ul className="mt-3 space-y-2">
            {DENIAL_ROWS.map((r) => {
              const n = data.denials_today[r.key];
              return (
                <li key={r.key} className="flex items-center gap-2.5 text-xs">
                  <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', r.dot)} aria-hidden />
                  <span className="w-32 shrink-0 text-ink/65">{r.label}</span>
                  <span className="flex-1 h-1 rounded-full bg-ink/6 overflow-hidden">
                    <span
                      className={cn('block h-full rounded-full', r.dot)}
                      style={{ width: `${Math.round((n / denialMax) * 100)}%` }}
                    />
                  </span>
                  <span className={cn('font-mono tabular-nums w-8 text-right', n > 0 ? r.text : 'text-ink/35')}>
                    {n}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      </section>

      {/* Row 2: totals strip */}
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {totals.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-[10px] uppercase tracking-[0.18em] text-ink/50">{t.label}</p>
            <p className="font-mono text-2xl mt-1.5 leading-none tabular-nums">
              {t.value.toLocaleString()}
            </p>
          </Card>
        ))}
      </section>

      {/* Row 3: recent signups */}
      <Card className="p-0 overflow-hidden">
        <div className="px-5 pt-5 pb-2">
          <h2 className="font-display text-xl">Recent signups</h2>
        </div>
        {data.recent_signups.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink/55">No signups yet.</p>
        ) : (
          <ul className="divide-y divide-ink/8">
            {data.recent_signups.map((u) => (
              <li key={u.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                <span className="font-mono text-[11px] text-ink/50 w-24 shrink-0">
                  {fmtRelative(u.created_at)}
                </span>
                <span className="font-medium truncate">{u.display_name ?? u.email.split('@')[0]}</span>
                <span className="font-mono text-xs text-ink/55 truncate flex-1 min-w-0 hidden sm:inline">
                  {u.email}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  {u.is_platform_admin && <AdminBadge />}
                  <StatusPill status={u.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
