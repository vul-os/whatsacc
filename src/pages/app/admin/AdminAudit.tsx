// Audit: two trails.
//   Access log — instance-wide opens/closes/denials with kind filter chips.
//   Admin actions — the operator trail (claims, suspensions, grants, denied
//   /admin probes).

import { useState } from 'react';
import { api, type AdminAuditKind } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { ResultDot } from './AdminAccounts';
import {
  ErrorNote,
  LoadingRow,
  Pagination,
  Td,
  Th,
  fmtDateTime,
  useAdminLoad,
} from './shared';

const PAGE = 50;

const KINDS: Array<{ kind: AdminAuditKind; label: string }> = [
  { kind: 'all', label: 'All' },
  { kind: 'success', label: 'Success' },
  { kind: 'denied', label: 'Denied' },
  { kind: 'open', label: 'Opens' },
  { kind: 'close', label: 'Closes' },
  { kind: 'rate_limited', label: 'Rate limited' },
  { kind: 'quota_exceeded', label: 'Quota' },
  { kind: 'account_suspended', label: 'Suspended' },
];

export default function AdminAudit() {
  const [tab, setTab] = useState<'access' | 'actions'>('access');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1.5">
        {(
          [
            { id: 'access', label: 'Access log' },
            { id: 'actions', label: 'Admin actions' },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'h-8 px-3.5 rounded-full text-xs transition-colors',
              tab === t.id
                ? 'bg-ink/90 text-paper'
                : 'text-ink/60 border border-ink/15 hover:border-ink/40 hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'access' ? <AccessLog /> : <ActionLog />}
    </div>
  );
}

// ── Access log ──────────────────────────────────────────────────────────────

function AccessLog() {
  const [kind, setKind] = useState<AdminAuditKind>('all');
  const [offset, setOffset] = useState(0);

  const { data, error, loading } = useAdminLoad(
    () => api.adminAudit({ kind, limit: PAGE, offset }),
    [kind, offset],
  );

  return (
    <>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by kind">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            onClick={() => {
              setKind(k.kind);
              setOffset(0);
            }}
            className={cn(
              'h-8 px-3 rounded-full text-xs transition-colors',
              kind === k.kind
                ? 'bg-ink text-paper'
                : 'text-ink/60 border border-ink/15 hover:border-ink/40 hover:text-ink',
            )}
          >
            {k.label}
          </button>
        ))}
      </div>

      <Card className="p-0 overflow-hidden">
        {error ? (
          <ErrorNote text={error} />
        ) : !data ? (
          <LoadingRow />
        ) : data.entries.length === 0 ? (
          <p className="px-5 py-8 text-sm text-ink/55">Nothing logged for this filter.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink/10">
                    <Th>Time</Th>
                    <Th>Result</Th>
                    <Th>Access point</Th>
                    <Th>Account</Th>
                    <Th>User</Th>
                    <Th>Source</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => (
                    <tr key={e.id} className="border-b border-ink/8 last:border-0 hover:bg-paper-warm/40 transition-colors">
                      <Td className="font-mono text-xs text-ink/55 whitespace-nowrap">
                        {fmtDateTime(e.ts)}
                      </Td>
                      <Td>
                        <ResultDot success={e.success} command={e.command} error={e.error} />
                      </Td>
                      <Td className="text-ink/80">
                        <span className="truncate block max-w-[220px]">
                          {e.access_point_name ?? '—'}
                          {e.location_name && (
                            <span className="text-ink/45 text-xs"> · {e.location_name}</span>
                          )}
                        </span>
                      </Td>
                      <Td className="text-ink/70 text-xs">{e.account_name ?? '—'}</Td>
                      <Td className="font-mono text-xs text-ink/60">
                        <span className="truncate block max-w-[200px]">{e.user_email ?? '—'}</span>
                      </Td>
                      <Td className="font-mono text-[10px] uppercase text-ink/45">{e.source ?? '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination total={data.total} limit={PAGE} offset={offset} onOffset={setOffset} busy={loading} />
          </>
        )}
      </Card>
    </>
  );
}

// ── Admin action log ────────────────────────────────────────────────────────

function ActionLog() {
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useAdminLoad(
    () => api.adminAuditActions({ limit: PAGE, offset }),
    [offset],
  );

  return (
    <Card className="p-0 overflow-hidden">
      {error ? (
        <ErrorNote text={error} />
      ) : !data ? (
        <LoadingRow />
      ) : data.actions.length === 0 ? (
        <p className="px-5 py-8 text-sm text-ink/55">No admin actions recorded yet.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink/10">
                  <Th>Time</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Target</Th>
                  <Th>Allowed</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {data.actions.map((a) => (
                  <tr key={a.id} className="border-b border-ink/8 last:border-0 hover:bg-paper-warm/40 transition-colors">
                    <Td className="font-mono text-xs text-ink/55 whitespace-nowrap">
                      {fmtDateTime(a.created_at)}
                    </Td>
                    <Td className="font-mono text-xs text-ink/70">
                      <span className="truncate block max-w-[200px]">{a.actor_email ?? '—'}</span>
                    </Td>
                    <Td>
                      <span className="font-mono text-xs text-ink/85">{a.action}</span>
                    </Td>
                    <Td className="text-xs text-ink/60">
                      {a.target_kind ? (
                        <span className="font-mono">
                          {a.target_kind}
                          <span className="text-ink/35">/</span>
                          <span className="text-ink/45">{shortId(a.target_id)}</span>
                        </span>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider',
                          a.allowed ? 'text-moss' : 'text-terracotta-deep',
                        )}
                      >
                        <span
                          className={cn('h-1.5 w-1.5 rounded-full', a.allowed ? 'bg-moss' : 'bg-terracotta')}
                          aria-hidden
                        />
                        {a.allowed ? 'yes' : 'denied'}
                      </span>
                    </Td>
                    <Td className="font-mono text-[11px] text-ink/50">
                      <span className="truncate block max-w-[260px]">{fmtDetail(a.detail)}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination total={data.total} limit={PAGE} offset={offset} onOffset={setOffset} busy={loading} />
        </>
      )}
    </Card>
  );
}

function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function fmtDetail(detail: unknown): string {
  if (detail === null || detail === undefined) return '—';
  try {
    const s = typeof detail === 'string' ? detail : JSON.stringify(detail);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch {
    return '—';
  }
}
