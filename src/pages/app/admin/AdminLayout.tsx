// Instance-admin console shell: route guard + one-time claim flow + tab nav.
//
// Access rules (mirrors backend /admin):
//   - me.user.is_platform_admin  → full console (tabs + outlet).
//   - not admin, GET /admin/claim says claimable → one-time claim form
//     (token → POST /admin/claim → refresh /me → console).
//   - otherwise → clean 403 state. No global banners anywhere else.

import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { PageHeader } from '../AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { useAuth } from '@/lib/auth';
import { api, type AdminClaimState } from '@/lib/api';
import { cn } from '@/lib/cn';
import { AdminToastProvider, adminErrorMessage } from './shared';

const TABS = [
  { to: '/app/admin', label: 'Overview', end: true },
  { to: '/app/admin/accounts', label: 'Accounts' },
  { to: '/app/admin/users', label: 'Users' },
  { to: '/app/admin/limits', label: 'Limits' },
  { to: '/app/admin/audit', label: 'Audit' },
];

export default function AdminLayout() {
  const { user } = useAuth();

  if (!user?.is_platform_admin) return <AdminGate />;

  return (
    <AdminToastProvider>
      <PageHeader
        kicker="Operator"
        title="Instance admin"
        description="Observe and moderate this lintel deployment — every account, user, and gate movement on the instance."
      />
      <nav className="flex flex-wrap gap-1.5 mb-6 -mt-2" aria-label="Admin sections">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              cn(
                'h-9 px-4 inline-flex items-center rounded-full text-sm transition-colors',
                isActive
                  ? 'bg-ink text-paper'
                  : 'text-ink/65 border border-ink/15 hover:border-ink/40 hover:text-ink',
              )
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </AdminToastProvider>
  );
}

// ── Non-admin gate: claim-if-claimable, otherwise a clean 403 ───────────────

function AdminGate() {
  const [state, setState] = useState<AdminClaimState | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .adminClaimState()
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state && !failed) {
    return (
      <div className="min-h-[50vh] grid place-items-center text-ink/40 text-sm">Loading…</div>
    );
  }

  if (state?.claimable) return <ClaimScreen />;
  return <Forbidden />;
}

function Forbidden() {
  return (
    <div className="max-w-lg mx-auto mt-[12vh]">
      <Card className="p-8 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-ink/45 mb-3">
          403 · not_platform_admin
        </p>
        <h1 className="font-display text-3xl mb-3">Operators only</h1>
        <p className="text-sm text-ink/60 leading-relaxed">
          This console belongs to whoever runs this lintel instance. Your account doesn't have
          platform-admin access — if you think it should, ask the operator to grant it from their
          Users tab.
        </p>
      </Card>
    </div>
  );
}

// ── One-time claim ──────────────────────────────────────────────────────────

function ClaimScreen() {
  const { refreshMe } = useAuth();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.adminClaim(token.trim());
      // Success — /me now carries is_platform_admin, which re-renders the
      // console in place of this screen.
      await refreshMe();
    } catch (err) {
      setError(adminErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto mt-[10vh]">
      <Card className="p-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-ink/45 mb-3">
          First-run · one-time claim
        </p>
        <h1 className="font-display text-3xl mb-3">Claim this instance</h1>
        <p className="text-sm text-ink/60 leading-relaxed mb-6">
          Nobody operates this deployment yet. Paste the <span className="font-mono text-ink/80">ADMIN_CLAIM_TOKEN</span>{' '}
          from the server's environment to become its platform admin. This works exactly once —
          after that, the token is dead forever and admin access is granted from the console.
        </p>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Claim token"
            value={token}
            onChange={setToken}
            placeholder="paste ADMIN_CLAIM_TOKEN"
            autoComplete="off"
            spellCheck={false}
            required
            error={error}
            className="[&_input]:font-mono [&_input]:text-sm"
          />
          <div className="flex justify-end">
            <Button type="submit" variant="ink" disabled={busy || token.trim().length === 0}>
              {busy ? 'Claiming…' : 'Claim instance'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
