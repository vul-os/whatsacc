import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import {
  ApiError,
  api,
  type AccessPointDetail,
  type MaintenanceCreateInput,
  type MaintenanceEvent,
} from '@/lib/api';

const statusStyles: Record<string, string> = {
  active: 'bg-moss/15 text-moss',
  online: 'bg-moss/15 text-moss',
  offline: 'bg-terracotta/15 text-terracotta-deep',
  pending: 'bg-gold/20 text-ink/80',
};

function formatMeters(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${m.toFixed(1)} m`;
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
  if (d < 60) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}

export default function AccessPointsPage() {
  const [points, setPoints] = useState<AccessPointDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openMaintenanceFor, setOpenMaintenanceFor] = useState<AccessPointDetail | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.accessPoints();
      setPoints(r.access_points);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load access points.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <>
      <PageHeader
        kicker="Hardware"
        title="Access points"
        description="Each access point is one physical opening — gate, door, or barrier — wired through one device. Maintenance tracking advances on every successful op."
        actions={<Button variant="ink">Add access point</Button>}
      />

      {error && (
        <Card className="mb-6 border-terracotta/40">
          <p className="text-sm text-terracotta-deep">{error}</p>
        </Card>
      )}

      {points === null ? (
        <Card>
          <p className="text-ink/55 text-sm">Loading access points…</p>
        </Card>
      ) : points.length === 0 ? (
        <Card>
          <p className="text-ink/65 text-sm">
            No access points yet. Add one and pair a device to start tracking opens.
          </p>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {points.map((ap) => (
            <li key={ap.id}>
              <AccessPointCard
                ap={ap}
                onLogMaintenance={() => setOpenMaintenanceFor(ap)}
              />
            </li>
          ))}
        </ul>
      )}

      {openMaintenanceFor && (
        <MaintenanceModal
          ap={openMaintenanceFor}
          onClose={() => setOpenMaintenanceFor(null)}
          onSaved={() => {
            setOpenMaintenanceFor(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

function AccessPointCard({
  ap,
  onLogMaintenance,
}: {
  ap: AccessPointDetail;
  onLogMaintenance: () => void;
}) {
  const due = ap.maintenance.due_now;
  const pct = ap.maintenance.pct_used ?? 0;
  return (
    <Card className="p-6">
      <div className="flex items-start justify-between mb-3">
        <span
          className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] ${
            statusStyles[ap.status] ?? 'bg-ink/5 text-ink/60'
          }`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {ap.status}
        </span>
        <span className="text-[11px] uppercase tracking-[0.18em] text-ink/50">{ap.kind}</span>
      </div>
      <p className="font-display text-2xl">{ap.name}</p>
      <p className="text-sm text-ink/60 mt-1">
        {ap.device_id ? `device ${ap.device_id.slice(0, 8)}…` : 'unpaired'}
      </p>

      <div className="mt-5 grid grid-cols-3 gap-3 text-center">
        <Stat label="opens" value={ap.meter.total_opens.toLocaleString()} />
        <Stat label="movement" value={formatMeters(ap.meter.movement_m)} />
        <Stat label="last op" value={relTime(ap.meter.last_op_at)} />
      </div>

      <div className="mt-5 pt-4 border-t border-ink/10">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] uppercase tracking-[0.18em] text-ink/55">Maintenance</span>
          {due ? (
            <span className="text-[10px] uppercase tracking-[0.18em] px-2 py-0.5 rounded-full bg-terracotta/15 text-terracotta-deep">
              due
            </span>
          ) : ap.maintenance.next_due_movement_m !== null || ap.maintenance.next_due_at !== null ? (
            <span className="text-[10px] uppercase tracking-[0.18em] text-ink/45">on track</span>
          ) : (
            <span className="text-[10px] uppercase tracking-[0.18em] text-ink/45">no schedule</span>
          )}
        </div>

        {ap.maintenance.next_due_movement_m !== null && (
          <>
            <div className="h-1.5 bg-ink/8 rounded-full overflow-hidden">
              <div
                className={`h-full ${due ? 'bg-terracotta' : pct > 0.75 ? 'bg-gold' : 'bg-moss'}`}
                style={{ width: `${Math.min(100, Math.round(pct * 100))}%` }}
              />
            </div>
            <p className="text-xs text-ink/60 mt-2">
              {ap.maintenance.movement_remaining_m !== null && ap.maintenance.movement_remaining_m > 0
                ? `${formatMeters(ap.maintenance.movement_remaining_m)} until next service`
                : 'Service threshold reached'}
            </p>
          </>
        )}

        <div className="mt-3 flex items-center justify-between text-xs text-ink/55">
          <span>last serviced {relTime(ap.maintenance.last_serviced_at)}</span>
          <button
            onClick={onLogMaintenance}
            className="underline underline-offset-4 decoration-terracotta hover:text-ink"
          >
            Log service
          </button>
        </div>
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-display text-lg leading-none">{value}</p>
      <p className="text-[10px] uppercase tracking-[0.18em] text-ink/50 mt-1">{label}</p>
    </div>
  );
}

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
  const [history, setHistory] = useState<MaintenanceEvent[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .maintenanceList(ap.id)
      .then((r) => {
        if (!cancelled) setHistory(r.events);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [ap.id]);

  async function onSubmit(e: FormEvent) {
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
    <Modal open onClose={onClose} className="sm:max-w-2xl">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="font-display text-2xl">Log maintenance</h2>
        <span className="text-[11px] uppercase tracking-[0.18em] text-ink/50">{ap.name}</span>
      </div>
      <p className="text-sm text-ink/60 mb-6">
        Current movement {formatMeters(ap.meter.movement_m)} · {ap.meter.total_opens.toLocaleString()} opens.
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
                className={`h-10 rounded-xl border text-xs capitalize transition-colors ${
                  kind === k
                    ? 'bg-ink text-paper border-ink'
                    : 'bg-paper-cool text-ink border-ink/15 hover:border-ink/35'
                }`}
              >
                {k}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Technician"
            value={technician}
            onChange={setTechnician}
            placeholder="e.g. Themba M."
          />
          <Field
            label="Cost (ZAR)"
            value={costRand}
            onChange={setCostRand}
            placeholder="0.00"
            type="number"
          />
        </div>

        <label className="block">
          <span className="text-sm font-medium text-ink/85">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="mt-1.5 w-full rounded-xl bg-paper-cool border border-ink/15 px-4 py-3 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
            placeholder="What was done, parts replaced, observed wear, etc."
          />
        </label>

        {kind !== 'inspection' && (
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Next service after (days)"
              value={nextDueDays}
              onChange={setNextDueDays}
              type="number"
              hint="calendar"
            />
            <Field
              label="Next service after (m)"
              value={nextDueMovement}
              onChange={setNextDueMovement}
              type="number"
              hint="movement"
            />
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

      {history && history.length > 0 && (
        <div className="mt-8 pt-6 border-t border-ink/10">
          <p className="text-[11px] uppercase tracking-[0.22em] text-ink/55 mb-3">History</p>
          <ul className="space-y-2 max-h-48 overflow-auto pr-2">
            {history.map((ev) => (
              <li
                key={ev.id}
                className="flex items-center justify-between text-sm border-b border-ink/5 pb-2"
              >
                <div>
                  <p className="font-medium capitalize">{ev.kind}</p>
                  <p className="text-xs text-ink/55">
                    {new Date(ev.performed_at).toLocaleDateString()}
                    {ev.technician_name ? ` · ${ev.technician_name}` : ''}
                  </p>
                </div>
                <div className="text-right text-xs text-ink/55">
                  {ev.movement_m_at_event !== null && (
                    <p>at {formatMeters(ev.movement_m_at_event)}</p>
                  )}
                  {ev.cost_zar_cents !== null && (
                    <p>R {(ev.cost_zar_cents / 100).toFixed(2)}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-ink/85">{label}</span>
        {hint && <span className="text-xs text-ink/50">{hint}</span>}
      </span>
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
