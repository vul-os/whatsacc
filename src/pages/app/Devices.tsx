import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { DevicePairing } from '@/components/illustrations/DevicePairing';
import { useAuth } from '@/lib/auth';
import {
  ApiError,
  api,
  type DeviceCreateResponse,
  type DeviceRow,
  type LocationRow,
} from '@/lib/api';
import { fromUnix } from '@/lib/time';

const STATUS_DOT: Record<string, string> = {
  unpaired: 'bg-gold',
  active: 'bg-moss',
  online: 'bg-moss',
  offline: 'bg-terracotta',
};

const STATUS_LABEL: Record<string, string> = {
  unpaired: 'awaiting pair',
  active: 'online',
  online: 'online',
  offline: 'offline',
};

function relativeTime(sec: number | null): string {
  const d = fromUnix(sec);
  if (!d) return '—';
  const ms = Date.now() - d.getTime();
  if (ms < 0) {
    const s = Math.abs(ms) / 1000;
    if (s < 60) return `in ${Math.round(s)}s`;
    if (s < 3600) return `in ${Math.round(s / 60)} min`;
    return `in ${Math.round(s / 3600)} h`;
  }
  if (ms < 60_000) return 'just now';
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))} h ago`;
  return d.toLocaleDateString();
}

export default function DevicesPage() {
  const { currentAccount } = useAuth();
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showClaim, setShowClaim] = useState<DeviceCreateResponse | null>(null);

  const refresh = useCallback(async () => {
    if (!currentAccount) return;
    try {
      const [d, l] = await Promise.all([
        api.devicesList({ account_id: currentAccount.id }),
        api.locationsList(currentAccount.id),
      ]);
      setDevices(d.devices);
      setLocations(l.locations);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load devices.');
    }
  }, [currentAccount]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const locationName = (id: string) => locations.find((l) => l.id === id)?.name ?? id.slice(0, 8);

  return (
    <>
      <PageHeader
        kicker="Hardware"
        title="Devices"
        description="The physical controllers paired to your access points. Each one carries its own signing key."
        actions={
          <Button
            variant="ink"
            disabled={locations.length === 0}
            onClick={() => setCreating(true)}
          >
            Pair new device
          </Button>
        }
      />

      {error && (
        <Card className="mb-6 border-terracotta/40">
          <p className="text-sm text-terracotta-deep">{error}</p>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-6">
        <Card className="lg:col-span-8 p-0 overflow-hidden">
          {devices === null ? (
            <div className="px-6 py-8 text-ink/55 text-sm">Loading…</div>
          ) : devices.length === 0 ? (
            <div className="px-6 py-8 text-ink/65 text-sm">
              {locations.length === 0
                ? 'Create a location first, then you can pair a device to it.'
                : 'No devices yet. Hit Pair new device to get a claim token.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-paper-warm/50">
                  <tr>
                    {['Label', 'Location', 'Status', 'Last seen', 'Paired'].map((c) => (
                      <th
                        key={c}
                        className="text-left px-6 py-4 text-[11px] uppercase tracking-[0.18em] text-ink/55 font-normal"
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {devices.map((d) => (
                    <tr
                      key={d.id}
                      className="border-t border-ink/8 hover:bg-paper-warm/30 transition-colors"
                    >
                      <td className="px-6 py-4 font-mono">
                        {d.label ?? <span className="text-ink/45">unlabelled</span>}
                        <p className="text-[10px] text-ink/40 mt-0.5">{d.id.slice(0, 8)}</p>
                      </td>
                      <td className="px-6 py-4 text-ink/70">{locationName(d.location_id)}</td>
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center gap-2 text-xs">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[d.status] ?? 'bg-slate'}`}
                          />
                          {STATUS_LABEL[d.status] ?? d.status}
                        </span>
                        {d.status === 'unpaired' && d.claim_expires_at && (
                          <p className="text-[10px] text-ink/45 mt-1">
                            claim expires {relativeTime(d.claim_expires_at)}
                          </p>
                        )}
                      </td>
                      <td className="px-6 py-4 text-ink/70">{relativeTime(d.last_seen_at)}</td>
                      <td className="px-6 py-4 text-ink/70">{relativeTime(d.paired_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card tone="cream" className="lg:col-span-4">
          <p className="text-[11px] uppercase tracking-[0.22em] text-ink/55">Pair a new one</p>
          <h3 className="font-display text-2xl mt-2">It takes 60 seconds</h3>
          <p className="text-ink/65 text-sm mt-3 leading-relaxed">
            Create the device here, copy the claim token, then enter it on the controller within
            an hour to complete pairing.
          </p>
          <DevicePairing className="w-full mt-4" />
        </Card>
      </div>

      {creating && (
        <CreateDeviceModal
          locations={locations}
          onClose={() => setCreating(false)}
          onCreated={(res) => {
            setCreating(false);
            setShowClaim(res);
            refresh();
          }}
        />
      )}

      {showClaim && <ClaimTokenModal info={showClaim} onClose={() => setShowClaim(null)} />}
    </>
  );
}

function CreateDeviceModal({
  locations,
  onClose,
  onCreated,
}: {
  locations: LocationRow[];
  onClose: () => void;
  onCreated: (res: DeviceCreateResponse) => void;
}) {
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    if (!locationId) {
      setErrorMsg('Pick a location.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.deviceCreate({
        location_id: locationId,
        label: label.trim() || undefined,
      });
      onCreated(res);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'not_account_admin'
            ? 'Only account admins can pair devices.'
            : (err.detail ?? err.code)
          : err instanceof Error
            ? err.message
            : 'Could not create device.';
      setErrorMsg(msg);
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose}>
      <h2 className="font-display text-2xl mb-1">Pair a new device</h2>
      <p className="text-sm text-ink/60 mb-5">
        Pick the location it lives at and give it a label so it's easier to recognise.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-ink/85">Location</span>
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-3 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink/85">Label (optional)</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Main gate controller"
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
            {submitting ? 'Creating…' : 'Create + get claim token'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ClaimTokenModal({ info, onClose }: { info: DeviceCreateResponse; onClose: () => void }) {
  return (
    <Modal open onClose={onClose}>
      <h2 className="font-display text-2xl mb-1">Claim token</h2>
      <p className="text-sm text-ink/60 mb-4">
        Enter this on the controller within the next hour to complete pairing.{' '}
        <span className="text-ink/85 font-medium">It won't be shown again.</span>
      </p>
      <div className="rounded-xl bg-ink text-paper p-4 font-mono text-sm break-all">
        {info.claim_token}
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-ink/55">
        <span>Expires {fromUnix(info.claim_expires_at)?.toLocaleString() ?? '—'}</span>
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(info.claim_token)}
          className="px-3 py-1.5 rounded-full border border-ink/15 hover:border-ink"
        >
          Copy
        </button>
      </div>
      <div className="flex justify-end gap-2 mt-6">
        <Button variant="ink" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
