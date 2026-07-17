import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { AccessPointAction } from '@/components/access/AccessPointAction';
import { CreateAccessPointModal } from '@/components/access/CreateAccessPointModal';
import { useAuth } from '@/lib/auth';
import {
  api,
  type AccessPointDetail,
  type AccountSummary,
  type LocationRow,
} from '@/lib/api';

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))} h ago`;
  return new Date(iso).toLocaleDateString();
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function trendDelta(today: number, yesterday: number): string {
  if (yesterday === 0) return today === 0 ? '—' : `+${today} new`;
  const diff = today - yesterday;
  if (diff === 0) return 'same as yesterday';
  return `${diff > 0 ? '+' : ''}${diff} vs yesterday`;
}

function greetForHour(h: number): string {
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function Dashboard() {
  const { user, currentAccount } = useAuth();
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [accessPoints, setAccessPoints] = useState<AccessPointDetail[]>([]);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreateAp, setShowCreateAp] = useState(false);

  const refreshSummary = useCallback(async () => {
    if (!currentAccount) return;
    try {
      const s = await api.accountSummary(currentAccount.id);
      setSummary(s);
    } catch {
      // silent — stays stale
    }
  }, [currentAccount]);

  const load = useCallback(async () => {
    if (!currentAccount) return;
    setDataLoaded(false);
    try {
      const [s, l, ap] = await Promise.all([
        api.accountSummary(currentAccount.id),
        api.locationsList(currentAccount.id),
        api.accessPoints(currentAccount.id).catch(() => ({ access_points: [] })),
      ]);
      setSummary(s);
      setLocations(l.locations);
      setAccessPoints(ap.access_points);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard.');
    } finally {
      setDataLoaded(true);
    }
  }, [currentAccount]);

  useEffect(() => { load(); }, [load]);

  const greeting = greetForHour(new Date().getHours());
  const firstName = user?.name?.split(' ')[0] ?? 'there';

  // Wait for data before deciding which screen to show — avoids flash.
  if (!dataLoaded) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-ink/40 text-sm">
        Loading…
      </div>
    );
  }

  // No access points yet → show onboarding instead of an empty dashboard.
  if (accessPoints.length === 0) {
    return (
      <>
        <Onboarding
          greeting={greeting}
          firstName={firstName}
          locationName={locations[0]?.name ?? currentAccount?.name}
          onAddAccessPoint={() => setShowCreateAp(true)}
        />
        {showCreateAp && (
          <CreateAccessPointModal
            onClose={() => setShowCreateAp(false)}
            onCreated={() => {
              setShowCreateAp(false);
              load();
            }}
          />
        )}
      </>
    );
  }

  // Regular dashboard — user has at least one access point.
  return (
    <>
      <div className="flex flex-col gap-3 sm:gap-4 min-h-[calc(100svh-7rem)] sm:min-h-[calc(100svh-9rem)]">
        <header className="flex items-end justify-between gap-3 flex-wrap">
          <h1 className="font-display-tight text-2xl sm:text-3xl lg:text-[36px] leading-tight tracking-[-0.02em] min-w-0">
            {greeting}, <span className="text-terracotta">{firstName}</span>.
          </h1>
          {summary && (
            <p className="text-xs sm:text-sm text-ink/55 shrink-0">
              {summary.opens_today > 0
                ? `${summary.opens_today.toLocaleString()} ${summary.opens_today === 1 ? 'open' : 'opens'} today`
                : 'Quiet today.'}
            </p>
          )}
        </header>

        {error && (
          <Card className="border-terracotta/40 p-4">
            <p className="text-sm text-terracotta-deep">{error}</p>
          </Card>
        )}

        <section className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
          <Card className="bg-ink text-paper p-4 sm:p-5">
            <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-paper/55">Opens today</p>
            <p className="font-display text-3xl sm:text-4xl mt-1.5 sm:mt-2 leading-none tabular-nums">
              {summary ? summary.opens_today.toLocaleString() : '—'}
            </p>
            <p className="text-[10px] sm:text-xs text-paper/60 mt-1 sm:mt-1.5 truncate">
              {summary ? trendDelta(summary.opens_today, summary.opens_yesterday) : ''}
            </p>
          </Card>
          <Card className="p-4 sm:p-5">
            <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-ink/55">Locations</p>
            <p className="font-display text-3xl sm:text-4xl mt-1.5 sm:mt-2 leading-none tabular-nums">
              {summary ? summary.location_count.toString() : '—'}
            </p>
            <p className="text-[10px] sm:text-xs text-ink/55 mt-1 sm:mt-1.5">active</p>
          </Card>
          <Card className="p-4 sm:p-5">
            <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-ink/55">Members</p>
            <p className="font-display text-3xl sm:text-4xl mt-1.5 sm:mt-2 leading-none tabular-nums">
              {summary ? summary.member_count.toString() : '—'}
            </p>
            <p className="text-[10px] sm:text-xs text-ink/55 mt-1 sm:mt-1.5">across portfolio</p>
          </Card>
        </section>

        <section className="flex flex-col gap-3 flex-1">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-ink/55">Quick access</p>
              <h2 className="font-display text-xl sm:text-2xl mt-1">Tap to open</h2>
            </div>
            <Link to="/app/access-points" className="text-sm text-ink/60 hover:text-ink shrink-0">
              Manage →
            </Link>
          </div>
          <ul className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {accessPoints.slice(0, 8).map((ap) => (
              <li key={ap.id}>
                <AccessPointAction ap={ap} onActivity={refreshSummary} />
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="mt-10 sm:mt-14 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-0 overflow-hidden">
          <div className="px-5 sm:px-6 pt-5 pb-2 flex items-center justify-between">
            <h2 className="font-display text-xl sm:text-2xl">Recent activity</h2>
            <Link to="/app/analytics" className="text-sm text-ink/60 hover:text-ink">View all</Link>
          </div>
          {summary === null ? (
            <p className="px-5 sm:px-6 py-6 text-ink/55 text-sm">Loading…</p>
          ) : summary.recent_activity.length === 0 ? (
            <p className="px-5 sm:px-6 py-6 text-ink/55 text-sm">
              No activity yet — opens and closes will appear here.
            </p>
          ) : (
            <ul className="divide-y divide-ink/10">
              {summary.recent_activity.slice(0, 6).map((a) => (
                <li key={a.id} className="flex px-5 sm:px-6 py-3 items-center gap-3 text-sm">
                  <span className="font-mono text-[11px] text-ink/55 w-12 shrink-0">
                    {shortTime(a.ts)}
                  </span>
                  <Verdict command={a.command} success={a.success} />
                  <span className="font-medium truncate">
                    {a.actor_email ?? <span className="text-ink/55">unknown</span>}
                  </span>
                  <span className="text-ink/65 flex-1 min-w-0 truncate hidden md:inline">
                    {a.access_point_name ?? a.location_name ?? '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-display text-xl sm:text-2xl">Locations</h2>
            <Link to="/app/settings" className="text-sm text-ink/60 hover:text-ink">Manage</Link>
          </div>
          <ul className="space-y-2.5">
            {locations.slice(0, 5).map((loc) => (
              <li
                key={loc.id}
                className="flex items-baseline justify-between border-b border-ink/8 pb-2.5 last:border-b-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{loc.name}</p>
                  <p className="text-[11px] text-ink/55 mt-0.5">
                    {loc.access_point_count} pt{loc.access_point_count === 1 ? '' : 's'}
                    {loc.last_opened_at ? ` · ${relativeTime(loc.last_opened_at)}` : ''}
                  </p>
                </div>
                <span className="text-[10px] uppercase tracking-[0.18em] text-ink/45 shrink-0 ml-3">
                  {loc.type}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </>
  );
}

// ─── Onboarding ──────────────────────────────────────────────────────────────

function Onboarding({
  greeting,
  firstName,
  locationName,
  onAddAccessPoint,
}: {
  greeting: string;
  firstName: string;
  locationName: string | undefined;
  onAddAccessPoint: () => void;
}) {
  return (
    <div className="max-w-2xl">
      <div className="mb-10">
        <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-ink/50 mb-3">
          <span className="h-1 w-1 rounded-full bg-terracotta" />
          Getting started
        </span>
        <h1 className="font-display-tight text-3xl sm:text-4xl lg:text-[40px] leading-[1.02] tracking-[-0.02em]">
          {greeting}, <span className="text-terracotta">{firstName}</span>.
        </h1>
        <p className="mt-3 text-[15px] text-ink/60 leading-relaxed">
          {locationName
            ? `${locationName} is ready. One more step before your first gate opens.`
            : 'Your account is ready. One more step before your first gate opens.'}
        </p>
      </div>

      {/* Stepper */}
      <div className="relative">
        {/* Connector line */}
        <div className="absolute left-[19px] top-10 bottom-10 w-px bg-ink/10" aria-hidden />

        <ol className="space-y-0">
          <Step
            n={1}
            status="done"
            title="Account & location"
            body="Your account is created and your location is confirmed with a verified address."
          />
          <Step
            n={2}
            status="active"
            title="Add your first access point"
            body="A gate, door, or barrier — the physical entry point you'll control from WhatsApp or the dashboard. Takes under a minute."
            cta={
              <button
                type="button"
                onClick={onAddAccessPoint}
                className="mt-4 inline-flex items-center h-11 px-6 rounded-full bg-terracotta text-paper text-sm font-medium hover:bg-terracotta-deep transition-colors"
              >
                Add access point →
              </button>
            }
          />
          <Step
            n={3}
            status="upcoming"
            title="Invite your team"
            body="Add members so they can open gates too — residents, staff, or visitors."
            cta={
              <Link
                to="/app/members"
                className="mt-3 inline-flex items-center h-9 px-4 rounded-full border border-ink/15 text-sm text-ink/50 hover:border-ink/35 hover:text-ink/70 transition-colors"
              >
                Go to Members →
              </Link>
            }
          />
        </ol>
      </div>
    </div>
  );
}

function Step({
  n,
  status,
  title,
  body,
  cta,
}: {
  n: number;
  status: 'done' | 'active' | 'upcoming';
  title: string;
  body: string;
  cta?: React.ReactNode;
}) {
  const isDone = status === 'done';
  const isActive = status === 'active';

  return (
    <li className="flex gap-5 pb-8 last:pb-0">
      {/* Step indicator */}
      <div className="flex-none flex flex-col items-center">
        <div
          className={`relative z-10 flex items-center justify-center h-10 w-10 rounded-full text-sm font-semibold transition-colors ${
            isDone
              ? 'bg-moss text-paper'
              : isActive
                ? 'bg-ink text-paper'
                : 'bg-paper border-2 border-ink/15 text-ink/30'
          }`}
        >
          {isDone ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Done">
              <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            n
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 pt-1.5 pb-2">
        <p
          className={`font-display text-xl leading-tight ${
            isDone ? 'text-ink/50' : isActive ? 'text-ink' : 'text-ink/30'
          }`}
        >
          {title}
        </p>
        <p
          className={`mt-1.5 text-sm leading-relaxed ${
            isDone ? 'text-ink/40' : isActive ? 'text-ink/65' : 'text-ink/30'
          }`}
        >
          {body}
        </p>
        {cta && <div className={isActive ? '' : 'opacity-40 pointer-events-none'}>{cta}</div>}
      </div>
    </li>
  );
}

function Verdict({ command, success }: { command: string; success: boolean }) {
  let dot = 'bg-slate';
  let label: string = command;
  if (command === 'open' && success) { dot = 'bg-moss'; label = 'open'; }
  else if (command === 'close' && success) { dot = 'bg-ink'; label = 'close'; }
  else if (!success) { dot = 'bg-terracotta'; label = 'denied'; }
  return (
    <span className="inline-flex items-center gap-1.5 sm:gap-2 w-14 sm:w-20 text-[10px] sm:text-xs text-ink/70 uppercase tracking-wider shrink-0">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
