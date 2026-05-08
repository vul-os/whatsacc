// Cloudflare Workers entry point. The fetch handler routes through the
// existing Hono app (createApp); the scheduled handler runs monthly payouts.
//
// Both handlers must wire up the per-request env + DB connection string into
// the module-level slots that getEnv() / getSql() read from. Without this
// step every getEnv() call would throw.

import { createApp } from './app.ts';
import { setEnv } from './lib/env.ts';
import { setDbConnectionString } from './lib/db.ts';
import { runMonthlyPayouts } from './lib/payouts.ts';
import { runSubscriptionRenewals } from './lib/subscriptions.ts';

// Cloudflare Workers types these as bindings; we accept any string-keyed map.
type WorkerEnv = Record<string, string | undefined>;

const app = createApp();

function bindRequestEnv(env: WorkerEnv): void {
  setEnv(env);
  if (!env['DATABASE_URL']) throw new Error('DATABASE_URL not bound');
  setDbConnectionString(env['DATABASE_URL']);
}

// Cron schedules — must match wrangler.toml triggers.crons exactly.
const PAYOUTS_CRON = '0 0 1 * *';                  // 1st of month, 00:00 UTC
const SUBSCRIPTION_RENEWAL_CRON = '0 2,10,18 * * *'; // 02/10/18 UTC, 3× daily

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    bindRequestEnv(env);
    return await app.fetch(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    bindRequestEnv(env);
    // Route on the cron pattern that fired. Both jobs are idempotent per-row
    // (payouts: per (period_key, user); renewals: per (subscription, period_start)).
    if (event.cron === PAYOUTS_CRON) {
      ctx.waitUntil(runMonthlyPayouts().then(() => undefined));
    } else if (event.cron === SUBSCRIPTION_RENEWAL_CRON) {
      ctx.waitUntil(runSubscriptionRenewals().then(() => undefined));
    } else {
      // Unknown schedule — log and no-op rather than throw.
      console.warn(`scheduled event with unrecognised cron: ${event.cron}`);
    }
  },
};
