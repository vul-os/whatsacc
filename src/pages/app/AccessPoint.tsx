// Per-access-point detail page. Wired to /app/access-points/:id.
//
// Hero treatment: the AP becomes the page subject — its name displays at
// display-size, paired device + location render as kicker, and the open/close
// quick-action lives top-right. Below the hero: stat block (opens/movement/
// last op), maintenance progress + recent service log, and a back link to the
// access points index.

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ArchMark } from '@/components/illustrations/ArchMark';
import { useAuth } from '@/lib/auth';
import {
  ApiError,
  api,
  type AccessPointDetail,
  type LocationRow,
  type MaintenanceCreateInput,
  type MaintenanceEvent,
} from '@/lib/api';
import { cn } from '@/lib/cn';

type Stage = 'idle' | 'opening' | 'closing' | 'open' | 'error';

const FLIP_BACK_MS = 25_000;

function formatMeters(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${m.toFixed(0)} m`;
}

function relTime(ts: string | null): string {
  if (!ts) return '—';
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 0) return new Date(ts).toLocaleString();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

export default function AccessPointPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { currentAccount } = useAuth();
  const [ap, setAp] = useState<AccessPointDetail | null>(null);
  const [location, setLocation] = useState<LocationRow | null>(null);
  const [history, setHistory] = useState<MaintenanceEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [showMaintenance, setShowMaintenance] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const fresh = await api.accessPoint(id);
      setAp(fresh);
      setError(null);

      if (currentAccount) {
        const locs = await api.locationsList(currentAccount.id);
        setLocation(locs.locations.find((l) => l.id === fresh.location_id) ?? null);
      }

      const ev = await api.maintenanceList(id);
      setHistory(ev.events);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'access_point_not_found') {
        setError('This access point no longer exists.');
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to load access point.');
    }
  }, [id, currentAccount]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-revert local 'open' state after FLIP_BACK_MS so the button label
  // doesn't get stuck if the user wanders off.
  useEffect(() => {
    if (stage !== 'open') return;
    const t = window.setTimeout(() => setStage('idle'), FLIP_BACK_MS);
    return () => window.clearTimeout(t);
  }, [stage]);

  const send = useCallback(
    async (cmd: 'open' | 'close') => {
      if (!ap) return;
      setActionError(null);
      setStage(cmd === 'open' ? 'opening' : 'closing');

      const submit = async (lat?: number, long?: number) => {
        try {
          if (cmd === 'open') {
            await api.accessOpen(ap.id, { source: 'web', lat, long });
            setStage('open');
          } else {
            await api.accessClose(ap.id, { source: 'web', lat, long });
            setStage('idle');
          }
          // Refresh in the background so the meter + last op time update.
          refresh();
        } catch (err) {
          setStage('error');
          const msg =
            err instanceof ApiError
              ? err.detail ?? err.code
              : err instanceof Error
                ? err.message
                : 'Failed to send command.';
          setActionError(msg);
          window.setTimeout(() => setStage('idle'), 2400);
        }
      };

      if (!('geolocation' in navigator)) {
        submit();
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => submit(pos.coords.latitude, pos.coords.longitude),
        () => submit(),
        { timeout: 4000 },
      );
    },
    [ap, refresh],
  );

  if (error) {
    return (
      <Card className="border-terracotta/40">
        <p className="text-terracotta-deep mb-3">{error}</p>
        <Button variant="ink" size="sm" onClick={() => navigate('/app/access-points')}>
          Back to access points
        </Button>
      </Card>
    );
  }

  if (!ap) {
    return (
      <Card>
        <p className="text-ink/55 text-sm">Loading access point…</p>
      </Card>
    );
  }

  const isOpen = stage === 'open';
  const isPending = stage === 'opening' || stage === 'closing';
  const isError = stage === 'error';
  const statusOnline = ap.status === 'active' || ap.status === 'online';

  const pct = ap.maintenance.pct_used ?? 0;
  const due = ap.maintenance.due_now;

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-xs sm:text-[13px] text-ink/55">
        <Link to="/app" className="hover:text-ink transition-colors">
          Dashboard
        </Link>
        <span aria-hidden>/</span>
        <Link to="/app/access-points" className="hover:text-ink transition-colors">
          Access points
        </Link>
        <span aria-hidden>/</span>
        <span className="text-ink/85 truncate">{ap.name}</span>
      </nav>

      {/* Hero: name + paired device + quick action */}
      <Card tone="ink" className="relative overflow-hidden p-0">
        <div aria-hidden className="absolute inset-0 grid place-items-center pointer-events-none opacity-[0.06]">
          <ArchMark className="h-[460px] w-[460px] text-paper" />
        </div>

        <div className="relative p-6 sm:p-10 lg:p-14">
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-8">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-paper/55">
                <span className={cn('h-1 w-1 rounded-full', statusOnline ? 'bg-moss' : 'bg-terracotta')} aria-hidden />
                {ap.kind}{statusOnline ? ' · online' : ' · offline'}
              </span>
              <h1 className="font-display-tight text-4xl sm:text-5xl lg:text-6xl mt-3 leading-[1.02] tracking-[-0.02em]">
                {ap.name}
              </h1>
              <p className="mt-3 text-paper/65 text-sm sm:text-[15px]">
                {location ? (
                  <>
                    <Link
                      to="/app/settings"
                      className="underline underline-offset-4 decoration-paper/30 hover:decoration-paper"
                    >
                      {location.name}
                    </Link>
                    {' · '}
                  </>
                ) : null}
                {ap.device_id ? (
                  <>
                    paired to device <span className="font-mono text-paper/85">{ap.device_id.slice(0, 8)}</span>
                  </>
                ) : (
                  <span className="text-gold/85">no device paired</span>
                )}
              </p>
            </div>

            {/* Quick action */}
            <div className="lg:text-right">
              <motion.button
                type="button"
                disabled={isPending}
                onClick={() => send(isOpen ? 'close' : 'open')}
                whileTap={{ scale: 0.97 }}
                className={cn(
                  'relative inline-flex items-center justify-center gap-3 h-16 sm:h-[72px] min-w-[200px] rounded-full',
                  'font-medium text-base tracking-tight transition-colors',
                  'disabled:cursor-progress',
                  isOpen
                    ? 'bg-paper text-ink hover:bg-paper/90'
                    : 'bg-terracotta text-paper hover:bg-terracotta-deep shadow-[0_18px_44px_-18px_rgba(214,98,77,0.85)]',
                  isError && 'bg-terracotta/20 text-paper border border-terracotta/40',
                )}
              >
                {isPending && (
                  <span className="absolute inset-0 grid place-items-center">
                    <span className="relative h-7 w-7">
                      <span className="absolute inset-0 rounded-full bg-current opacity-25 signal-wave" />
                      <span className="absolute inset-2 rounded-full bg-current" />
                    </span>
                  </span>
                )}
                <span className={cn('inline-flex items-center gap-2.5', isPending && 'opacity-0')}>
                  {isOpen ? (
                    <>
                      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <path d="M5 12h14" strokeLinecap="round" />
                      </svg>
                      Close
                    </>
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M6 20V12a6 6 0 0 1 12 0v8" strokeLinejoin="round" />
                        <circle cx="12" cy="16" r="1.4" fill="currentColor" stroke="none" />
                      </svg>
                      Open
                    </>
                  )}
                </span>
              </motion.button>
              {actionError && (
                <p className="mt-3 text-[12px] text-terracotta">{actionError}</p>
              )}
              {isOpen && (
                <p className="mt-3 text-[11px] uppercase tracking-[0.18em] text-paper/55">
                  command sent · auto-resets in 25s
                </p>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Stat strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total opens" value={ap.meter.total_opens.toLocaleString()} />
        <StatCard label="Total closes" value={ap.meter.total_closes.toLocaleString()} />
        <StatCard label="Movement" value={formatMeters(ap.meter.movement_m)} />
        <StatCard label="Last op" value={relTime(ap.meter.last_op_at)} />
      </section>

      {/* Maintenance + recent activity */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-6 sm:p-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <span className="text-[11px] uppercase tracking-[0.22em] text-ink/55">Maintenance</span>
              <h2 className="font-display text-2xl mt-1">
                {due ? 'Service due' : 'On schedule'}
              </h2>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowMaintenance(true)}>
              Log service
            </Button>
          </div>

          {ap.maintenance.next_due_movement_m !== null ? (
            <>
              <div className="h-2 bg-ink/8 rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(100, Math.round(pct * 100))}%` }}
                  transition={{ duration: 0.7, ease: 'easeOut' }}
                  className={cn('h-full', due ? 'bg-terracotta' : pct > 0.75 ? 'bg-gold' : 'bg-moss')}
                />
              </div>
              <div className="mt-3 flex items-center justify-between text-sm text-ink/65">
                <span>
                  {ap.maintenance.movement_remaining_m !== null && ap.maintenance.movement_remaining_m > 0
                    ? `${formatMeters(ap.maintenance.movement_remaining_m)} until next service`
                    : 'Service threshold reached'}
                </span>
                <span className="text-ink/50">last serviced {relTime(ap.maintenance.last_serviced_at)}</span>
              </div>
            </>
          ) : (
            <p className="text-sm text-ink/55">
              No maintenance schedule set yet. Log your first service to start tracking.
            </p>
          )}

          {history && history.length > 0 && (
            <div className="mt-6 pt-5 border-t border-ink/10">
              <p className="text-[11px] uppercase tracking-[0.22em] text-ink/55 mb-3">Service log</p>
              <ul className="space-y-2.5">
                {history.slice(0, 5).map((ev) => (
                  <li
                    key={ev.id}
                    className="flex items-center justify-between text-sm border-b border-ink/5 last:border-b-0 pb-2.5"
                  >
                    <div className="min-w-0">
                      <p className="font-medium capitalize text-ink/90">{ev.kind}</p>
                      <p className="text-xs text-ink/55 truncate">
                        {new Date(ev.performed_at).toLocaleDateString()}
                        {ev.technician_name ? ` · ${ev.technician_name}` : ''}
                      </p>
                    </div>
                    <div className="text-right text-xs text-ink/55 shrink-0">
                      {ev.movement_m_at_event !== null && <p>at {formatMeters(ev.movement_m_at_event)}</p>}
                      {ev.cost_zar_cents !== null && <p>R {(ev.cost_zar_cents / 100).toFixed(2)}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card className="p-6 sm:p-8">
          <span className="text-[11px] uppercase tracking-[0.22em] text-ink/55">Hardware</span>
          <h2 className="font-display text-2xl mt-1 mb-5">Wiring</h2>
          <DefList>
            <DefRow label="Kind" value={ap.kind} />
            <DefRow label="Status" value={ap.status} />
            <DefRow
              label="Device"
              value={
                ap.device_id ? (
                  <Link
                    to="/app/devices"
                    className="font-mono text-xs hover:underline underline-offset-4 decoration-terracotta"
                  >
                    {ap.device_id.slice(0, 12)}…
                  </Link>
                ) : (
                  <span className="text-terracotta-deep text-xs">unpaired</span>
                )
              }
            />
            <DefRow
              label="Location"
              value={
                location ? (
                  <Link
                    to="/app/settings"
                    className="hover:underline underline-offset-4 decoration-terracotta"
                  >
                    {location.name}
                  </Link>
                ) : (
                  '—'
                )
              }
            />
          </DefList>
        </Card>
      </section>

      {showMaintenance && (
        <MaintenanceModal
          ap={ap}
          onClose={() => setShowMaintenance(false)}
          onSaved={() => {
            setShowMaintenance(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4 sm:p-5">
      <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-ink/55">{label}</p>
      <p className="font-display text-2xl sm:text-3xl mt-1.5 leading-none tabular-nums">{value}</p>
    </Card>
  );
}

function DefList({ children }: { children: React.ReactNode }) {
  return <dl className="space-y-3">{children}</dl>;
}

function DefRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-ink/8 pb-3 last:border-b-0 last:pb-0">
      <dt className="text-[11px] uppercase tracking-[0.18em] text-ink/55">{label}</dt>
      <dd className="text-sm text-ink/90 capitalize">{value}</dd>
    </div>
  );
}

// Lightweight maintenance modal — same shape as the one on the index page,
// inlined here so the detail page stays self-contained.
function MaintenanceModal({
  ap,
  onClose,
  onSaved,
}: {
  ap: AccessPointDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<MaintenanceCreateInput['kind']>('service');
  const [technician, setTechnician] = useState('');
  const [notes, setNotes] = useState('');
  const [costRand, setCostRand] = useState('');
  const [nextDueDays, setNextDueDays] = useState('180');
  const [nextDueMovement, setNextDueMovement] = useState('5000');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const body: MaintenanceCreateInput = {
        kind,
        technician_name: technician.trim() || undefined,
        notes: notes.trim() || undefined,
        cost_zar_cents: costRand.trim() ? Math.round(Number(costRand) * 100) : undefined,
        next_due_in_days:
          kind === 'inspection' ? undefined : nextDueDays.trim() ? Number(nextDueDays) : undefined,
        next_due_movement_m:
          kind === 'inspection' ? undefined : nextDueMovement.trim()
            ? Number(nextDueMovement)
            : undefined,
      };
      await api.maintenanceCreate(ap.id, body);
      onSaved();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'not_account_admin'
            ? 'Only account admins can log maintenance.'
            : err.detail ?? err.code
          : err instanceof Error
            ? err.message
            : 'Failed to log maintenance.';
      setErrorMsg(msg);
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} className="sm:max-w-lg">
      <h2 className="font-display text-2xl mb-1">Log maintenance</h2>
      <p className="text-sm text-ink/60 mb-6">
        {ap.name} · {formatMeters(ap.meter.movement_m)} · {ap.meter.total_opens.toLocaleString()} opens
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <fieldset>
          <legend className="text-sm font-medium text-ink/85 mb-2">Kind</legend>
          <div className="grid grid-cols-4 gap-2">
            {(['inspection', 'service', 'repair', 'replacement'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={cn(
                  'h-10 rounded-xl border text-xs capitalize transition-colors',
                  kind === k
                    ? 'bg-ink text-paper border-ink'
                    : 'bg-paper-cool text-ink border-ink/15 hover:border-ink/35',
                )}
              >
                {k}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Technician" value={technician} onChange={setTechnician} placeholder="e.g. Themba M." />
          <Field label="Cost (ZAR)" value={costRand} onChange={setCostRand} placeholder="0.00" type="number" />
        </div>
        <label className="block">
          <span className="text-sm font-medium text-ink/85">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="mt-1.5 w-full rounded-xl bg-paper-cool border border-ink/15 px-4 py-3 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
          />
        </label>
        {kind !== 'inspection' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Next service after (days)" value={nextDueDays} onChange={setNextDueDays} type="number" />
            <Field label="Next service after (m)" value={nextDueMovement} onChange={setNextDueMovement} type="number" />
          </div>
        )}
        {errorMsg && <p className="text-sm text-terracotta-deep">{errorMsg}</p>}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
          >
            Cancel
          </button>
          <Button type="submit" variant="ink" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save event'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-ink/85">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
      />
    </label>
  );
}
