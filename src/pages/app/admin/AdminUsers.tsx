// Users: searchable, paginated instance-wide user table with moderation
// actions — disable/enable and grant/revoke platform admin, both confirmed.
// Backend guard-rails (cannot_disable_self / last-admin) get friendly copy.

import { useState } from 'react';
import { api, type AdminUserRow } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { useAuth } from '@/lib/auth';
import {
  AdminBadge,
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
  fmtRelative,
  useAdminLoad,
  useAdminToast,
} from './shared';

const PAGE = 25;

type PendingAction =
  | { kind: 'status'; user: AdminUserRow; next: 'active' | 'disabled' }
  | { kind: 'admin'; user: AdminUserRow; grant: boolean };

export default function AdminUsers() {
  const { user: me } = useAuth();
  const toast = useAdminToast();
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const { data, setData, error, loading } = useAdminLoad(
    () => api.adminUsers({ query: query || undefined, limit: PAGE, offset }),
    [query, offset],
  );

  function patchRow(id: string, patch: Partial<AdminUserRow>) {
    setData((d) =>
      d ? { ...d, users: d.users.map((u) => (u.id === id ? { ...u, ...patch } : u)) } : d,
    );
  }

  async function runPending() {
    if (!pending) return;
    setBusy(true);
    setConfirmError(null);
    try {
      if (pending.kind === 'status') {
        const r = await api.adminUserSetStatus(pending.user.id, pending.next);
        patchRow(pending.user.id, { status: r.user.status, is_platform_admin: r.user.is_platform_admin });
        toast(
          pending.next === 'disabled'
            ? `${r.user.email} disabled — sessions revoked.`
            : `${r.user.email} re-enabled.`,
        );
      } else {
        const r = await api.adminUserSetPlatformAdmin(pending.user.id, pending.grant);
        patchRow(pending.user.id, { status: r.user.status, is_platform_admin: r.user.is_platform_admin });
        toast(
          pending.grant
            ? `${r.user.email} is now a platform admin.`
            : `Platform admin revoked from ${r.user.email}.`,
        );
      }
      setPending(null);
    } catch (err) {
      setConfirmError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchBox
          placeholder="Search users by email…"
          onSearch={(q) => {
            setQuery(q);
            setOffset(0);
          }}
        />
        {data && (
          <span className="font-mono text-xs text-ink/50 tabular-nums">
            {data.total.toLocaleString()} user{data.total === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <Card className="p-0 overflow-hidden">
        {error ? (
          <ErrorNote text={error} />
        ) : !data ? (
          <LoadingRow />
        ) : data.users.length === 0 ? (
          <p className="px-5 py-8 text-sm text-ink/55">No users match.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink/10">
                    <Th>User</Th>
                    <Th>Status</Th>
                    <Th>Accounts</Th>
                    <Th>Last activity</Th>
                    <Th>Joined</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => {
                    const isSelf = u.id === me?.id;
                    const disabled = u.status === 'disabled';
                    return (
                      <tr key={u.id} className="border-b border-ink/8 last:border-0 hover:bg-paper-warm/40 transition-colors">
                        <Td>
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="min-w-0">
                              <p className="font-medium truncate">
                                {u.display_name ?? u.email.split('@')[0]}
                                {isSelf && <span className="ml-1.5 text-[10px] text-ink/45">(you)</span>}
                              </p>
                              <p className="font-mono text-[11px] text-ink/55 truncate">{u.email}</p>
                            </div>
                            {u.is_platform_admin && <AdminBadge />}
                          </div>
                        </Td>
                        <Td>
                          <StatusPill status={u.status} />
                        </Td>
                        <Td>
                          {u.accounts.length === 0 ? (
                            <span className="text-ink/40 text-xs">—</span>
                          ) : (
                            <span className="text-xs text-ink/70">
                              {u.accounts
                                .slice(0, 2)
                                .map((a) => a.name)
                                .join(', ')}
                              {u.accounts.length > 2 && (
                                <span className="font-mono text-ink/45"> +{u.accounts.length - 2}</span>
                              )}
                            </span>
                          )}
                        </Td>
                        <Td className="font-mono text-xs text-ink/60 whitespace-nowrap">
                          {fmtRelative(u.last_access_at)}
                        </Td>
                        <Td className="font-mono text-xs text-ink/55 whitespace-nowrap">
                          {fmtDate(u.created_at)}
                        </Td>
                        <Td className="text-right whitespace-nowrap">
                          <div className="inline-flex gap-1.5">
                            <RowAction
                              label={disabled ? 'Enable' : 'Disable'}
                              tone={disabled ? 'ok' : 'danger'}
                              disabled={!disabled && isSelf}
                              title={!disabled && isSelf ? "You can't disable your own user" : undefined}
                              onClick={() =>
                                setPending({ kind: 'status', user: u, next: disabled ? 'active' : 'disabled' })
                              }
                            />
                            <RowAction
                              label={u.is_platform_admin ? 'Revoke admin' : 'Make admin'}
                              tone="neutral"
                              onClick={() => setPending({ kind: 'admin', user: u, grant: !u.is_platform_admin })}
                            />
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination total={data.total} limit={PAGE} offset={offset} onOffset={setOffset} busy={loading} />
          </>
        )}
      </Card>

      {pending && (
        <ConfirmModal
          title={confirmTitle(pending)}
          body={confirmBody(pending)}
          confirmLabel={confirmLabel(pending)}
          danger={pending.kind === 'status' ? pending.next === 'disabled' : !pending.grant}
          busy={busy}
          error={confirmError}
          onConfirm={runPending}
          onClose={() => {
            setPending(null);
            setConfirmError(null);
          }}
        />
      )}
    </div>
  );
}

function RowAction({
  label,
  tone,
  onClick,
  disabled,
  title,
}: {
  label: string;
  tone: 'ok' | 'danger' | 'neutral';
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const tones = {
    ok: 'border-moss/40 text-moss hover:bg-moss/10',
    danger: 'border-terracotta/40 text-terracotta-deep hover:bg-terracotta/10',
    neutral: 'border-ink/15 text-ink/65 hover:border-ink/40 hover:text-ink',
  } as const;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`h-7 px-2.5 rounded-full border text-[11px] transition-colors disabled:opacity-35 disabled:pointer-events-none ${tones[tone]}`}
    >
      {label}
    </button>
  );
}

function confirmTitle(p: PendingAction): string {
  if (p.kind === 'status') return p.next === 'disabled' ? `Disable ${p.user.email}?` : `Enable ${p.user.email}?`;
  return p.grant ? `Make ${p.user.email} a platform admin?` : `Revoke platform admin from ${p.user.email}?`;
}

function confirmLabel(p: PendingAction): string {
  if (p.kind === 'status') return p.next === 'disabled' ? 'Disable user' : 'Enable user';
  return p.grant ? 'Grant admin' : 'Revoke admin';
}

function confirmBody(p: PendingAction) {
  if (p.kind === 'status') {
    return p.next === 'disabled' ? (
      <p>
        They're signed out immediately (refresh tokens revoked) and can't sign back in until
        re-enabled. Their accounts, locations and history stay intact.
      </p>
    ) : (
      <p>They'll be able to sign in again right away. Nothing else changes.</p>
    );
  }
  return p.grant ? (
    <p>
      Platform admins see and moderate <em>everything</em> on this instance — every account, user,
      audit trail and rate limit. Grant it only to people who operate the deployment.
    </p>
  ) : (
    <p>
      They lose access to this console immediately. Their normal account membership is untouched.
    </p>
  );
}
