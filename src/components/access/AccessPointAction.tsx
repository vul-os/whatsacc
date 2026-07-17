// Premium quick-action button for a single access point. Visually a tappable
// tile: brand-chrome border, soft shadow, lift on hover. State machine drives
// the label between Open / Close and animates the press + pending pulse.
//
// State model:
//   idle (closed)  → press → opening → done → assumes 'open'
//   open           → press → closing → done → assumes 'closed' (back to idle)
//   error          → press → resets to last known state
//
// We don't have a server-side "is_open" signal yet — the gate is a momentary
// relay. We track local state so the second tap closes immediately, and the
// label flips back to 'Open' after a short hold. The hold timeout matches the
// `gate_movement_m_per_op` × duration estimate where available.

import { motion } from 'framer-motion';
import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, type AccessPointDetail } from '@/lib/api';
import { cn } from '@/lib/cn';

type Stage = 'idle' | 'opening' | 'closing' | 'open' | 'done' | 'error';

const FLIP_BACK_MS = 25_000; // assume closed again after 25s if no other op

export function AccessPointAction({
  ap,
  onActivity,
}: {
  ap: AccessPointDetail;
  onActivity?: () => void;
}) {
  const [stage, setStage] = useState<Stage>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // After 'done' from an open, hold the 'open' state briefly so the button
  // shows 'Close'. Then auto-revert to 'idle' if user doesn't close manually.
  useEffect(() => {
    if (stage !== 'open') return;
    const t = window.setTimeout(() => setStage('idle'), FLIP_BACK_MS);
    return () => window.clearTimeout(t);
  }, [stage]);

  const send = useCallback(
    async (cmd: 'open' | 'close') => {
      setErrorMsg(null);
      setStage(cmd === 'open' ? 'opening' : 'closing');

      const submit = async (lat?: number, long?: number) => {
        try {
          if (cmd === 'open') {
            await api.accessOpen(ap.id, { source: 'web', lat, long });
            setStage('open');
          } else {
            await api.accessClose(ap.id, { source: 'web', lat, long });
            setStage('idle');
          }
          onActivity?.();
        } catch (err) {
          setStage('error');
          const msg =
            err instanceof ApiError
              ? err.detail ?? err.code
              : err instanceof Error
                ? err.message
                : 'Something went wrong.';
          setErrorMsg(msg);
          window.setTimeout(() => setStage('idle'), 2400);
        }
      };

      if (!('geolocation' in navigator)) {
        submit();
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => submit(pos.coords.latitude, pos.coords.longitude),
        () => submit(),
        { timeout: 4000 },
      );
    },
    [ap.id, onActivity],
  );

  const isOpen = stage === 'open';
  const isPending = stage === 'opening' || stage === 'closing';
  const isError = stage === 'error';

  const pillBg = isOpen
    ? 'bg-ink text-paper border-ink'
    : isError
      ? 'bg-terracotta/10 text-terracotta-deep border-terracotta/30'
      : 'bg-paper text-ink border-ink/12';

  // Status dot: terracotta for offline, moss for active/online.
  const statusOnline = ap.status === 'active' || ap.status === 'online';

  return (
    <motion.div
      whileHover={{ y: -2 }}
      transition={{ type: 'spring', stiffness: 380, damping: 28 }}
      className={cn(
        'group relative rounded-3xl border overflow-hidden transition-colors',
        'shadow-[0_1px_0_rgba(26,31,54,0.04),0_18px_40px_-22px_rgba(26,31,54,0.22)]',
        pillBg,
      )}
    >
      {/* Backdrop wash — premium feel without being noisy */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-0 pointer-events-none',
          isOpen
            ? 'bg-[radial-gradient(120%_80%_at_50%_0%,rgba(244,237,226,0.10),transparent_60%)]'
            : 'bg-[radial-gradient(120%_80%_at_0%_0%,rgba(214,98,77,0.05),transparent_55%)]',
        )}
      />

      <div className="relative p-5 sm:p-6 flex flex-col h-full min-h-[180px]">
        {/* Top row: kind chip + status dot + drill-in arrow */}
        <div className="flex items-center justify-between mb-3">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em]',
              isOpen ? 'text-paper/55' : 'text-ink/55',
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                statusOnline ? 'bg-moss' : 'bg-terracotta',
              )}
            />
            {ap.kind}
          </span>
          <Link
            to={`/app/access-points/${ap.id}`}
            aria-label={`Open details for ${ap.name}`}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'h-7 w-7 grid place-items-center rounded-full transition-colors',
              isOpen
                ? 'text-paper/65 hover:text-paper hover:bg-paper/10'
                : 'text-ink/45 hover:text-ink hover:bg-ink/5',
            )}
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
              <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </div>

        {/* Name + location-ish hint (kind already above; show device or 'unpaired') */}
        <div className="mb-5">
          <p className={cn('font-display text-xl sm:text-2xl leading-tight', isOpen ? 'text-paper' : 'text-ink')}>
            {ap.name}
          </p>
          <p
            className={cn(
              'text-[11px] sm:text-xs mt-1 truncate',
              isOpen ? 'text-paper/60' : 'text-ink/55',
            )}
          >
            {ap.device_id ? `device ${ap.device_id.slice(0, 8)}` : 'no device paired'}
          </p>
        </div>

        {/* Action button — fills the remaining space */}
        <div className="mt-auto">
          <button
            type="button"
            disabled={isPending}
            onClick={() => send(isOpen ? 'close' : 'open')}
            className={cn(
              'relative w-full h-12 sm:h-13 rounded-full font-medium text-sm tracking-tight',
              'transition-[background-color,color,transform,box-shadow] duration-200',
              'disabled:cursor-progress',
              isOpen
                ? 'bg-paper text-ink hover:bg-paper/90 active:scale-[0.98]'
                : 'bg-terracotta text-paper hover:bg-terracotta-deep active:scale-[0.98] shadow-[0_8px_22px_-12px_rgba(214,98,77,0.7)]',
              isError && 'bg-terracotta/15 text-terracotta-deep',
            )}
          >
            {isPending && (
              <span className="absolute inset-0 grid place-items-center">
                <span className="relative h-5 w-5">
                  <span className="absolute inset-0 rounded-full bg-current opacity-30 signal-wave" />
                  <span className="absolute inset-1.5 rounded-full bg-current" />
                </span>
              </span>
            )}
            <span className={cn('inline-flex items-center justify-center gap-2', isPending && 'opacity-0')}>
              {!isOpen ? (
                <ArchIcon className="h-4 w-4" />
              ) : (
                <CloseIcon className="h-4 w-4" />
              )}
              {stage === 'error'
                ? 'Try again'
                : isPending
                  ? '…'
                  : isOpen
                    ? 'Close'
                    : 'Open'}
            </span>
          </button>
          {errorMsg && (
            <p className="mt-2 text-[11px] text-terracotta-deep truncate" title={errorMsg}>
              {errorMsg}
            </p>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function ArchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M6 20V12a6 6 0 0 1 12 0v8" strokeLinejoin="round" />
      <circle cx="12" cy="16" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="M5 12h14" strokeLinecap="round" />
    </svg>
  );
}
