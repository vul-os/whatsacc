// Shared plumbing for the instance-admin console: toasts, confirm dialog,
// pagination, search box, pills and formatting helpers. Instrument-panel
// style: sans for UI chrome, mono for data.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, isUnavailable } from '@/lib/api';
import { fromUnix } from '@/lib/time';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { cn } from '@/lib/cn';

// ── Formatting ──────────────────────────────────────────────────────────────
// Gateway admin timestamps are Unix seconds, not ISO strings — see api.ts's
// UnixSeconds doc comment.

export function fmtDateTime(sec: number): string {
  const d = fromUnix(sec);
  if (!d) return '—';
  return `${d.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

export function fmtDate(sec: number): string {
  const d = fromUnix(sec);
  if (!d) return '—';
  return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtRelative(sec: number | null): string {
  const d = fromUnix(sec);
  if (!d) return 'never';
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))} h ago`;
  if (ms < 30 * 24 * 60 * 60_000) return `${Math.round(ms / (24 * 60 * 60_000))} d ago`;
  return fmtDate(sec as number); // non-null: `d` above is only null when `sec` is
}

/** Friendly copy for the admin API's coded 400/403 errors. */
const ADMIN_ERROR_COPY: Record<string, string> = {
  not_platform_admin: 'Your platform-admin access has been revoked.',
  cannot_disable_self: "You can't disable your own user.",
  cannot_disable_last_admin:
    'This is the last active platform admin — grant someone else admin first.',
  cannot_revoke_last_admin:
    'This is the last active platform admin — grant someone else admin first.',
  claim_closed: 'This instance has already been claimed.',
  claim_disabled: 'Claiming is disabled — no ADMIN_CLAIM_TOKEN is configured on the server.',
  invalid_claim_token: "That token doesn't match the one configured on the server.",
  account_not_found: 'That account no longer exists.',
  user_not_found: 'That user no longer exists.',
  kill_switch_confirmation_required:
    'Setting this limit to 0 blocks ALL opens instance-wide — confirm the kill switch to proceed.',
};

export function adminErrorMessage(err: unknown): string {
  if (isUnavailable(err)) return "This isn't available on this gateway yet.";
  if (err instanceof ApiError) {
    return ADMIN_ERROR_COPY[err.code] ?? err.detail ?? err.code;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

// ── Toasts ──────────────────────────────────────────────────────────────────

type Toast = { id: number; text: string; tone: 'ok' | 'error' };

const ToastCtx = createContext<((text: string, tone?: Toast['tone']) => void) | null>(null);

export function useAdminToast() {
  const push = useContext(ToastCtx);
  if (!push) throw new Error('useAdminToast must be used inside AdminToastProvider');
  return push;
}

export function AdminToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      {toasts.length > 0 && (
        <div className="fixed bottom-5 right-5 z-[70] flex flex-col gap-2 max-w-sm" role="status">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cn(
                'rounded-xl border px-4 py-3 text-sm shadow-[0_12px_32px_-12px_rgba(0,0,0,0.35)] bg-paper',
                t.tone === 'ok' ? 'border-moss/40 text-ink' : 'border-terracotta/50 text-terracotta-deep',
              )}
            >
              <span className="inline-flex items-center gap-2">
                <span
                  className={cn('h-1.5 w-1.5 rounded-full shrink-0', t.tone === 'ok' ? 'bg-moss' : 'bg-terracotta')}
                  aria-hidden
                />
                {t.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

// ── Confirm dialog ──────────────────────────────────────────────────────────

export function ConfirmModal({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
  error,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open onClose={onClose}>
      <h2 className="font-display text-2xl mb-2">{title}</h2>
      <div className="text-sm text-ink/65 leading-relaxed">{body}</div>
      {error && (
        <p className="mt-3 text-sm text-terracotta-deep" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 mt-6">
        <button
          type="button"
          onClick={onClose}
          className="h-10 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
        >
          Cancel
        </button>
        <Button variant={danger ? 'primary' : 'ink'} onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

// ── Table chrome ────────────────────────────────────────────────────────────

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'text-left px-4 lg:px-5 py-3 text-[10px] uppercase tracking-[0.18em] text-ink/55 font-normal whitespace-nowrap',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn('px-4 lg:px-5 py-3 align-middle', className)}>{children}</td>;
}

export function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-moss/15 text-moss border border-moss/30',
    suspended: 'bg-terracotta/12 text-terracotta-deep border border-terracotta/35',
    disabled: 'bg-ink/8 text-ink/60 border border-ink/15',
    invited: 'bg-gold/15 text-gold border border-gold/35',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] whitespace-nowrap',
        styles[status] ?? 'bg-ink/8 text-ink/60 border border-ink/15',
      )}
    >
      {status}
    </span>
  );
}

export function AdminBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gold/15 border border-gold/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-gold whitespace-nowrap">
      <span className="h-1 w-1 rounded-full bg-gold" aria-hidden />
      admin
    </span>
  );
}

// ── Pagination ──────────────────────────────────────────────────────────────

export function Pagination({
  total,
  limit,
  offset,
  onOffset,
  busy,
}: {
  total: number;
  limit: number;
  offset: number;
  onOffset: (next: number) => void;
  busy?: boolean;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="flex items-center justify-between px-4 lg:px-5 py-3 border-t border-ink/10 text-xs text-ink/55">
      <span className="font-mono tabular-nums">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={busy || offset === 0}
          onClick={() => onOffset(Math.max(0, offset - limit))}
          className="h-8 px-3 rounded-full border border-ink/15 text-ink/70 hover:border-ink/40 hover:text-ink disabled:opacity-35 disabled:pointer-events-none transition-colors"
        >
          ← Prev
        </button>
        <button
          type="button"
          disabled={busy || offset + limit >= total}
          onClick={() => onOffset(offset + limit)}
          className="h-8 px-3 rounded-full border border-ink/15 text-ink/70 hover:border-ink/40 hover:text-ink disabled:opacity-35 disabled:pointer-events-none transition-colors"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

// ── Debounced search box ────────────────────────────────────────────────────

export function SearchBox({
  placeholder,
  onSearch,
}: {
  placeholder: string;
  onSearch: (q: string) => void;
}) {
  const [value, setValue] = useState('');
  const cbRef = useRef(onSearch);
  cbRef.current = onSearch;

  useEffect(() => {
    const t = window.setTimeout(() => cbRef.current(value.trim()), 300);
    return () => window.clearTimeout(t);
  }, [value]);

  return (
    <label className="flex items-center gap-2 h-10 w-full sm:w-72 rounded-xl bg-paper-cool border border-ink/15 px-3 focus-within:ring-2 focus-within:ring-ink/20 focus-within:border-ink/40 transition-colors">
      <svg viewBox="0 0 20 20" className="h-4 w-4 text-ink/40 shrink-0" fill="none" aria-hidden>
        <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M13.5 13.5 17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="flex-1 min-w-0 bg-transparent text-sm text-ink placeholder:text-ink/35 focus:outline-none"
      />
    </label>
  );
}

// ── Data loading helper ─────────────────────────────────────────────────────

/** Tiny fetch-into-state hook with reload support. */
export function useAdminLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadRef
      .current()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(adminErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return useMemo(
    () => ({ data, setData, error, loading, reload }),
    [data, error, loading, reload],
  );
}

export function LoadingRow({ label = 'Loading…' }: { label?: string }) {
  return <p className="px-5 py-8 text-sm text-ink/50">{label}</p>;
}

export function ErrorNote({ text }: { text: string }) {
  return (
    <p className="px-5 py-6 text-sm text-terracotta-deep" role="alert">
      {text}
    </p>
  );
}
