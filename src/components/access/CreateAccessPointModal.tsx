import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { ApiError, api, type DeviceRow, type LocationRow } from '@/lib/api';

export function CreateAccessPointModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { currentAccount } = useAuth();
  const [locations, setLocations] = useState<LocationRow[] | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [locationId, setLocationId] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'gate' | 'door' | 'barrier' | 'other'>('gate');
  const [deviceId, setDeviceId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!currentAccount) return;
    let cancelled = false;
    api
      .locationsList(currentAccount.id)
      .then((r) => {
        if (cancelled) return;
        setLocations(r.locations);
        if (r.locations.length > 0 && !locationId) setLocationId(r.locations[0].id);
      })
      .catch((err) => {
        if (!cancelled) setErrorMsg(err instanceof Error ? err.message : 'Failed to load locations.');
      });
    return () => { cancelled = true; };
  }, [currentAccount, locationId]);

  useEffect(() => {
    if (!locationId) { setDevices([]); return; }
    let cancelled = false;
    api
      .devicesList({ location_id: locationId })
      .then((r) => { if (!cancelled) setDevices(r.devices); })
      .catch(() => { if (!cancelled) setDevices([]); });
    return () => { cancelled = true; };
  }, [locationId]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!locationId || !name.trim()) {
      setErrorMsg('Pick a location and enter a name.');
      return;
    }
    setErrorMsg(null);
    setSubmitting(true);
    try {
      await api.accessPointCreate({
        location_id: locationId,
        name: name.trim(),
        kind,
        device_id: deviceId || null,
      });
      onCreated();
    } catch (err) {
      setErrorMsg(
        err instanceof ApiError
          ? err.code === 'not_account_admin'
            ? 'Only account admins can add access points.'
            : err.code === 'device_not_at_location'
              ? 'That device belongs to a different location.'
              : (err.detail ?? err.code)
          : err instanceof Error
            ? err.message
            : 'Failed to create access point.',
      );
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} className="sm:max-w-lg">
      <h2 className="font-display text-2xl mb-1">Add access point</h2>
      <p className="text-sm text-ink/60 mb-6">
        One physical opening — gate, door, or barrier. Optionally bind it to a paired device.
      </p>

      <form onSubmit={onSubmit} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-ink/85">Location</span>
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-3 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
            disabled={locations === null}
          >
            {locations === null && <option>Loading…</option>}
            {locations !== null && locations.length === 0 && (
              <option value="">No locations yet — create one first</option>
            )}
            {locations?.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-ink/85">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Front Gate"
            className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
          />
        </label>

        <fieldset>
          <legend className="text-sm font-medium text-ink/85 mb-2">Kind</legend>
          <div className="grid grid-cols-4 gap-2">
            {(['gate', 'door', 'barrier', 'other'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`h-10 rounded-xl border text-xs capitalize transition-colors ${
                  kind === k
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
          <span className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-ink/85">Device (optional)</span>
            <span className="text-xs text-ink/50">
              {devices.length === 0 ? 'no devices at this location' : `${devices.length} available`}
            </span>
          </span>
          <select
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-3 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
          >
            <option value="">— None (unpaired) —</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label ?? d.id.slice(0, 8)} · {d.status}
              </option>
            ))}
          </select>
        </label>

        {errorMsg && <p className="text-sm text-terracotta-deep">{errorMsg}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
          >
            Cancel
          </button>
          <Button type="submit" variant="ink" disabled={submitting || !locationId || !name.trim()}>
            {submitting ? 'Adding…' : 'Add access point'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
