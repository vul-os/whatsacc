import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArchMark } from '@/components/illustrations/ArchMark';
import { ThemeToggle } from '@/components/nav/ThemeToggle';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import {
  applyGatewayUrl,
  envBaseUrl,
  FALLBACK_BASE_URL,
  getApiBaseUrl,
  getStoredGatewayUrl,
  isTauri,
  normalizeGatewayUrl,
  onOpenGatewayPicker,
  testGatewayUrl,
  type GatewayTestResult,
} from '@/lib/gateway';

// ── boot-time decision ──────────────────────────────────────────────────────
//
// The picker gates the whole app when there is no usable gateway yet:
//   - desktop (Tauri) with nothing stored           → first-run picker
//   - ?gateway=<url> deep link that differs from
//     the stored choice                             → picker, prefilled
//   - plain web build with no VITE_API_BASE_URL and
//     the localhost fallback not answering /health  → picker (probed async)
// A build configured with VITE_API_BASE_URL (deployed web, screenshotter)
// never sees the picker unless the user asks for it.

type Boot =
  | { mode: 'ready' }
  | { mode: 'probe' }
  | { mode: 'picker'; prefill: string; cancelable: boolean };

function decideBoot(): Boot {
  if (typeof window === 'undefined') return { mode: 'ready' };
  const stored = getStoredGatewayUrl();
  const param = new URLSearchParams(window.location.search).get('gateway');
  if (param) {
    const normalized = normalizeGatewayUrl(param);
    if (normalized && normalized !== stored) {
      return { mode: 'picker', prefill: normalized, cancelable: Boolean(stored || envBaseUrl()) };
    }
  }
  if (stored) return { mode: 'ready' };
  if (isTauri()) return { mode: 'picker', prefill: '', cancelable: false };
  if (envBaseUrl()) return { mode: 'ready' };
  return { mode: 'probe' };
}

export function GatewayGate({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<Boot>(decideBoot);

  // Bare web dev fallback: only show the picker if localhost:8787 is silent.
  useEffect(() => {
    if (boot.mode !== 'probe') return;
    let cancelled = false;
    void testGatewayUrl(FALLBACK_BASE_URL, 1500).then((r) => {
      if (cancelled) return;
      setBoot(r.ok ? { mode: 'ready' } : { mode: 'picker', prefill: '', cancelable: false });
    });
    return () => {
      cancelled = true;
    };
  }, [boot.mode]);

  // "Change gateway" links (Login, Settings) reopen the picker over the app.
  useEffect(
    () =>
      onOpenGatewayPicker(() =>
        setBoot({
          mode: 'picker',
          prefill: getStoredGatewayUrl() ?? getApiBaseUrl(),
          cancelable: true,
        }),
      ),
    [],
  );

  if (boot.mode === 'probe') {
    return (
      <div className="min-h-[100svh] bg-paper grid place-items-center">
        <span className="text-ink/40 text-sm uppercase tracking-[0.22em]">connecting</span>
      </div>
    );
  }
  if (boot.mode === 'picker') {
    return (
      <GatewayPicker
        prefill={boot.prefill}
        cancelable={boot.cancelable}
        onCancel={() => setBoot({ mode: 'ready' })}
      />
    );
  }
  return <>{children}</>;
}

// ── the picker screen ───────────────────────────────────────────────────────

type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'ok'; env?: string }
  | { phase: 'failed'; message: string };

function GatewayPicker({
  prefill,
  cancelable,
  onCancel,
}: {
  prefill: string;
  cancelable: boolean;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState(prefill);
  const [test, setTest] = useState<TestState>({ phase: 'idle' });
  const [inputError, setInputError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // After a failed connect the user may still proceed (gateway briefly down).
  const [offerAnyway, setOfferAnyway] = useState(false);

  const stored = getStoredGatewayUrl();
  const defaultUrl = envBaseUrl() ?? (isTauri() ? null : FALLBACK_BASE_URL);

  function normalizeOrFlag(): string | null {
    const n = normalizeGatewayUrl(url);
    if (!n) {
      setInputError('Enter a gateway address like https://gate.example.com');
      return null;
    }
    setInputError(null);
    if (n !== url) setUrl(n);
    return n;
  }

  async function runTest(): Promise<GatewayTestResult | null> {
    const n = normalizeOrFlag();
    if (!n) return null;
    setTest({ phase: 'testing' });
    const r = await testGatewayUrl(n);
    setTest(r.ok ? { phase: 'ok', env: r.env } : { phase: 'failed', message: r.message });
    return r;
  }

  async function onConnect(e: FormEvent) {
    e.preventDefault();
    const n = normalizeOrFlag();
    if (!n || connecting) return;
    setConnecting(true);
    setOfferAnyway(false);
    const r = await runTest();
    setConnecting(false);
    if (!r) return;
    if (r.ok) applyGatewayUrl(n);
    else setOfferAnyway(true);
  }

  function connectAnyway() {
    const n = normalizeOrFlag();
    if (n) applyGatewayUrl(n);
  }

  return (
    <div className="relative z-10 min-h-[100svh] bg-paper flex flex-col">
      <header className="flex items-center justify-between gap-3 px-5 pt-5 sm:px-8 sm:pt-6">
        <span className="inline-flex items-center gap-2.5 text-ink">
          <ArchMark className="h-7 w-7" />
          <span className="font-display italic text-lg">whatsacc</span>
        </span>
        <ThemeToggle variant="auth" />
      </header>

      <div className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-[420px] mx-auto px-5 sm:px-8 py-8">
          <span className="inline-flex items-center gap-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-ink/55 mb-4">
            <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
            {isTauri() ? 'Desktop' : 'Setup'}
          </span>
          <h1 className="font-display-tight text-[34px] sm:text-[40px] leading-[1.02] tracking-[-0.02em] text-ink">
            Connect to your gateway
          </h1>
          <p className="mt-2 sm:mt-3 text-[15px] text-ink/65 leading-relaxed">
            Your account and gates live on a whatsacc gateway. Enter its address — ask your
            gateway operator if you&rsquo;re not sure.
          </p>

          <form onSubmit={onConnect} className="mt-6 space-y-4" noValidate>
            <Field
              label="Gateway URL"
              value={url}
              onChange={(v) => {
                setUrl(v);
                setInputError(null);
                setTest({ phase: 'idle' });
                setOfferAnyway(false);
              }}
              placeholder="https://gate.example.com"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              error={inputError}
              autoFocus
              required
            />

            {test.phase === 'ok' && (
              <p className="text-sm text-ink/80" role="status">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-moss mr-2 align-middle" aria-hidden />
                Gateway is reachable{test.env ? ` · ${test.env}` : ''}.
              </p>
            )}
            {test.phase === 'failed' && (
              <p className="text-sm text-terracotta-deep" role="alert">
                {test.message}
                {offerAnyway && (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={connectAnyway}
                      className="underline underline-offset-4 decoration-terracotta text-ink/85 hover:text-ink"
                    >
                      Connect anyway
                    </button>
                  </>
                )}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button type="submit" variant="ink" size="lg" className="flex-1" disabled={connecting}>
                {connecting || test.phase === 'testing' ? 'Checking…' : 'Connect'}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={connecting || test.phase === 'testing'}
                onClick={() => void runTest()}
              >
                Test connection
              </Button>
            </div>
          </form>

          <div className="mt-5 sm:mt-6 space-y-1.5 text-sm text-ink/60">
            {stored && defaultUrl && stored !== defaultUrl && (
              <p>
                <button
                  type="button"
                  onClick={() => applyGatewayUrl(null)}
                  className="underline underline-offset-4 decoration-terracotta text-ink/85 hover:text-ink"
                >
                  Use the default gateway
                </button>{' '}
                <span className="text-ink/45">({defaultUrl})</span>
              </p>
            )}
            {cancelable && (
              <p>
                <button
                  type="button"
                  onClick={onCancel}
                  className="underline underline-offset-4 decoration-terracotta text-ink/85 hover:text-ink"
                >
                  Cancel
                </button>{' '}
                <span className="text-ink/45">— keep using {getApiBaseUrl()}</span>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
