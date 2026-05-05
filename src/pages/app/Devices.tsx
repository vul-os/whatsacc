import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { devices } from '@/mocks/devices';
import { DevicePairing } from '@/components/illustrations/DevicePairing';

export default function DevicesPage() {
  return (
    <>
      <PageHeader
        kicker="Hardware"
        title="Devices"
        description="The physical controllers paired to your access points. Each one carries its own signing key."
        actions={<Button variant="ink">Pair new device</Button>}
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-6">
        <Card className="lg:col-span-8 p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-paper-warm/50">
              <tr>
                {['Name', 'Serial', 'Firmware', 'Status', 'Signal', 'Paired'].map((c) => (
                  <th key={c} className="text-left px-6 py-4 text-[11px] uppercase tracking-[0.18em] text-ink/55 font-normal">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id} className="border-t border-ink/8 hover:bg-paper-warm/30 transition-colors">
                  <td className="px-6 py-4 font-mono">{d.name}</td>
                  <td className="px-6 py-4 font-mono text-ink/70 text-xs">{d.serial}</td>
                  <td className="px-6 py-4 text-ink/70">{d.firmware}</td>
                  <td className="px-6 py-4">
                    <Status status={d.status} />
                  </td>
                  <td className="px-6 py-4">
                    <Signal value={d.signal} />
                  </td>
                  <td className="px-6 py-4 text-ink/70">{d.pairedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card tone="cream" className="lg:col-span-4">
          <p className="text-[11px] uppercase tracking-[0.22em] text-ink/55">Pair a new one</p>
          <h3 className="font-display text-2xl mt-2">It takes 60 seconds</h3>
          <p className="text-ink/65 text-sm mt-3 leading-relaxed">
            Power the controller, scan the QR on its back, pick the access point, hit pair.
            That&rsquo;s the entire ceremony.
          </p>
          <DevicePairing className="w-full mt-4" />
        </Card>
      </div>
    </>
  );
}

function Status({ status }: { status: string }) {
  const map: Record<string, { dot: string; label: string }> = {
    online: { dot: 'bg-moss', label: 'online' },
    offline: { dot: 'bg-terracotta', label: 'offline' },
    'paired-pending': { dot: 'bg-gold', label: 'pending' },
  };
  const m = map[status] ?? { dot: 'bg-slate', label: status };
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

function Signal({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="block h-1.5 w-20 rounded-full bg-ink/10 overflow-hidden">
        <span
          className="block h-full bg-ink"
          style={{ width: `${value}%`, opacity: value === 0 ? 0.2 : 0.8 }}
        />
      </span>
      <span className="text-xs text-ink/60 tabular-nums w-8">{value}%</span>
    </span>
  );
}
