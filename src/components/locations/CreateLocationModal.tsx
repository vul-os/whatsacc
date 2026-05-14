import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ApiError, api, type LocationRow } from '@/lib/api';
import { MapboxAddressInput, type SelectedAddress } from './MapboxAddressInput';

export function CreateLocationModal({
  accountId,
  mode = 'new-account',
  onClose,
  onCreated,
  forced = false,
}: {
  accountId?: string;
  mode?: 'new-account' | 'current-account';
  onClose: () => void;
  onCreated: (newAccountId: string) => void;
  forced?: boolean;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<LocationRow['type']>('house');
  const [address, setAddress] = useState<SelectedAddress | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    if (!name.trim()) { setErrorMsg('Name is required.'); return; }
    if (!address) { setErrorMsg('Select an address — this is required for geofencing.'); return; }

    setSubmitting(true);
    try {
      const trimmedName = name.trim();
      const addressPayload = {
        full_address: address.full_address,
        city: address.city,
        country: address.country,
      };

      if (mode === 'current-account') {
        if (!accountId) throw new Error('Missing account.');
        await api.accountUpdate(accountId, { name: trimmedName });
        await api.locationCreate(accountId, {
          type,
          name: trimmedName,
          address: addressPayload,
          lat: address.lat,
          long: address.long,
        });
        onCreated(accountId);
      } else {
        const r = await api.locationCreateNew({
          type,
          name: trimmedName,
          address: addressPayload,
          lat: address.lat,
          long: address.long,
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

  const noop = () => {};

  return (
    <Modal open onClose={forced ? noop : onClose} className="sm:max-w-xl">
      <h2 className="font-display text-2xl sm:text-3xl mb-1">
        {forced
          ? 'Set up your first location'
          : mode === 'current-account'
            ? 'Set up your location'
            : 'New location'}
      </h2>
      <p className="text-sm text-ink/60 mb-5 leading-relaxed">
        {forced
          ? 'Give your place a name and confirm its address before you dive in.'
          : mode === 'current-account'
            ? 'Name and verify the address of this location.'
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

        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-sm font-medium text-ink/85">Address</span>
            <span className="text-[11px] text-ink/45 flex items-center gap-1">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
                <path d="M5 1a3 3 0 1 1 0 6A3 3 0 0 1 5 1zm0 7.5v.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              Used for geofencing security
            </span>
          </div>
          <MapboxAddressInput value={address} onChange={setAddress} required />
          <p className="mt-2 text-xs text-ink/45 leading-relaxed">
            Your address is used to verify you're physically at this property before granting
            access — we never share it.
          </p>
        </div>

        {errorMsg && <p className="text-sm text-terracotta-deep">{errorMsg}</p>}

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          {!forced && (
            <button
              type="button"
              onClick={onClose}
              className="h-11 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
            >
              Cancel
            </button>
          )}
          <Button type="submit" variant="ink" disabled={submitting}>
            {submitting
              ? 'Saving…'
              : forced || mode === 'current-account'
                ? 'Save location'
                : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
