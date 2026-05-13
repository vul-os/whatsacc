import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ApiError, api, type LocationRow } from '@/lib/api';

export function CreateLocationModal({
  accountId,
  mode = 'new-account',
  onClose,
  onCreated,
}: {
  accountId?: string;
  mode?: 'new-account' | 'current-account';
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
      const trimmedName = name.trim();
      if (mode === 'current-account') {
        if (!accountId) throw new Error('Missing account.');
        await api.accountUpdate(accountId, { name: trimmedName });
        await api.locationCreate(accountId, {
          type,
          name: trimmedName,
          address: city.trim() ? { city: city.trim() } : undefined,
        });
        onCreated(accountId);
      } else {
        // Each manually-added location is its own billing tenant — the
        // top-level endpoint creates a fresh account alongside the location.
        const r = await api.locationCreateNew({
          type,
          name: trimmedName,
          address: city.trim() ? { city: city.trim() } : undefined,
        });
        onCreated(r.account_id);
      }
    } catch (err) {
      setErrorMsg(
        err instanceof ApiError
          ? (err.detail ?? err.code)
          : err instanceof Error
            ? err.message
            : 'Failed.',
      );
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} className="sm:max-w-xl">
      <h2 className="font-display text-2xl sm:text-3xl mb-1">
        {mode === 'current-account' ? 'Set up your location' : 'New location'}
      </h2>
      <p className="text-sm text-ink/60 mb-5 leading-relaxed">
        {mode === 'current-account'
          ? 'Name the place this account belongs to. This is the org/location name you will see in the dashboard.'
          : 'A house, complex, building, or other site. Each location has its own members and billing.'}
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-ink/85">Location / org name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Home, HQ, or Oakridge Estate"
            className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
          />
        </label>
        <fieldset>
          <legend className="text-sm font-medium text-ink/85 mb-2">Kind</legend>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(['house', 'complex', 'building', 'other'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setType(k)}
                className={`h-10 rounded-xl border text-xs capitalize transition-colors ${
                  type === k
                    ? 'bg-ink text-paper border-ink'
                    : 'bg-paper-cool text-ink border-ink/15 hover:border-ink/35'
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
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-11 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
          >
            Cancel
          </button>
          <Button type="submit" variant="ink" disabled={submitting}>
            {submitting ? 'Saving…' : mode === 'current-account' ? 'Save location' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
