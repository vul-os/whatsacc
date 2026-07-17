// Usage & limits instrument panel for one location.
//
// Shows the abuse-protection quotas (dash = unlimited), today's usage against
// the location cap, the caller's own opens, and a per-member top list — all in
// the app's mono-data card style. Admins (owner/admin role on the account) can
// edit both caps inline; each numeric field pairs with an "unlimited" toggle.
// Saves are optimistic: the readout flips immediately, then reverts with an
// error toast if the PATCH fails.
//
// Data: GET /locations/:id/limits (member-visible) + PATCH (admin-only).

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/lib/auth';
import {
  ApiError,
  api,
  type LocationLimits,
  type LocationQuotaPatch,
  type LocationQuotas,
} from '@/lib/api';
import { cn } from '@/lib/cn';

function fmtCap(cap: number | null): string {
  return cap === null ? '—' : cap.toLocaleString();
}

function resetTime(dayStart: string): string {
  const t = new Date(new Date(dayStart).getTime() + 24 * 3_600_000);
  return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function LocationLimitsPanel({
  locationId,
  locationName,
  className,
}: {
  locationId: string;
  locationName?: string;
  className?: string;
}) {
  const { currentAccount } = useAuth();
  const isAdmin =
    currentAccount?.role === 'owner' || currentAccount?.role === 'admin';

  const [data, setData] = useState<LocationLimits | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((kind: 'ok' | 'error', text: string) => {
    setToast({ kind, text });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4_500);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.locationLimits(locationId);
      setData(r);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof ApiError
          ? (err.detail ?? err.code)
          : err instanceof Error
            ? err.message
            : 'Failed to load limits.',
      );
    }
  }, [locationId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Optimistic save: flip the visible quotas immediately, revert on failure.
  const save = useCallback(
    async (patch: LocationQuotaPatch, next: LocationQuotas) => {
      if (!data) return;
      const prev = data.quotas;
      setData({ ...data, quotas: next });
      setEditing(false);
      try {
        const r = await api.locationLimitsUpdate(locationId, patch);
        setData((d) => (d ? { ...d, quotas: r.quotas } : d));
        showToast('ok', 'Limits updated.');
      } catch (err) {
        setData((d) => (d ? { ...d, quotas: prev } : d));
        const msg =
          err instanceof ApiError
            ? err.code === 'not_account_admin'
              ? 'Only account admins can change limits.'
              : (err.detail ?? err.code)
            : err instanceof Error
              ? err.message
              : 'Could not save limits.';
        showToast('error', msg);
      }
    },
    [data, locationId, showToast],
  );

  const cap = data?.quotas.max_opens_per_location_per_day ?? null;
  const used = data?.usage.location_opens_today ?? 0;
  const pct = cap !== null && cap > 0 ? used / cap : null;
  const barColor =
    pct === null ? 'bg-moss' : pct >= 1 ? 'bg-terracotta' : pct >= 0.8 ? 'bg-gold' : 'bg-moss';

  return (
    <Card className={cn('p-6 sm:p-8 relative', className)}>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <span className="text-[11px] uppercase tracking-[0.22em] text-ink/55">
            Usage &amp; limits
          </span>
          <h2 className="font-display text-2xl mt-1">Daily opens</h2>
          <p className="text-sm text-ink/55 mt-1">
            {locationName ? `${locationName} · ` : ''}counted per UTC day
            {data ? ` · resets ${resetTime(data.usage.day_start)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {toast && (
            <p
              role="status"
              className={cn(
                'text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-full',
                toast.kind === 'ok'
                  ? 'bg-moss/15 text-moss'
                  : 'bg-terracotta/15 text-terracotta-deep',
              )}
            >
              {toast.text}
            </p>
          )}
          {isAdmin && data && !editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit limits
            </Button>
          )}
        </div>
      </div>

      {loadError ? (
        <p className="text-sm text-terracotta-deep" role="alert">{loadError}</p>
      ) : data === null ? (
        <p className="text-sm text-ink/55">Loading limits…</p>
      ) : editing ? (
        <LimitsEditor quotas={data.quotas} onCancel={() => setEditing(false)} onSave={save} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Location-wide gauge */}
          <div className="lg:col-span-2">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-4xl sm:text-5xl leading-none tabular-nums">
                {used.toLocaleString()}
              </span>
              <span className="font-mono text-sm text-ink/55 tabular-nums">
                / {fmtCap(cap)}
              </span>
              <span className="text-[11px] uppercase tracking-[0.18em] text-ink/45 ml-1">
                location opens today
              </span>
            </div>

            {cap !== null ? (
              <>
                <div className="mt-4 h-2 bg-ink/8 rounded-full overflow-hidden">
                  <div
                    className={cn('h-full transition-[width] duration-500', barColor)}
                    style={{ width: `${Math.min(100, Math.round((pct ?? 0) * 100))}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-ink/55 font-mono tabular-nums">
                  {Math.min(999, Math.round((pct ?? 0) * 100))}% of daily cap
                  {pct !== null && pct >= 1
                    ? ' · cap reached'
                    : cap - used > 0
                      ? ` · ${(cap - used).toLocaleString()} remaining`
                      : ''}
                </p>
              </>
            ) : (
              <p className="mt-3 text-xs text-ink/50">
                No location cap set — opens are unlimited for this location.
              </p>
            )}

            <dl className="mt-6 grid grid-cols-2 gap-4 max-w-sm">
              <div>
                <dt className="text-[10px] uppercase tracking-[0.18em] text-ink/50">
                  Per-member cap
                </dt>
                <dd className="font-mono text-lg tabular-nums mt-1">
                  {fmtCap(data.quotas.max_opens_per_member_per_day)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-[0.18em] text-ink/50">
                  Your opens today
                </dt>
                <dd className="font-mono text-lg tabular-nums mt-1">
                  {data.usage.my_opens_today.toLocaleString()}
                  {data.quotas.max_opens_per_member_per_day !== null && (
                    <span className="text-ink/50 text-sm">
                      {' '}/ {data.quotas.max_opens_per_member_per_day.toLocaleString()}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          </div>

          {/* Per-member top list */}
          <div>
            <p className="text-[11px] uppercase tracking-[0.22em] text-ink/55 mb-3">
              Top members today
            </p>
            {data.usage.members.length === 0 ? (
              <p className="text-sm text-ink/50">No opens yet today.</p>
            ) : (
              <ul className="space-y-2">
                {data.usage.members.slice(0, 6).map((m, i) => (
                  <li
                    key={m.user_id ?? `anon-${i}`}
                    className="flex items-center justify-between gap-3 border-b border-ink/8 pb-2 last:border-b-0"
                  >
                    <span className="font-mono text-xs text-ink/75 truncate">
                      {m.email ?? (m.user_id ? `${m.user_id.slice(0, 8)}…` : 'visitor / grant')}
                    </span>
                    <span className="font-mono text-sm tabular-nums shrink-0">
                      {m.opens_today.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── Admin editor ────────────────────────────────────────────────────────────

function LimitsEditor({
  quotas,
  onCancel,
  onSave,
}: {
  quotas: LocationQuotas;
  onCancel: () => void;
  onSave: (patch: LocationQuotaPatch, next: LocationQuotas) => Promise<void> | void;
}) {
  const [memberUnlimited, setMemberUnlimited] = useState(
    quotas.max_opens_per_member_per_day === null,
  );
  const [locationUnlimited, setLocationUnlimited] = useState(
    quotas.max_opens_per_location_per_day === null,
  );
  const [memberCap, setMemberCap] = useState(
    quotas.max_opens_per_member_per_day?.toString() ?? '',
  );
  const [locationCap, setLocationCap] = useState(
    quotas.max_opens_per_location_per_day?.toString() ?? '',
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function parseCap(unlimited: boolean, raw: string, label: string): number | null | 'invalid' {
    if (unlimited) return null;
    const n = Number(raw.trim());
    if (!raw.trim() || !Number.isInteger(n) || n < 1) {
      setErrorMsg(`${label} must be a whole number of at least 1, or unlimited.`);
      return 'invalid';
    }
    return n;
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    const member = parseCap(memberUnlimited, memberCap, 'Per-member cap');
    if (member === 'invalid') return;
    const location = parseCap(locationUnlimited, locationCap, 'Location cap');
    if (location === 'invalid') return;
    onSave(
      {
        max_opens_per_member_per_day: member,
        max_opens_per_location_per_day: location,
      },
      {
        max_opens_per_member_per_day: member,
        max_opens_per_location_per_day: location,
      },
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5 max-w-xl">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <CapField
          label="Per-member cap"
          hint="opens / member / day"
          value={memberCap}
          onChange={setMemberCap}
          unlimited={memberUnlimited}
          onToggleUnlimited={setMemberUnlimited}
        />
        <CapField
          label="Location cap"
          hint="opens / location / day"
          value={locationCap}
          onChange={setLocationCap}
          unlimited={locationUnlimited}
          onToggleUnlimited={setLocationUnlimited}
        />
      </div>

      {errorMsg && (
        <p className="text-sm text-terracotta-deep" role="alert">{errorMsg}</p>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="h-10 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
        >
          Cancel
        </button>
        <Button type="submit" variant="ink">Save limits</Button>
      </div>
    </form>
  );
}

function CapField({
  label,
  hint,
  value,
  onChange,
  unlimited,
  onToggleUnlimited,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  unlimited: boolean;
  onToggleUnlimited: (v: boolean) => void;
}) {
  return (
    <div className="rounded-xl border border-ink/10 bg-paper/45 p-4">
      <span className="flex items-baseline justify-between mb-2">
        <span className="text-sm font-medium text-ink/85">{label}</span>
        <span className="text-[10px] uppercase tracking-[0.14em] text-ink/45">{hint}</span>
      </span>
      <input
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        value={unlimited ? '' : value}
        onChange={(e) => onChange(e.target.value)}
        disabled={unlimited}
        placeholder={unlimited ? 'unlimited' : 'e.g. 50'}
        className={cn(
          'w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 font-mono text-[15px] tabular-nums',
          'focus:outline-none focus:ring-2 focus:ring-ink',
          unlimited && 'opacity-50 cursor-not-allowed',
        )}
      />
      <label className="mt-2.5 flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={unlimited}
          onChange={(e) => onToggleUnlimited(e.target.checked)}
          className="h-4 w-4 rounded border-ink/30 accent-[var(--terracotta)]"
        />
        <span className="text-xs text-ink/65">Unlimited</span>
      </label>
    </div>
  );
}
