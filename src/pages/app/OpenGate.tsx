import { useState } from 'react';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { accessPoints } from '@/mocks/accessPoints';
import { ArchMark } from '@/components/illustrations/ArchMark';

type Stage = 'pick' | 'confirm' | 'locating' | 'sent' | 'denied';

export default function OpenGate() {
  const [selected, setSelected] = useState(accessPoints[0]?.id ?? '');
  const [stage, setStage] = useState<Stage>('pick');
  const [distance, setDistance] = useState<number | null>(null);

  const ap = accessPoints.find((a) => a.id === selected);

  function startOpen() {
    setStage('locating');
    if (!('geolocation' in navigator)) {
      const fakeDist = 42;
      setDistance(fakeDist);
      setTimeout(() => setStage('sent'), 1100);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      () => {
        const fakeDist = Math.floor(20 + Math.random() * 100);
        setDistance(fakeDist);
        setTimeout(() => setStage(fakeDist < 200 ? 'sent' : 'denied'), 900);
      },
      () => {
        const fakeDist = 42;
        setDistance(fakeDist);
        setTimeout(() => setStage('sent'), 900);
      },
      { timeout: 4000 },
    );
  }

  function reset() {
    setStage('pick');
    setDistance(null);
  }

  return (
    <>
      <PageHeader
        kicker="Open gate"
        title="A single tap, a single tone."
        description="Pick a destination. We'll ask your phone where you are, run the safety checks, and send the open command."
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <Card tone="ink" className="lg:col-span-8 p-0 overflow-hidden">
          <div className="relative p-10 lg:p-14 min-h-[480px] flex flex-col">
            {/* atmospheric arch */}
            <div className="absolute inset-0 grid place-items-center pointer-events-none opacity-[0.07]">
              <ArchMark className="h-[420px] w-[420px] text-paper" />
            </div>

            <div className="relative">
              <p className="text-[11px] uppercase tracking-[0.22em] text-paper/55">
                Selected
              </p>
              <p className="font-display text-5xl lg:text-6xl mt-2 leading-none">
                {ap?.name ?? 'Pick a gate'}
              </p>
              <p className="text-paper/65 mt-3">
                {ap?.location} · device {ap?.device}
              </p>
            </div>

            <div className="relative mt-auto">
              {stage === 'pick' && (
                <div className="flex flex-wrap gap-3">
                  <Button onClick={() => setStage('confirm')} variant="primary" size="lg">
                    I want to open this
                  </Button>
                  <Button variant="outline" size="lg" className="border-paper/30 text-paper hover:bg-paper hover:text-ink">
                    Cancel
                  </Button>
                </div>
              )}

              {stage === 'confirm' && (
                <div className="space-y-4">
                  <p className="text-paper/85 max-w-md leading-relaxed">
                    We&rsquo;re about to ask your phone for its location, verify you&rsquo;re close
                    enough, and send the open command. Continue?
                  </p>
                  <div className="flex gap-3">
                    <Button onClick={startOpen} variant="primary" size="lg">
                      Yes, open the gate
                    </Button>
                    <Button onClick={reset} variant="outline" size="lg" className="border-paper/30 text-paper hover:bg-paper hover:text-ink">
                      Wait
                    </Button>
                  </div>
                </div>
              )}

              {stage === 'locating' && (
                <div className="flex items-center gap-4">
                  <span className="relative grid place-items-center h-10 w-10">
                    <span className="absolute inset-0 rounded-full bg-terracotta/40 signal-wave" />
                    <span className="absolute inset-2 rounded-full bg-terracotta" />
                  </span>
                  <p className="text-paper/85">
                    Checking your location and pinging the device&hellip;
                  </p>
                </div>
              )}

              {stage === 'sent' && (
                <div className="space-y-3">
                  <div className="inline-flex items-center gap-3 bg-paper text-ink rounded-full px-5 py-2.5">
                    <span className="h-2 w-2 rounded-full bg-moss" />
                    <span className="font-medium">Unlocked · 7s</span>
                  </div>
                  <p className="text-paper/75">
                    Distance check passed at {distance ?? 42}m. The gate has been opened.
                  </p>
                  <Button onClick={reset} variant="outline" size="md" className="border-paper/30 text-paper hover:bg-paper hover:text-ink">
                    Open another
                  </Button>
                </div>
              )}

              {stage === 'denied' && (
                <div className="space-y-3">
                  <div className="inline-flex items-center gap-3 bg-terracotta text-paper rounded-full px-5 py-2.5">
                    <span className="h-2 w-2 rounded-full bg-paper" />
                    <span className="font-medium">Denied · outside geofence</span>
                  </div>
                  <p className="text-paper/75">
                    You&rsquo;re {distance}m from the gate — the safety radius is 200m. Move closer
                    and try again.
                  </p>
                  <Button onClick={reset} variant="outline" size="md" className="border-paper/30 text-paper hover:bg-paper hover:text-ink">
                    Try again
                  </Button>
                </div>
              )}
            </div>
          </div>
        </Card>

        <Card className="lg:col-span-4">
          <h3 className="font-display text-xl mb-4">Pick a gate</h3>
          <ul className="space-y-2">
            {accessPoints.map((a) => {
              const sel = a.id === selected;
              return (
                <li key={a.id}>
                  <button
                    onClick={() => {
                      setSelected(a.id);
                      reset();
                    }}
                    className={`w-full text-left rounded-xl px-3.5 py-3 border transition-colors ${
                      sel
                        ? 'bg-ink text-paper border-ink'
                        : 'bg-paper-cool border-ink/10 hover:border-ink/30'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{a.name}</span>
                      <span
                        className={`text-[10px] uppercase tracking-wider ${
                          sel ? 'text-paper/55' : 'text-ink/50'
                        }`}
                      >
                        {a.type}
                      </span>
                    </div>
                    <p className={`text-xs mt-1 ${sel ? 'text-paper/65' : 'text-ink/55'}`}>
                      {a.location}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}
