import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { useAuth } from '@/lib/auth';
import { useFormatZar } from '@/lib/billing/currency';
import {
  api,
  type AccountBilling,
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
  if (yesterday === 0) {
    return today === 0 ? '—' : `+${today} new`;
  }
  const diff = today - yesterday;
  if (diff === 0) return 'same as yesterday';
  return `${diff > 0 ? '+' : ''}${diff} vs yesterday`;
}

export default function Dashboard() {
  const { user, currentAccount } = useAuth();
  const formatZar = useFormatZar();
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [billing, setBilling] = useState<AccountBilling | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentAccount) return;
    let cancelled = false;
    Promise.all([
      api.accountSummary(currentAccount.id),
      api.accountBilling(currentAccount.id).catch(() => null),
      api.locationsList(currentAccount.id),
    ])
      .then(([s, b, l]) => {
        if (cancelled) return;
        setSummary(s);
        setBilling(b);
        setLocations(l.locations);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load dashboard.');
      });
    return () => {
      cancelled = true;
    };
  }, [currentAccount]);

  const greeting = greetForHour(new Date().getHours());
  const firstName = user?.name?.split(' ')[0] ?? 'there';

  // Brand-new account: no locations yet — show focused onboarding instead.
  const isOnboarding = summary !== null && locations.length === 0;

  if (isOnboarding) {
    return (
      <>
        <PageHeader
          kicker="Welcome"
          title={`${greeting}, ${firstName}.`}
          description={`Let's get ${currentAccount?.name ?? 'your account'} set up. A couple of quick steps and you're opening gates with a text.`}
        />

        {error && (
          <Card className="mb-6 border-terracotta/40">
            <p className="text-sm text-terracotta-deep">{error}</p>
          </Card>
        )}

        <Card className="p-6 sm:p-8">
          <ol className="space-y-6">
            <OnboardStep
              n={1}
              title="Add your first location"
              body="A house, complex or building — wherever you want gates to open."
              cta={{ label: 'Create location', to: '/app/locations?new=1' }}
              primary
            />
            <OnboardStep
              n={2}
              title="Pair a device & add an access point"
              body="Each gate / door / barrier is one access point. You can do this without hardware — just create the access point now and pair later."
              cta={{ label: 'Hardware setup', to: '/app/devices' }}
            />
          </ol>
        </Card>
      </>
    );
  }

  return (
    <>
      {/*
        HERO ZONE — min-h reserves one viewport so anything after this section
        sits cleanly below the fold. Cards inside size naturally so each is
        always fully visible. Offsets account for AppTopBar (56/64px) + the
        main element's vertical padding (24/40px each side).
      */}
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

        {/* Stat strip — 2×2 mobile, 1×4 desktop. */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
          <Card className="bg-ink text-paper p-4 sm:p-5">
            <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-paper/55">
              Opens today
            </p>
            <p className="font-display text-3xl sm:text-4xl mt-1.5 sm:mt-2 leading-none tabular-nums">
              {summary ? summary.opens_today.toLocaleString() : '—'}
            </p>
            <p className="text-[10px] sm:text-xs text-paper/60 mt-1 sm:mt-1.5 truncate">
              {summary ? trendDelta(summary.opens_today, summary.opens_yesterday) : ''}
            </p>
          </Card>
          <Link to="/app/billing" className="block">
            <Card className="p-4 sm:p-5 h-full hover:border-ink/30 transition-colors">
              <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-ink/55">
                Wallet
              </p>
              <p className="font-display text-3xl sm:text-4xl mt-1.5 sm:mt-2 leading-none tabular-nums">
                {billing?.wallet ? formatZar(billing.wallet.balance_cents / 100) : formatZar(0)}
              </p>
              <p className="text-[10px] sm:text-xs text-ink/55 mt-1 sm:mt-1.5 truncate">
                {billing?.subscription ? `Plan: ${billing.subscription.plan_code}` : 'Top up →'}
              </p>
            </Card>
          </Link>
          <Card className="p-4 sm:p-5">
            <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-ink/55">
              Locations
            </p>
            <p className="font-display text-3xl sm:text-4xl mt-1.5 sm:mt-2 leading-none tabular-nums">
              {summary ? summary.location_count.toString() : '—'}
            </p>
            <p className="text-[10px] sm:text-xs text-ink/55 mt-1 sm:mt-1.5">active</p>
          </Card>
          <Card className="p-4 sm:p-5">
            <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-ink/55">
              Members
            </p>
            <p className="font-display text-3xl sm:text-4xl mt-1.5 sm:mt-2 leading-none tabular-nums">
              {summary ? summary.member_count.toString() : '—'}
            </p>
            <p className="text-[10px] sm:text-xs text-ink/55 mt-1 sm:mt-1.5">across portfolio</p>
          </Card>
        </section>

        {/* Activity (col-span-2) + Action tiles (col-span-1).
            flex-1 lets the activity card stretch to fill any remaining hero space. */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-2.5 sm:gap-3 flex-1">
          <Card className="lg:col-span-2 p-0 overflow-hidden flex flex-col">
            <div className="px-4 sm:px-6 pt-4 sm:pt-5 pb-2 flex items-center justify-between">
              <h2 className="font-display text-lg sm:text-xl">Recent activity</h2>
              <Link to="/app/analytics" className="text-sm text-ink/60 hover:text-ink">
                View all
              </Link>
            </div>
            {summary === null ? (
              <p className="px-4 sm:px-6 py-4 text-ink/55 text-sm">Loading…</p>
            ) : summary.recent_activity.length === 0 ? (
              <div className="px-4 sm:px-6 py-8 text-center flex-1 flex flex-col items-center justify-center">
                <p className="text-ink/65 text-sm">No activity yet.</p>
                <p className="text-ink/45 text-xs mt-1.5">
                  Once a gate opens, the latest events land here.
                </p>
                <Link
                  to="/app/open"
                  className="inline-flex items-center h-9 px-4 mt-4 rounded-full text-xs border border-ink/15 hover:border-ink"
                >
                  Open a gate →
                </Link>
              </div>
            ) : (
              <ul className="divide-y divide-ink/10">
                {summary.recent_activity.slice(0, 5).map((a, i) => (
                  <li
                    key={a.id}
                    className={`${i < 2 ? 'flex' : i < 3 ? 'hidden sm:flex' : 'hidden lg:flex'} px-4 sm:px-6 py-2.5 sm:py-3 items-center gap-2.5 sm:gap-3 text-xs sm:text-sm`}
                  >
                    <span className="font-mono text-[10px] sm:text-xs text-ink/55 w-10 sm:w-12 shrink-0">
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

          {/* Action tiles — side-by-side on mobile, stacked on desktop. */}
          <div className="grid grid-cols-2 lg:grid-cols-1 gap-2.5 sm:gap-3 lg:content-start">
            <ActionTile to="/app/locations?new=1" label="Add location" accent="ink" />
            <ActionTile to="/app/access-points" label="Add access point" accent="terracotta" />
          </div>
        </section>
      </div>

      {/*
        BELOW-THE-FOLD ZONE — the min-h on the hero above guarantees this
        section starts at or below the bottom of the initial viewport, so
        nothing here peeks through before the user scrolls.
      */}
      <section className="mt-10 sm:mt-14">
        <Card>
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-display text-2xl">Your locations</h2>
            <Link to="/app/locations" className="text-sm text-ink/60 hover:text-ink">
              Manage all
            </Link>
          </div>
          {locations.length === 0 ? (
            <p className="text-ink/65 text-sm">
              No locations yet.{' '}
              <Link to="/app/locations" className="underline underline-offset-4 decoration-terracotta">
                Create your first
              </Link>
              .
            </p>
          ) : (
            <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {locations.slice(0, 4).map((loc) => (
                <li
                  key={loc.id}
                  className="rounded-2xl border border-ink/10 p-5 hover:border-ink/30 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] uppercase tracking-[0.18em] text-ink/50">
                      {loc.type}
                    </span>
                    <span className="text-xs text-ink/45">
                      {(loc.address?.city as string | undefined) ?? '—'}
                    </span>
                  </div>
                  <p className="font-display text-xl mt-2">{loc.name}</p>
                  <p className="text-sm text-ink/55 mt-2">
                    {loc.access_point_count} access point{loc.access_point_count === 1 ? '' : 's'} ·{' '}
                    {loc.member_count} member{loc.member_count === 1 ? '' : 's'}
                  </p>
                  <p className="text-xs text-ink/45 mt-3">
                    last opened {loc.last_opened_at ? relativeTime(loc.last_opened_at) : '—'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </>
  );
}

function ActionTile({
  to,
  label,
  accent,
}: {
  to: string;
  label: string;
  accent: 'ink' | 'terracotta';
}) {
  const iconBg = accent === 'ink' ? 'bg-ink text-paper' : 'bg-terracotta text-paper';
  return (
    <Link
      to={to}
      className="group flex items-center gap-3 rounded-2xl border border-ink/10 bg-paper-warm/60 px-4 py-3.5 hover:border-ink/30 hover:bg-paper-warm transition-colors"
    >
      <span className={`grid h-9 w-9 place-items-center rounded-lg shrink-0 ${iconBg}`}>
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
      </span>
      <span className="font-medium text-sm flex-1 truncate">{label}</span>
      <span
        aria-hidden
        className="text-ink/30 group-hover:text-ink group-hover:translate-x-0.5 transition-all shrink-0"
      >
        →
      </span>
    </Link>
  );
}

function greetForHour(h: number): string {
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function OnboardStep({
  n,
  title,
  body,
  cta,
  primary = false,
}: {
  n: number;
  title: string;
  body: string;
  cta: { label: string; to: string };
  primary?: boolean;
}) {
  return (
    <li className="flex items-start gap-5">
      <span
        className={`flex-none mt-1 inline-flex items-center justify-center h-9 w-9 rounded-full border text-sm font-medium ${
          primary ? 'bg-ink text-paper border-ink' : 'bg-paper-cool text-ink/65 border-ink/15'
        }`}
      >
        {n}
      </span>
      <div className="flex-1">
        <p className="font-display text-xl">{title}</p>
        <p className="text-sm text-ink/65 mt-1.5 max-w-2xl">{body}</p>
        <Link
          to={cta.to}
          className={`mt-3 inline-flex items-center h-10 px-5 rounded-full text-sm font-medium border transition-colors ${
            primary
              ? 'bg-terracotta text-paper border-terracotta hover:bg-terracotta-deep'
              : 'bg-paper-cool text-ink border-ink/15 hover:border-ink'
          }`}
        >
          {cta.label} →
        </Link>
      </div>
    </li>
  );
}

function Verdict({ command, success }: { command: string; success: boolean }) {
  let dot = 'bg-slate';
  let label: string = command;
  if (command === 'open' && success) {
    dot = 'bg-moss';
    label = 'open';
  } else if (command === 'close' && success) {
    dot = 'bg-ink';
    label = 'close';
  } else if (!success) {
    dot = 'bg-terracotta';
    label = 'denied';
  }
  return (
    <span className="inline-flex items-center gap-1.5 sm:gap-2 w-14 sm:w-20 text-[10px] sm:text-xs text-ink/70 uppercase tracking-wider shrink-0">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
