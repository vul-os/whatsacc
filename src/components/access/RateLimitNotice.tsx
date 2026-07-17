// Friendly inline state for 429 denials on the tap-to-open flows.
//
// Two flavours, matching the backend's denial reasons:
//   rate_limited   → "Too many opens — try again in ~Xs" with a live countdown
//                    driven by retry_after_s; fires onExpire when it hits zero
//                    so callers can re-enable their button.
//   quota_exceeded → "Daily limit reached — contact your admin." (no countdown;
//                    the window is a whole day, ticking hours down is hostile.)

import { useEffect, useRef, useState } from 'react';
import type { RateLimitDenial } from '@/lib/api';

/**
 * Live seconds-remaining for a retry hint. Returns null when seconds is null.
 * Pass a `resetKey` that changes per denial so back-to-back denials with the
 * same retry_after_s still restart the countdown.
 */
export function useRetryCountdown(seconds: number | null, resetKey?: unknown): number | null {
  const [left, setLeft] = useState<number | null>(seconds);
  useEffect(() => {
    setLeft(seconds);
    if (seconds === null || seconds <= 0) return;
    const startedAt = Date.now();
    const t = window.setInterval(() => {
      const remain = seconds - Math.floor((Date.now() - startedAt) / 1000);
      setLeft(Math.max(0, remain));
      if (remain <= 0) window.clearInterval(t);
    }, 250);
    return () => window.clearInterval(t);
  }, [seconds, resetKey]);
  return left;
}

export function rateLimitCopy(denial: RateLimitDenial, secondsLeft: number | null): string {
  if (denial.reason === 'quota_exceeded') {
    return 'Daily limit reached — contact your admin.';
  }
  if (secondsLeft !== null && secondsLeft > 0) {
    return `Too many opens — try again in ~${secondsLeft}s`;
  }
  return 'You can try again now.';
}

export function RateLimitNotice({
  denial,
  onExpire,
  className,
}: {
  denial: RateLimitDenial;
  /** Called once, when a rate_limited countdown reaches zero. */
  onExpire?: () => void;
  className?: string;
}) {
  const secondsLeft = useRetryCountdown(
    denial.reason === 'rate_limited' ? denial.retryAfterS : null,
    denial,
  );
  const expired = useRef(false);
  useEffect(() => {
    // A fresh denial re-arms the expiry callback.
    expired.current = false;
  }, [denial]);
  useEffect(() => {
    if (secondsLeft === 0 && !expired.current) {
      expired.current = true;
      onExpire?.();
    }
  }, [secondsLeft, onExpire]);

  return (
    <p className={className} role="status" aria-live="polite">
      {rateLimitCopy(denial, secondsLeft)}
    </p>
  );
}
