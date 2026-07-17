// Accounts: searchable, paginated instance-wide account table. Row opens a
// detail drawer (members, locations, recent access logs) with a confirmed
// suspend/unsuspend action — optimistic, with toast + revert on failure.

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  api,
  type AdminAccountDetail,
  type AdminAccountRow,
} from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import {
  ConfirmModal,
  ErrorNote,
  LoadingRow,
  Pagination,
  SearchBox,
  StatusPill,
  Td,
  Th,
  adminErrorMessage,
  fmtDate,
  fmtDateTime,
  useAdminLoad,
  useAdminToast,
} from './shared';

const PAGE = 25;

export default function AdminAccounts() {
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, setData, error, loading } = useAdminLoad(
    () => api.adminAccounts({ query: query || undefined, limit: PAGE, offset }),
    [query, offset],
  );

  const patchRow = useCallback(
    (id: string, status: string) => {
      setData((d) =>
        d
          ? { ...d, accounts: d.accounts.map((a) => (a.id === id ? { ...a, status } : a)) }
          : d,
      );
    },
    [setData],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchBox
          placeholder="Search accounts by name…"
          onSearch={(q) => {
            setQuery(q);
            setOffset(0);
          }}
        />
        {data && (
          <span className="font-mono text-xs text-ink/50 tabular-nums">
            {data.total.toLocaleString()} account{data.total === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <Card className="p-0 overflow-hidden">
        {error ? (
          <ErrorNote text={error} />
        ) : !data ? (
          <LoadingRow />
        ) : data.accounts.length === 0 ? (
          <p className="px-5 py-8 text-sm text-ink/55">No accounts match.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink/10">
                    <Th>Account</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Members</Th>
                    <Th className="text-right">Locations</Th>
                    <Th className="text-right">Opens 7d</Th>
                    <Th>Created</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((a) => (
                    <tr
                      key={a.id}
                      onClick={() => setOpenId(a.id)}
                      className="border-b border-ink/8 last:border-0 hover:bg-paper-warm/40 cursor-pointer transition-colors"
                    >
                      <Td>
                        <span className="font-medium">{a.name}</span>
                        <span className="ml-2 font-mono text-[10px] uppercase text-ink/40">
                          {a.country_code}
                        </span>
                      </Td>
                      <Td>
                        <StatusPill status={a.status} />
                      </Td>
                      <Td className="text-right font-mono tabular-nums text-ink/75">
                        {a.member_count.toLocaleString()}
                      </Td>
                      <Td className="text-right font-mono tabular-nums text-ink/75">
                        {a.location_count.toLocaleString()}
                      </Td>
                      <Td className="text-right font-mono tabular-nums text-ink/75">
                        {a.opens_7d.toLocaleString()}
                      </Td>
                      <Td className="font-mono text-xs text-ink/55 whitespace-nowrap">
                        {fmtDate(a.created_at)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              total={data.total}
              limit={PAGE}
              offset={offset}
              onOffset={setOffset}
              busy={loading}
            />
          </>
        )}
      </Card>

      {openId && (
        <AccountDrawer
          id={openId}
          onClose={() => setOpenId(null)}
          onStatusChanged={patchRow}
        />
      )}
    </div>
  );
}

// ── Detail drawer ───────────────────────────────────────────────────────────

function AccountDrawer({
  id,
  onClose,
  onStatusChanged,
}: {
  id: string;
  onClose: () => void;
  onStatusChanged: (id: string, status: string) => void;
}) {
  const toast = useAdminToast();
  const [detail, setDetail] = useState<AdminAccountDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'active' | 'suspended' | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .adminAccount(id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) setError(adminErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  async function applyStatus(status: 'active' | 'suspended') {
    if (!detail) return;
    const prev = detail.account.status;
    setBusy(true);
    setConfirmError(null);
    // Optimistic: flip drawer + table row immediately, revert on failure.
    setDetail({ ...detail, account: { ...detail.account, status } });
    onStatusChanged(id, status);
    try {
      const r = await api.adminAccountSetStatus(id, status);
      setDetail((d) => (d ? { ...d, account: r.account } : d));
      onStatusChanged(id, r.account.status);
      setConfirming(null);
      toast(
        status === 'suspended'
          ? `${r.account.name} suspended — opens are now denied.`
          : `${r.account.name} reactivated.`,
      );
    } catch (err) {
      setDetail((d) => (d ? { ...d, account: { ...d.account, status: prev } } : d));
      onStatusChanged(id, prev);
      setConfirmError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const acct = detail?.account;
  const suspended = acct?.status === 'suspended';

  return createPortal(
    <div className="fixed inset-0 z-50" role="presentation">
      <button
        type="button"
        aria-label="Close account detail"
        onClick={onClose}
        className="absolute inset-0 w-full h-full bg-ink/55 backdrop-blur-sm"
      />
      <aside
        role="dialog"
        aria-modal
        className="absolute right-0 top-0 bottom-0 w-full max-w-xl bg-paper border-l border-ink/10 shadow-[0_0_64px_-16px_rgba(0,0,0,0.5)] overflow-y-auto overscroll-contain"
      >
        <div className="sticky top-0 bg-paper/95 backdrop-blur border-b border-ink/10 px-6 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.22em] text-ink/45">Account</p>
            <h2 className="font-display text-2xl truncate mt-0.5">{acct?.name ?? '…'}</h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="h-9 w-9 grid place-items-center rounded-full hover:bg-ink/5 shrink-0"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {error ? (
          <ErrorNote text={error} />
        ) : !detail || !acct ? (
          <LoadingRow />
        ) : (
          <div className="px-6 py-5 flex flex-col gap-6">
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill status={acct.status} />
              <span className="font-mono text-[10px] uppercase text-ink/45">{acct.country_code}</span>
              <span className="font-mono text-xs text-ink/50">created {fmtDate(acct.created_at)}</span>
              <span className="ml-auto">
                <Button
                  size="sm"
                  variant={suspended ? 'ink' : 'outline'}
                  className={suspended ? '' : 'border-terracotta/50 text-terracotta-deep hover:bg-terracotta hover:border-terracotta'}
                  onClick={() => setConfirming(suspended ? 'active' : 'suspended')}
                >
                  {suspended ? 'Unsuspend' : 'Suspend'}
                </Button>
              </span>
            </div>

            <section>
              <SectionHead label="Members" count={detail.members.length} />
              <ul className="divide-y divide-ink/8 border border-ink/8 rounded-xl overflow-hidden">
                {detail.members.map((m) => (
                  <li key={m.user_id} className="flex items-center gap-3 px-4 py-2.5 text-sm bg-paper-cool">
                    <span className="font-medium truncate">{m.display_name ?? m.email.split('@')[0]}</span>
                    <span className="font-mono text-xs text-ink/50 truncate flex-1 min-w-0 hidden sm:inline">
                      {m.email}
                    </span>
                    <span className="text-[10px] uppercase tracking-[0.16em] text-ink/55 shrink-0">
                      {m.role}
                    </span>
                    <StatusPill status={m.status} />
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <SectionHead label="Locations" count={detail.locations.length} />
              <ul className="divide-y divide-ink/8 border border-ink/8 rounded-xl overflow-hidden">
                {detail.locations.map((l) => (
                  <li key={l.id} className="flex items-center gap-3 px-4 py-2.5 text-sm bg-paper-cool">
                    <span className="font-medium truncate">{l.name}</span>
                    {l.slug && (
                      <span className="font-mono text-xs text-ink/45 truncate hidden sm:inline">/{l.slug}</span>
                    )}
                    <span className="ml-auto text-[10px] uppercase tracking-[0.16em] text-ink/50 shrink-0">
                      {l.type}
                    </span>
                    <StatusPill status={l.status} />
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <SectionHead label="Recent access logs" count={detail.recent_access_logs.length} />
              {detail.recent_access_logs.length === 0 ? (
                <p className="text-sm text-ink/50 px-1 py-2">No activity yet.</p>
              ) : (
                <ul className="divide-y divide-ink/8 border border-ink/8 rounded-xl overflow-hidden">
                  {detail.recent_access_logs.map((e) => (
                    <li key={e.id} className="flex items-center gap-3 px-4 py-2 text-xs bg-paper-cool">
                      <span className="font-mono text-[11px] text-ink/50 w-24 shrink-0">
                        {fmtDateTime(e.ts)}
                      </span>
                      <ResultDot success={e.success} command={e.command} error={e.error} />
                      <span className="truncate text-ink/75 flex-1 min-w-0">
                        {e.access_point_name ?? e.location_name ?? '—'}
                      </span>
                      <span className="font-mono text-ink/50 truncate max-w-[38%] hidden sm:inline">
                        {e.user_email ?? '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </aside>

      {confirming && acct && (
        <ConfirmModal
          title={confirming === 'suspended' ? `Suspend ${acct.name}?` : `Unsuspend ${acct.name}?`}
          body={
            confirming === 'suspended' ? (
              <p>
                All opens for this account will be <span className="text-terracotta-deep font-medium">denied immediately</span> —
                every gate, every channel. Members can still sign in and browse; they just can't
                open anything until you unsuspend. Each denied attempt is audit-logged as{' '}
                <span className="font-mono text-xs">account_suspended</span>.
              </p>
            ) : (
              <p>
                Opens resume immediately for all members and access points of this account.
              </p>
            )
          }
          confirmLabel={confirming === 'suspended' ? 'Suspend account' : 'Unsuspend'}
          danger={confirming === 'suspended'}
          busy={busy}
          error={confirmError}
          onConfirm={() => applyStatus(confirming)}
          onClose={() => {
            setConfirming(null);
            setConfirmError(null);
          }}
        />
      )}
    </div>,
    document.body,
  );
}

function SectionHead({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between mb-2">
      <h3 className="text-[11px] uppercase tracking-[0.2em] text-ink/55">{label}</h3>
      <span className="font-mono text-xs text-ink/45 tabular-nums">{count}</span>
    </div>
  );
}

export function ResultDot({
  success,
  command,
  error,
}: {
  success: boolean;
  command: string | null;
  error: string | null;
}) {
  let dot = 'bg-slate';
  let label = command ?? '—';
  if (success && command === 'open') dot = 'bg-moss';
  else if (success && command === 'close') dot = 'bg-ink';
  else if (!success) {
    label = error ?? 'denied';
    dot =
      error === 'rate_limited'
        ? 'bg-gold'
        : error === 'quota_exceeded'
          ? 'bg-terracotta'
          : error === 'account_suspended'
            ? 'bg-ink'
            : 'bg-terracotta';
  }
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0 uppercase tracking-wider text-[10px] text-ink/65 w-28">
      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', dot)} aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}
