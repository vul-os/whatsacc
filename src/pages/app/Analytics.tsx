import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from './AppLayout';
import { Card, StatBlock } from '@/components/ui/Card';
import { useAuth } from '@/lib/auth';
import { api, type AccountInsights } from '@/lib/api';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function dayLabel(iso: string): string {
  // `iso` is YYYY-MM-DD from Postgres ::date — parse as local midnight.
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return DOW[new Date(y, m - 1, d).getDay()];
}

function weekDelta(curr: number, prev: number): string {
  if (prev === 0) return curr === 0 ? 'no prior week data' : 'first week of activity';
  const pct = Math.round(((curr - prev) / prev) * 100);
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct}% week-over-week`;
}

function deniedRate(denied: number, opens: number): string {
  const total = denied + opens;
  if (total === 0) return '0% of attempts';
  return `${Math.round((denied / total) * 100)}% of attempts`;
}

// This page's endpoint (/analytics/accounts/:id/insights) exists on the
// reference Cloudflare Workers backend but isn't ported to the Go gateway
// yet (see gateway/README.md's porting map: "routes/analytics.ts — planned").
// An unrouted gateway path doesn't always come back as a clean error — the
// embedded portal's SPA fallback can answer with a 200 + HTML body instead
// of JSON — so we validate the response shape rather than trust "it didn't
// throw" before treating it as real data.
function isRealInsights(data: unknown): data is AccountInsights {
  if (!data || typeof data !== 'object') return false;
  const d = data as Partial<AccountInsights>;
  return Array.isArray(d.days) && typeof d.totals === 'object' && d.totals !== null;
}

export default function Analytics() {
  const { currentAccount } = useAuth();
  const [insights, setInsights] = useState<AccountInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    if (!currentAccount) return;
    setLoading(true);
    setUnavailable(false);
    try {
      const data = await api.accountInsights(currentAccount.id);
      if (isRealInsights(data)) {
        setInsights(data);
      } else {
        // Endpoint answered but not with insights data — treat the same as
        // "not available" rather than rendering a fabricated empty state.
        setInsights(null);
        setUnavailable(true);
      }
    } catch {
      setInsights(null);
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, [currentAccount]);

  useEffect(() => { load(); }, [load]);

  const days = insights?.days ?? [];
  const breakdown = insights?.breakdown ?? [];
  const totals = insights?.totals;
  const members = insights?.members;

  const maxBar = Math.max(1, ...days.map((d) => d.opens + d.denied));
  const maxBreakdown = Math.max(1, ...breakdown.map((b) => b.opens));

  return (
    <>
      <PageHeader
        kicker="Insights"
        title="Analytics"
        description="The shape of your week. Use this when you're sizing up a plan or chasing down anomalies."
      />

      {loading ? (
        <p className="py-20 text-center text-ink/45 text-sm">Loading…</p>
      ) : unavailable ? (
        <Card className="p-6 sm:p-10 text-center">
          <p className="font-display text-xl mb-2">Analytics aren&rsquo;t available on this gateway yet</p>
          <p className="text-sm text-ink/60 max-w-md mx-auto leading-relaxed">
            This view runs on the reference backend but hasn&rsquo;t shipped in the
            self-hosted Go gateway. Every open, close and denial is still recorded in
            your audit log — this chart just isn&rsquo;t wired up to read it yet.
          </p>
        </Card>
      ) : (
        <>
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
            <Card>
              <StatBlock
                label="Opens · 7d"
                value={(totals?.opens_7d ?? 0).toLocaleString()}
                hint={totals ? weekDelta(totals.opens_7d, totals.opens_prev_7d) : ''}
              />
            </Card>
            <Card>
              <StatBlock
                label="Denied · 7d"
                value={(totals?.denied_7d ?? 0).toLocaleString()}
                hint={totals ? deniedRate(totals.denied_7d, totals.opens_7d) : ''}
              />
            </Card>
            <Card>
              <StatBlock
                label="Closes · 7d"
                value={(totals?.closes_7d ?? 0).toLocaleString()}
                hint="successful close commands"
              />
            </Card>
            <Card>
              <StatBlock
                label="Active members"
                value={(members?.active_members_7d ?? 0).toString()}
                hint={members ? `of ${members.member_count}` : ''}
              />
            </Card>
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

              {days.every((d) => d.opens === 0 && d.denied === 0) ? (
                <p className="h-60 sm:h-72 flex items-center justify-center text-ink/55 text-sm text-center px-6">
                  No activity in the last 7 days yet — once gates start opening, this is where the rhythm shows up.
                </p>
              ) : (
                <div className="flex items-end gap-1.5 sm:gap-3 h-60 sm:h-72 px-1 sm:px-2 overflow-hidden">
                  {days.map((d) => (
                    <div key={d.day} className="flex-1 flex flex-col items-center gap-2">
                      <div className="w-full flex-1 flex items-end gap-1">
                        <span
                          className="flex-1 bg-ink rounded-t-md"
                          style={{ height: `${(d.opens / maxBar) * 100}%` }}
                        />
                        <span
                          className="w-2 bg-terracotta rounded-t-sm self-end"
                          style={{ height: `${(d.denied / maxBar) * 100 + (d.denied > 0 ? 4 : 0)}%` }}
                        />
                      </div>
                      <span className="text-[11px] uppercase tracking-[0.18em] text-ink/45">
                        {dayLabel(d.day)}
                      </span>
                      <span className="font-display text-sm">{d.opens}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="lg:col-span-4">
              <h2 className="font-display text-2xl mb-4">By access point</h2>
              {breakdown.length === 0 ? (
                <p className="text-ink/55 text-sm py-6">
                  No opens recorded yet — top access points will appear here.
                </p>
              ) : (
                <ul className="space-y-3">
                  {breakdown.map((b) => {
                    const label = b.location_name && b.access_point_name
                      ? `${b.location_name} · ${b.access_point_name}`
                      : (b.access_point_name ?? b.location_name ?? 'Unnamed');
                    return (
                      <li key={b.access_point_id}>
                        <div className="flex items-baseline justify-between mb-1.5 text-sm">
                          <span className="text-ink/80 truncate pr-3">{label}</span>
                          <span className="font-display tabular-nums">{b.opens}</span>
                        </div>
                        <div className="h-1.5 bg-ink/10 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-ink"
                            style={{ width: `${(b.opens / maxBreakdown) * 100}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
