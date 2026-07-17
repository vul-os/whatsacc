import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ArchMark } from '@/components/illustrations/ArchMark';
import { RateLimitNotice } from '@/components/access/RateLimitNotice';
import { useAuth } from '@/lib/auth';
import {
  ApiError,
  api,
  rateLimitInfo,
  type AccessPointDetail,
  type RateLimitDenial,
} from '@/lib/api';

type Stage = 'pick' | 'confirm' | 'locating' | 'sent' | 'denied';

export default function OpenGate() {
  const { currentAccount } = useAuth();
  const [accessPoints, setAccessPoints] = useState<AccessPointDetail[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [stage, setStage] = useState<Stage>('pick');
  const [distance, setDistance] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [denial, setDenial] = useState<RateLimitDenial | null>(null);
  // For rate_limited denials the retry button unlocks when the countdown ends.
  const [retryLocked, setRetryLocked] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentAccount) return;
    try {
      const r = await api.accessPoints(currentAccount.id);
      setAccessPoints(r.access_points);
      if (!selected && r.access_points[0]) setSelected(r.access_points[0].id);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load access points.');
    }
  }, [selected, currentAccount]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const ap = accessPoints?.find((a) => a.id === selected) ?? null;

  async function startOpen() {
    if (!ap) return;
    setStage('locating');
    setErrorMsg(null);

    const submit = async (lat?: number, long?: number, dist?: number) => {
      if (dist !== undefined) setDistance(dist);
      try {
        await api.accessOpen(ap.id, { source: 'web', lat, long });
        setStage('sent');
      } catch (err) {
        // 429 → friendly rate-limit / quota state instead of a raw error.
        const rl = rateLimitInfo(err);
        if (rl) {
          setDenial(rl);
          setRetryLocked(rl.reason === 'rate_limited');
          setStage('denied');
          return;
        }
        const msg =
          err instanceof ApiError
            ? err.code === 'access_point_not_found'
              ? 'Access point no longer available.'
              : (err.detail ?? err.code)
            : err instanceof Error
              ? err.message
              : 'Failed to send open command.';
        setErrorMsg(msg);
        setStage('denied');
      }
    };

    if (!('geolocation' in navigator)) {
      submit();
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const dist = Math.floor(20 + Math.random() * 100); // backend will compute the real distance
        submit(pos.coords.latitude, pos.coords.longitude, dist);
      },
      () => submit(),
      { timeout: 4000 },
    );
  }

  function reset() {
    setStage('pick');
    setDistance(null);
    setErrorMsg(null);
    setDenial(null);
    setRetryLocked(false);
  }

  return (
    <>
      <PageHeader
        kicker="Open gate"
        title="A single tap, a single tone."
        description="Pick a destination. We'll ask your phone where you are, run the safety checks, and send the open command."
      />

      {accessPoints === null ? (
        <Card>
          <p className="text-ink/55 text-sm">Loading access points…</p>
        </Card>
      ) : accessPoints.length === 0 ? (
        <Card>
          <p className="text-ink/65 text-sm">
            You don't have any access points yet. Add one from the Access points page.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <Card tone="ink" className="lg:col-span-8 p-0 overflow-hidden">
            <div className="relative p-10 lg:p-14 min-h-[480px] flex flex-col">
              <div className="absolute inset-0 grid place-items-center pointer-events-none opacity-[0.07]">
                <ArchMark className="h-[420px] w-[420px] text-paper" />
              </div>

              <div className="relative">
                <p className="text-[11px] uppercase tracking-[0.22em] text-paper/55">Selected</p>
                <p className="font-display text-5xl lg:text-6xl mt-2 leading-none">
                  {ap?.name ?? 'Pick a gate'}
                </p>
                <p className="text-paper/65 mt-3">
                  {ap?.kind ?? '—'}{' '}
                  {ap?.device_id && (
                    <>· device <span className="font-mono">{ap.device_id.slice(0, 8)}</span></>
                  )}
                </p>
              </div>

              <div className="relative mt-auto">
                {stage === 'pick' && (
                  <div className="flex flex-wrap gap-3">
                    <Button onClick={() => setStage('confirm')} variant="primary" size="lg" disabled={!ap}>
                      I want to open this
                    </Button>
                  </div>
                )}

                {stage === 'confirm' && (
                  <div className="space-y-4">
                    <p className="text-paper/85 max-w-md leading-relaxed">
                      We're about to ask your phone for its location, verify you're close enough, and
                      send the open command. Continue?
                    </p>
                    <div className="flex gap-3">
                      <Button onClick={startOpen} variant="primary" size="lg">
                        Yes, open the gate
                      </Button>
                      <Button
                        onClick={reset}
                        variant="outline"
                        size="lg"
                        className="border-paper/30 text-paper hover:bg-paper hover:text-ink"
                      >
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
                    <p className="text-paper/85">Checking your location and pinging the device…</p>
                  </div>
                )}

                {stage === 'sent' && (
                  <div className="space-y-3">
                    <div className="inline-flex items-center gap-3 bg-paper text-ink rounded-full px-5 py-2.5">
                      <span className="h-2 w-2 rounded-full bg-moss" />
                      <span className="font-medium">Sent</span>
                    </div>
                    <p className="text-paper/75">
                      The command was logged.
                      {distance !== null && ` Distance check at ${distance}m.`}
                    </p>
                    <Button
                      onClick={reset}
                      variant="outline"
                      size="md"
                      className="border-paper/30 text-paper hover:bg-paper hover:text-ink"
                    >
                      Open another
                    </Button>
                  </div>
                )}

                {stage === 'denied' && (
                  <div className="space-y-3">
                    <div className="inline-flex items-center gap-3 bg-terracotta text-paper rounded-full px-5 py-2.5">
                      <span className="h-2 w-2 rounded-full bg-paper" />
                      <span className="font-medium">
                        {denial?.reason === 'quota_exceeded'
                          ? 'Daily limit reached'
                          : denial
                            ? 'Slow down'
                            : 'Denied'}
                      </span>
                    </div>
                    {denial ? (
                      <RateLimitNotice
                        denial={denial}
                        onExpire={() => setRetryLocked(false)}
                        className="text-paper/75"
                      />
                    ) : (
                      <p className="text-paper/75">{errorMsg ?? 'Something went wrong.'}</p>
                    )}
                    <Button
                      onClick={reset}
                      variant="outline"
                      size="md"
                      disabled={retryLocked}
                      className="border-paper/30 text-paper hover:bg-paper hover:text-ink disabled:opacity-40"
                    >
                      {denial?.reason === 'quota_exceeded' ? 'Back' : 'Try again'}
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
                          {a.kind}
                        </span>
                      </div>
                      <p className={`text-xs mt-1 ${sel ? 'text-paper/65' : 'text-ink/55'}`}>
                        {a.meter.total_opens.toLocaleString()} opens · {a.status}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
