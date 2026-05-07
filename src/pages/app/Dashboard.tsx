import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from './AppLayout';
import { Card, StatBlock } from '@/components/ui/Card';
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

  // Brand-new account: no locations yet. Show a focused onboarding panel
  // instead of empty stats cards. Loading state still falls through to the
  // normal layout so we don't flash an empty-state on initial render.
  const isOnboarding = summary !== null && locations.length === 0;

  if (isOnboarding) {
    return (
      <>
        <PageHeader
          kicker="Welcome"
          title={`${greeting}, ${firstName}.`}
          description={`Let's get ${currentAccount?.name ?? 'your account'} set up. Three quick steps and you're opening gates with a text.`}
        />

        {error && (
          <Card className="mb-6 border-terracotta/40">
            <p className="text-sm text-terracotta-deep">{error}</p>
          </Card>
        )}

        <section className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <Card className="lg:col-span-12 p-8">
            <ol className="space-y-6">
              <OnboardStep
                n={1}
                title="Add your first location"
                body="A house, a complex, a building — wherever you want gates to open. You can add as many as you like."
                cta={{ label: 'Create location', to: '/app/locations?new=1' }}
                primary
              />
              <OnboardStep
                n={2}
                title="Pair a device & add an access point"
                body="Each gate / door / barrier is one access point, optionally bound to a paired controller. You can do this without hardware — just create the access point now and pair later."
                cta={{ label: 'Hardware setup', to: '/app/devices' }}
              />
              <OnboardStep
                n={3}
                title="Invite your team"
                body="Send invitations to admins, members, or viewers. Each one gets an email with a join link."
                cta={{ label: 'Invite members', to: '/app/members' }}
              />
            </ol>
          </Card>

          <Card className="lg:col-span-12 p-6">
            <p className="text-[11px] uppercase tracking-[0.18em] text-ink/50 mb-2">
              Need a hand?
            </p>
            <p className="text-sm text-ink/70">
              The{' '}
              <Link to="/docs" className="underline underline-offset-4 decoration-terracotta">
                docs
              </Link>{' '}
              walk through pairing devices and configuring access. Or jump straight to{' '}
              <Link to="/app/billing" className="underline underline-offset-4 decoration-terracotta">
                billing
              </Link>{' '}
              if you want to top up your wallet first.
            </p>
          </Card>
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeader
        kicker="Today"
        title={`${greeting}, ${firstName}.`}
        description={
          summary
            ? summary.opens_today > 0
              ? `${summary.opens_today.toLocaleString()} ${summary.opens_today === 1 ? 'gate has' : 'gates have'} been opened today across your portfolio.`
              : 'No opens yet today. The system is quiet.'
            : 'Loading your portfolio…'
        }
      />

      {error && (
        <Card className="mb-6 border-terracotta/40">
          <p className="text-sm text-terracotta-deep">{error}</p>
        </Card>
      )}

      <section className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <Card className="lg:col-span-8 p-0 overflow-hidden">
          <div className="px-6 lg:px-8 pt-7 pb-2 flex items-center justify-between">
            <h2 className="font-display text-2xl">Recent activity</h2>
            <Link to="/app/analytics" className="text-sm text-ink/60 hover:text-ink">
              View all
            </Link>
          </div>
          {summary === null ? (
            <p className="px-6 lg:px-8 py-6 text-ink/55 text-sm">Loading…</p>
          ) : summary.recent_activity.length === 0 ? (
            <p className="px-6 lg:px-8 py-6 text-ink/65 text-sm">No activity yet.</p>
          ) : (
            <ul className="divide-y divide-ink/10">
              {summary.recent_activity.map((a) => (
                <li
                  key={a.id}
                  className="px-6 lg:px-8 py-3.5 flex items-center gap-4 text-sm hover:bg-paper-warm/50 transition-colors"
                >
                  <span className="font-mono text-xs text-ink/55 w-12 shrink-0">{shortTime(a.ts)}</span>
                  <Verdict command={a.command} success={a.success} />
                  <span className="font-medium truncate">
                    {a.actor_email ?? <span className="text-ink/55">unknown</span>}
                  </span>
                  <span className="text-ink/35 hidden sm:inline">·</span>
                  <span className="text-ink/65 flex-1 min-w-0 truncate hidden sm:inline">
                    {a.access_point_name ?? a.location_name ?? '—'}
                  </span>
                  {a.source && (
                    <span className="text-[10px] uppercase tracking-[0.18em] text-ink/45 hidden md:inline">
                      {a.source}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="lg:col-span-4 grid grid-cols-2 gap-4 content-start">
          <Card className="col-span-2 bg-ink text-paper">
            <StatBlock
              label="Opens today"
              value={summary ? summary.opens_today.toLocaleString() : '—'}
              hint={summary ? trendDelta(summary.opens_today, summary.opens_yesterday) : ''}
              className="text-paper [&_*]:!text-paper"
            />
          </Card>
          <Card>
            <StatBlock
              label="Locations"
              value={summary ? summary.location_count.toString() : '—'}
              hint="active"
            />
          </Card>
          <Card>
            <StatBlock
              label="Members"
              value={summary ? summary.member_count.toString() : '—'}
              hint="across portfolio"
            />
          </Card>
          <Card className="col-span-2 bg-paper-warm">
            <p className="text-[11px] uppercase tracking-[0.18em] text-ink/55 mb-3">Wallet</p>
            <p className="font-display text-3xl">
              {billing?.wallet
                ? formatZar(billing.wallet.balance_cents / 100)
                : formatZar(0)}
            </p>
            <p className="text-sm text-ink/60 mt-1">
              {billing?.subscription
                ? `Plan: ${billing.subscription.plan_code}`
                : 'No active plan'}
            </p>
            <Link
              to="/app/billing"
              className="text-xs text-ink/60 hover:text-ink underline underline-offset-4 mt-3 inline-block"
            >
              Top up →
            </Link>
          </Card>
        </div>

        <Card className="lg:col-span-12">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-display text-2xl">Locations</h2>
            <Link to="/app/locations" className="text-sm text-ink/60 hover:text-ink">
              Manage
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
              {locations.map((loc) => (
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
    <span className="inline-flex items-center gap-2 w-20 text-xs text-ink/70 uppercase tracking-wider shrink-0">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
