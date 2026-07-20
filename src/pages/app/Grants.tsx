import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import {
  ApiError,
  api,
  type AccessPointDetail,
  type GrantCreateInput,
  type TemporaryAccessGrant,
} from '@/lib/api';
import { fromUnix } from '@/lib/time';

const PHONE_E164 = /^\+[1-9][0-9]{6,14}$/;

function formatRelative(sec: number | null): string {
  const d = fromUnix(sec);
  if (!d) return '—';
  const ms = d.getTime() - Date.now();
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60_000);
  if (m < 60) return ms > 0 ? `in ${m} min` : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return ms > 0 ? `in ${h} h` : `${h} h ago`;
  const dAmt = Math.round(h / 24);
  return ms > 0 ? `in ${dAmt} d` : `${dAmt} d ago`;
}

function formatDateTime(sec: number): string {
  return fromUnix(sec)?.toLocaleString() ?? '—';
}

function defaultEndsAtIso(): string {
  // Next day, rounded to top of next hour.
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function Grants() {
  const [grants, setGrants] = useState<TemporaryAccessGrant[] | null>(null);
  const [accessPoints, setAccessPoints] = useState<AccessPointDetail[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<'all' | 'active' | 'past'>('all');

  const { currentAccount } = useAuth();
  const refresh = useCallback(async () => {
    if (!currentAccount) return;
    try {
      const [g, ap] = await Promise.all([
        api.grants({ account_id: currentAccount.id }),
        api.accessPoints(currentAccount.id),
      ]);
      setGrants(g.grants);
      setAccessPoints(ap.access_points);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load grants.');
    }
  }, [currentAccount]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!grants) return null;
    if (filter === 'all') return grants;
    if (filter === 'active') {
      return grants.filter((g) => g.effective_status === 'active' || g.effective_status === 'pending');
    }
    return grants.filter(
      (g) => g.effective_status === 'expired' || g.effective_status === 'exhausted' || g.effective_status === 'revoked',
    );
  }, [grants, filter]);

  return (
    <>
      <PageHeader
        kicker="Access"
        title="Temporary access"
        description="Grant a WhatsApp number access to specific gates for a time window. They don't need an account — just the number."
        actions={
          <Button
            variant="ink"
            onClick={() => setCreating(true)}
            disabled={accessPoints.length === 0}
          >
            New grant
          </Button>
        }
      />

      {error && (
        <Card className="mb-6 border-terracotta/40">
          <p className="text-sm text-terracotta-deep">{error}</p>
        </Card>
      )}

      <div className="mb-4 inline-flex rounded-full border border-ink/10 p-1 bg-paper-cool">
        {(['all', 'active', 'past'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 text-xs uppercase tracking-[0.18em] rounded-full transition-colors ${
              filter === f ? 'bg-ink text-paper' : 'text-ink/65 hover:text-ink'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {filtered === null ? (
        <Card>
          <p className="text-ink/55 text-sm">Loading…</p>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <p className="text-ink/65 text-sm">
            {accessPoints.length === 0
              ? 'Add an access point first, then you can grant temporary access to it.'
              : 'No grants match this filter.'}
          </p>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((g) => (
            <li key={g.id}>
              <GrantCard
                grant={g}
                accessPoints={accessPoints}
                onChange={refresh}
              />
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CreateGrantModal
          accessPoints={accessPoints}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}
    </>
  );
}

function GrantCard({
  grant,
  accessPoints,
  onChange,
}: {
  grant: TemporaryAccessGrant;
  accessPoints: AccessPointDetail[];
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const apMap = useMemo(() => new Map(accessPoints.map((a) => [a.id, a])), [accessPoints]);
  const targets = grant.access_point_ids
    .map((id) => apMap.get(id))
    .filter((a): a is AccessPointDetail => !!a);

  const tone: Record<typeof grant.effective_status, string> = {
    pending: 'bg-gold/15 text-ink/80',
    active: 'bg-moss/15 text-moss',
    expired: 'bg-ink/5 text-ink/55',
    exhausted: 'bg-ink/5 text-ink/55',
    revoked: 'bg-terracotta/15 text-terracotta-deep',
  };

  async function revoke() {
    if (!confirm('Revoke this grant? The number will lose access immediately.')) return;
    setBusy(true);
    try {
      await api.grantRevoke(grant.id);
      onChange();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not revoke grant.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between mb-3">
        <span
          className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] ${
            tone[grant.effective_status]
          }`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {grant.effective_status}
        </span>
        {grant.max_uses !== null && (
          <span className="text-[11px] uppercase tracking-[0.18em] text-ink/50">
            {grant.uses_count}/{grant.max_uses} uses
          </span>
        )}
      </div>

      <p className="font-display text-2xl">
        {grant.visitor_name ?? 'Visitor'}
      </p>
      <p className="text-sm text-ink/65 mt-1 font-mono">{grant.phone_e164}</p>

      <div className="mt-5 grid grid-cols-2 gap-3 text-xs text-ink/55">
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em]">From</p>
          <p className="text-ink mt-1">{formatDateTime(grant.starts_at)}</p>
          <p className="text-ink/50 mt-0.5">{formatRelative(grant.starts_at)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em]">Until</p>
          <p className="text-ink mt-1">{formatDateTime(grant.ends_at)}</p>
          <p className="text-ink/50 mt-0.5">{formatRelative(grant.ends_at)}</p>
        </div>
      </div>

      {targets.length > 0 && (
        <div className="mt-5 pt-4 border-t border-ink/10">
          <p className="text-[10px] uppercase tracking-[0.18em] text-ink/55 mb-2">
            Access points
          </p>
          <div className="flex flex-wrap gap-1.5">
            {targets.map((t) => (
              <span
                key={t.id}
                className="text-xs px-2 py-1 rounded-full bg-paper-cool border border-ink/10"
              >
                {t.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {grant.last_used_at && (
        <p className="text-xs text-ink/55 mt-4">
          Last used {formatRelative(grant.last_used_at)}
        </p>
      )}

      {grant.status === 'active' && (
        <button
          disabled={busy}
          onClick={revoke}
          className="mt-4 text-xs text-ink/65 hover:text-terracotta-deep underline underline-offset-4 decoration-terracotta"
        >
          {busy ? 'Revoking…' : 'Revoke now'}
        </button>
      )}
    </Card>
  );
}

function CreateGrantModal({
  accessPoints,
  onClose,
  onCreated,
}: {
  accessPoints: AccessPointDetail[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [phone, setPhone] = useState('+27');
  const [visitor, setVisitor] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState(defaultEndsAtIso());
  const [maxUses, setMaxUses] = useState('');
  const [selectedAps, setSelectedAps] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function toggleAp(id: string) {
    setSelectedAps((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);

    if (!PHONE_E164.test(phone)) {
      setErrorMsg('Phone must be E.164 format, e.g. +27821234567.');
      return;
    }
    if (selectedAps.size === 0) {
      setErrorMsg('Pick at least one access point.');
      return;
    }
    if (!endsAt) {
      setErrorMsg('Set an end date/time.');
      return;
    }
    const startsIso = startsAt ? new Date(startsAt).toISOString() : undefined;
    const endsIso = new Date(endsAt).toISOString();

    setSubmitting(true);
    try {
      const body: GrantCreateInput = {
        phone_e164: phone,
        visitor_name: visitor.trim() || undefined,
        starts_at: startsIso,
        ends_at: endsIso,
        max_uses: maxUses.trim() ? Number(maxUses) : undefined,
        access_point_ids: Array.from(selectedAps),
      };
      await api.grantCreate(body);
      onCreated();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'cross_account_grant'
            ? 'All selected access points must belong to the same account.'
            : err.code === 'not_account_admin'
              ? 'Only account admins can create grants.'
              : err.code === 'invalid_window'
                ? 'End time must be after start time.'
                : (err.detail ?? err.code)
          : err instanceof Error
            ? err.message
            : 'Could not create grant.';
      setErrorMsg(msg);
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} className="sm:max-w-2xl">
      <h2 className="font-display text-2xl mb-1">Grant temporary access</h2>
      <p className="text-sm text-ink/60 mb-5">
        Enter the visitor's WhatsApp number, the time window, and the access points they're allowed to operate.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-ink/85">Visitor name</span>
            <input
              value={visitor}
              onChange={(e) => setVisitor(e.target.value)}
              placeholder="e.g. Themba (electrician)"
              className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink/85">WhatsApp number</span>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+27821234567"
              className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] font-mono focus:outline-none focus:ring-2 focus:ring-ink"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-ink/85">Start (optional)</span>
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
            />
            <span className="block text-xs text-ink/45 mt-1">defaults to now</span>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink/85">End</span>
            <input
              type="datetime-local"
              required
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-sm font-medium text-ink/85">Max uses (optional)</span>
          <input
            type="number"
            min="1"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            placeholder="leave blank for unlimited"
            className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
          />
        </label>

        <fieldset>
          <legend className="text-sm font-medium text-ink/85">
            Which gates can this visitor open?
          </legend>
          <p className="text-xs text-ink/55 mt-0.5 mb-2">
            {accessPoints.length === 0
              ? "No access points at this location yet — add one first."
              : `${accessPoints.length} available · ${selectedAps.size} selected`}
          </p>
          {accessPoints.length > 0 && (
            <>
              <div className="flex items-center gap-3 mb-2 text-xs">
                <button
                  type="button"
                  onClick={() => setSelectedAps(new Set(accessPoints.map((a) => a.id)))}
                  className="underline underline-offset-4 decoration-terracotta text-ink/65 hover:text-ink"
                >
                  Select all
                </button>
                <span className="text-ink/25">·</span>
                <button
                  type="button"
                  onClick={() => setSelectedAps(new Set())}
                  className="underline underline-offset-4 decoration-ink/30 text-ink/65 hover:text-ink"
                >
                  Clear
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-auto pr-1">
                {accessPoints.map((ap) => (
                  <label
                    key={ap.id}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                      selectedAps.has(ap.id)
                        ? 'bg-ink/5 border-ink'
                        : 'bg-paper-cool border-ink/15 hover:border-ink/35'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedAps.has(ap.id)}
                      onChange={() => toggleAp(ap.id)}
                      className="accent-ink"
                    />
                    <span
                      className={`flex-none h-6 w-6 rounded-md grid place-items-center text-[10px] font-medium ${
                        ap.kind === 'gate'
                          ? 'bg-terracotta/15 text-terracotta-deep'
                          : ap.kind === 'door'
                            ? 'bg-moss/15 text-moss'
                            : ap.kind === 'barrier'
                              ? 'bg-gold/20 text-ink/80'
                              : 'bg-ink/10 text-ink/65'
                      }`}
                      aria-hidden
                    >
                      {ap.kind === 'gate' ? '⌐' : ap.kind === 'door' ? '▤' : ap.kind === 'barrier' ? '═' : '○'}
                    </span>
                    <span className="flex-1 text-sm">{ap.name}</span>
                    <span className="text-[10px] uppercase tracking-[0.18em] text-ink/50">
                      {ap.kind}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </fieldset>

        {errorMsg && <p className="text-sm text-terracotta-deep">{errorMsg}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
          >
            Cancel
          </button>
          <Button type="submit" variant="ink" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create grant'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
