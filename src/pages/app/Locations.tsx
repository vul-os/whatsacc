import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { ApiError, api, type LocationRow } from '@/lib/api';

const KIND_DOTS: Record<LocationRow['type'], string> = {
  house: 'bg-gold',
  complex: 'bg-terracotta',
  building: 'bg-moss',
  other: 'bg-slate',
};

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))} h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function LocationsPage() {
  const { currentAccount, setCurrentAccount, refreshMe } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<LocationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Onboarding from /app sends users here with ?new=1 to auto-open the
  // create-location modal. Strip the param after we read it so a back-nav
  // doesn't re-pop the modal.
  const [creating, setCreating] = useState(searchParams.get('new') === '1');
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    if (!currentAccount) return;
    try {
      const r = await api.locationsList(currentAccount.id);
      setRows(r.locations);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load locations.');
    }
  }, [currentAccount]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!currentAccount) {
    return (
      <>
        <PageHeader kicker="Portfolio" title="Locations" />
        <Card>
          <p className="text-ink/65 text-sm">No account loaded.</p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        kicker="Portfolio"
        title="Locations"
        description="Every property under your account. A house belongs to a complex; a complex contains its access points."
        actions={
          <Button variant="ink" onClick={() => setCreating(true)}>
            New location
          </Button>
        }
      />

      {error && (
        <Card className="mb-6 border-terracotta/40">
          <p className="text-sm text-terracotta-deep">{error}</p>
        </Card>
      )}

      {rows === null ? (
        <Card>
          <p className="text-ink/55 text-sm">Loading…</p>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <p className="text-ink/65 text-sm">No locations yet. Create your first to begin.</p>
        </Card>
      ) : (
        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink/10">
                  {['Name', 'Kind', 'City', 'Members', 'Access points', 'Last opened', ''].map((c, i) => (
                    <th
                      key={c || i}
                      className="text-left px-6 py-4 text-[11px] uppercase tracking-[0.18em] text-ink/55 font-normal"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr
                    key={l.id}
                    className="border-b border-ink/8 last:border-0 hover:bg-paper-warm/40 transition-colors"
                  >
                    <td className="px-6 py-5">
                      <p className="font-display text-lg">{l.name}</p>
                      {l.slug && <p className="text-xs text-ink/45 mt-0.5">{l.slug}</p>}
                    </td>
                    <td className="px-6 py-5 capitalize">
                      <span className="inline-flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${KIND_DOTS[l.type]}`} />
                        {l.type}
                      </span>
                    </td>
                    <td className="px-6 py-5 text-ink/70">
                      {(l.address?.city as string | undefined) ?? '—'}
                    </td>
                    <td className="px-6 py-5">{l.member_count}</td>
                    <td className="px-6 py-5">{l.access_point_count}</td>
                    <td className="px-6 py-5 text-ink/70">{relativeTime(l.last_opened_at)}</td>
                    <td className="px-6 py-5 text-right">
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = window.confirm(
                            `Delete "${l.name}"? This removes its members, access points, devices, grants, and wallet. Cannot be undone.`,
                          );
                          if (!ok) return;
                          try {
                            await api.locationDelete(l.id);
                            await refreshMe();
                            await refresh();
                          } catch (err) {
                            setError(err instanceof Error ? err.message : 'Delete failed.');
                          }
                        }}
                        className="text-xs text-terracotta-deep hover:underline underline-offset-4"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {creating && (
        <CreateLocationModal
          onClose={() => setCreating(false)}
          onCreated={async (newAccountId) => {
            setCreating(false);
            // Fresh location lives in a new account — refresh /me so the
            // switcher picks it up, then jump active scope to it.
            await refreshMe();
            setCurrentAccount(newAccountId);
          }}
        />
      )}
    </>
  );
}

function CreateLocationModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (newAccountId: string) => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<LocationRow['type']>('house');
  const [city, setCity] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    if (!name.trim()) {
      setErrorMsg('Name is required.');
      return;
    }
    setSubmitting(true);
    try {
      // Each location is its own billing tenant — the top-level endpoint
      // creates a fresh account alongside the location.
      const r = await api.locationCreateNew({
        type,
        name: name.trim(),
        address: city.trim() ? { city: city.trim() } : undefined,
      });
      onCreated(r.account_id);
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? (err.detail ?? err.code) : err instanceof Error ? err.message : 'Failed.');
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose}>
      <h2 className="font-display text-2xl mb-1">New location</h2>
      <p className="text-sm text-ink/60 mb-5">A house, complex, building, or other site. Each location has its own members and billing.</p>
      <form onSubmit={onSubmit} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-ink/85">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Oakridge Estate"
            className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
          />
        </label>
        <fieldset>
          <legend className="text-sm font-medium text-ink/85 mb-2">Kind</legend>
          <div className="grid grid-cols-4 gap-2">
            {(['house', 'complex', 'building', 'other'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setType(k)}
                className={`h-10 rounded-xl border text-xs capitalize transition-colors ${
                  type === k ? 'bg-ink text-paper border-ink' : 'bg-paper-cool text-ink border-ink/15 hover:border-ink/35'
                }`}
              >
                {k}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="block">
          <span className="text-sm font-medium text-ink/85">City (optional)</span>
          <input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="Durban"
            className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
          />
        </label>
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
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
