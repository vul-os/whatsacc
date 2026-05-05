// Period-key helpers for the monthly payout cron.
//
// Period format: 'YYYY-MM' (UTC). When the cron runs on the 1st of any
// month, it closes the prior calendar month — running on 2026-06-01 closes
// 2026-05.

export function previousPeriodKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const prev = new Date(Date.UTC(y, m - 1, 1));
  const yyyy = prev.getUTCFullYear();
  const mm = String(prev.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

export function nextPayoutDate(now: Date): Date {
  // First of the next month, 00:00 UTC.
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return new Date(Date.UTC(y, m + 1, 1));
}

export function isValidPeriodKey(s: string): boolean {
  return /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(s);
}
