// Monthly referral payout job — CLI wrapper.
//
// Wire this to your scheduler to fire at 00:05 UTC on the 1st of each month.
// The actual logic lives in src/lib/payouts.ts so it stays unit-testable.
//
// Usage:
//   deno run -A --env-file=../.env cmd/cron/run-monthly-payouts.ts
//   deno run -A --env-file=../.env cmd/cron/run-monthly-payouts.ts --period 2026-05
//   deno run -A --env-file=../.env cmd/cron/run-monthly-payouts.ts --dry-run

import { parseArgs } from 'jsr:@std/cli@^1.0.0/parse-args';
import { getSql } from '../../src/lib/db.ts';
import { getEnv } from '../../src/lib/env.ts';
import { runMonthlyPayouts } from '../../src/lib/payouts.ts';
import { isValidPeriodKey, previousPeriodKey } from '../../src/lib/payout-period.ts';

const flags = parseArgs(Deno.args, {
  string: ['period'],
  boolean: ['dry-run', 'verbose'],
  default: { 'dry-run': false, verbose: false },
});

const period = flags.period ? String(flags.period) : previousPeriodKey(new Date());
if (!isValidPeriodKey(period)) {
  console.error(`error: invalid --period "${period}" (expected YYYY-MM)`);
  Deno.exit(1);
}

const env = getEnv();
if (!flags['dry-run'] && !env.PAYSTACK_SECRET_KEY) {
  console.error('error: PAYSTACK_SECRET_KEY required (or pass --dry-run)');
  Deno.exit(1);
}

console.log(`── monthly referral payout (period ${period}) ─────────────────────────`);

try {
  const r = await runMonthlyPayouts({
    period,
    dryRun: flags['dry-run'],
    log: flags.verbose ? (line: string) => console.log(`  ${line}`) : undefined,
  });
  console.log('\n── summary ──────────────────────────────────────────────────────────');
  console.log(`  processed         ${r.processed}`);
  console.log(`  dispatched        ${r.dispatched}`);
  console.log(`  skipped (kyc)     ${r.skippedKyc}`);
  console.log(`  skipped (dup)     ${r.skippedAlreadyPaid}`);
  console.log(`  failed            ${r.failed}`);
  if (r.failures.length > 0) {
    console.log('\n  failure detail:');
    for (const f of r.failures) console.log(`    - ${f.email}: ${f.error}`);
  }
} finally {
  await getSql().end({ timeout: 5 });
}
