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

// Cloudflare Workers types these as bindings; we accept any string-keyed map.
type WorkerEnv = Record<string, string | undefined>;

const app = createApp();

function bindRequestEnv(env: WorkerEnv): void {
  setEnv(env);
  if (!env['DATABASE_URL']) throw new Error('DATABASE_URL not bound');
  setDbConnectionString(env['DATABASE_URL']);
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    bindRequestEnv(env);
    return await app.fetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    bindRequestEnv(env);
    // runMonthlyPayouts is idempotent per (period_key, user) — safe to retry.
    ctx.waitUntil(runMonthlyPayouts());
  },
};
