import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { AccessPointAction } from '@/components/access/AccessPointAction';
import { CreateLocationModal } from '@/components/locations/CreateLocationModal';
import { useAuth } from '@/lib/auth';
import { useFormatZar } from '@/lib/billing/currency';
import { QuotaBanner } from '@/components/billing/QuotaBanner';
import {
  api,
  type AccessPointDetail,
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
  const { user, currentAccount, setCurrentAccount, refreshMe } = useAuth();
  const formatZar = useFormatZar();
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [billing, setBilling] = useState<AccountBilling | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [accessPoints, setAccessPoints] = useState<AccessPointDetail[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creatingLocation, setCreatingLocation] = useState(false);

  const refreshSummary = useCallback(async () => {
    if (!currentAccount) return;
    try {
      const s = await api.accountSummary(currentAccount.id);
      setSummary(s);
    } catch {
      // Silent — recent activity will just stay stale until next manual reload.
    }
  }, [currentAccount]);

  useEffect(() => {
    if (!currentAccount) return;
    let cancelled = false;
    Promise.all([
      api.accountSummary(currentAccount.id),
      api.accountBilling(currentAccount.id).catch(() => null),
      api.locationsList(currentAccount.id),
      api.accessPoints(currentAccount.id).catch(() => ({ access_points: [] })),
    ])
      .then(([s, b, l, ap]) => {
        if (cancelled) return;
        setSummary(s);
        setBilling(b);
        setLocations(l.locations);
        setAccessPoints(ap.access_points);
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
              cta={{ label: 'Create location', onClick: () => setCreatingLocation(true) }}
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

        {creatingLocation && (
          <CreateLocationModal
            onClose={() => setCreatingLocation(false)}
            onCreated={async (newAccountId) => {
              setCreatingLocation(false);
              await refreshMe();
              setCurrentAccount(newAccountId);
            }}
          />
        )}
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

        {currentAccount?.id && <QuotaBanner accountId={currentAccount.id} />}

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

        {/*
          Quick actions — premium per-AP buttons. This is the main thing
          users do, so it gets primary real estate. Empty state prompts the
          user to add an access point.
        */}
        <section className="flex flex-col gap-3 flex-1">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-ink/55">
                Quick access
              </p>
              <h2 className="font-display text-xl sm:text-2xl mt-1">
                {accessPoints.length === 0 ? 'Add your first gate' : 'Tap to open'}
              </h2>
            </div>
            <Link to="/app/access-points" className="text-sm text-ink/60 hover:text-ink shrink-0">
              {accessPoints.length === 0 ? 'Get started' : 'Manage'} →
            </Link>
          </div>

          {accessPoints.length === 0 ? (
            <Card className="p-6 sm:p-8 flex-1 flex flex-col items-center justify-center text-center">
              <p className="text-ink/65 text-sm max-w-md">
                Each gate, door or barrier is one access point. Add one and pair a device to start
                opening with a tap — or via WhatsApp once your number is linked.
              </p>
              <Link
                to="/app/access-points"
                className="mt-5 inline-flex items-center h-11 px-6 rounded-full bg-ink text-paper text-sm font-medium hover:bg-ink-soft transition-colors"
              >
                Add access point →
              </Link>
            </Card>
          ) : (
            <ul className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {accessPoints.slice(0, 8).map((ap) => (
                <li key={ap.id}>
                  <AccessPointAction ap={ap} onActivity={refreshSummary} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/*
        BELOW-THE-FOLD ZONE — the min-h on the hero above guarantees this
        section starts at or below the bottom of the initial viewport, so
        nothing here peeks through before the user scrolls.
      */}
      <section className="mt-10 sm:mt-14 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-0 overflow-hidden">
          <div className="px-5 sm:px-6 pt-5 pb-2 flex items-center justify-between">
            <h2 className="font-display text-xl sm:text-2xl">Recent activity</h2>
            <Link to="/app/analytics" className="text-sm text-ink/60 hover:text-ink">
              View all
            </Link>
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
                <li
                  key={a.id}
                  className="flex px-5 sm:px-6 py-3 items-center gap-3 text-sm"
                >
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
            <Link to="/app/settings" className="text-sm text-ink/60 hover:text-ink">
              Manage
            </Link>
          </div>
          {locations.length === 0 ? (
            <p className="text-ink/65 text-sm">
              No locations yet.{' '}
              <button
                type="button"
                onClick={() => setCreatingLocation(true)}
                className="underline underline-offset-4 decoration-terracotta hover:text-ink"
              >
                Create your first
              </button>
              .
            </p>
          ) : (
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
          )}
        </Card>
      </section>
    </>
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
  cta: { label: string; to: string } | { label: string; onClick: () => void };
  primary?: boolean;
}) {
  const ctaClass = `mt-3 inline-flex items-center h-10 px-5 rounded-full text-sm font-medium border transition-colors ${
    primary
      ? 'bg-terracotta text-paper border-terracotta hover:bg-terracotta-deep'
      : 'bg-paper-cool text-ink border-ink/15 hover:border-ink'
  }`;
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
        {'onClick' in cta ? (
          <button type="button" onClick={cta.onClick} className={ctaClass}>
            {cta.label} →
          </button>
        ) : (
          <Link to={cta.to} className={ctaClass}>
            {cta.label} →
          </Link>
        )}
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
