// Subscription renewal job. Designed for the Cloudflare Workers cron trigger
// that fires 3× per day. Idempotent per (subscription_id, period_start) via
// the subscription_renewals unique constraint, so safely re-runnable.
//
// Wallet is usage-only (WhatsApp/Slack credits) — subscriptions are always
// charged to the saved card via Paystack charge_authorization.
//
// Flow per due subscription:
//   1. Insert a 'pending' renewal row for the next period (idempotent).
//   2. If account has a stored Paystack authorization_code, charge the card.
//      On success: extend period + mark `charged`. On failure: leave
//      renewal `failed`, schedule retry, flip subscription to `past_due` /
//      `expired` past grace.
//   3. Else: mark `failed` reason='no_payment_method', flip to past_due.

import { withRLS } from './db.ts';
import { chargeAuthorization, newReference } from './paystack.ts';
import { regionForCountry, REGIONS } from './billing/tiers.ts';
import { createInvoice } from './invoice.ts';

export const RENEWAL_BATCH_SIZE = 100;
export const GRACE_DAYS = 7;
export const RETRY_BACKOFF_HOURS = [4, 12, 24]; // attempts 1..3

const adminCtx = { user_id: '', account_id: null, is_platform_admin: true } as const;

export type RunRenewalsOpts = {
  now?: Date;
  dryRun?: boolean;
  limit?: number;
  log?: (line: string) => void;
};

export type RunRenewalsResult = {
  scanned: number;
  charged: number;
  failed: number;
  skipped: number;
  failures: Array<{ subscription_id: string; reason: string }>;
};

type DueSubscription = {
  subscription_id: string;
  account_id: string;
  plan_id: string;
  plan_code: string;
  plan_currency: string;
  plan_price_cents: number;
  current_period_end: Date;
  paystack_authorization_code: string | null;
  paystack_customer_email: string | null;
  account_country: string;
};

export async function runSubscriptionRenewals(
  opts: RunRenewalsOpts = {},
): Promise<RunRenewalsResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const limit = opts.limit ?? RENEWAL_BATCH_SIZE;

  log(`subscription renewals starting at ${now.toISOString()}${opts.dryRun ? ' (dry-run)' : ''}`);

  const due = await loadDueSubscriptions(now, limit);
  log(`due subscriptions: ${due.length}`);

  const result: RunRenewalsResult = {
    scanned: due.length,
    charged: 0,
    failed: 0,
    skipped: 0,
    failures: [],
  };

  for (const sub of due) {
    try {
      const outcome = await processSubscription(sub, now, opts.dryRun ?? false);
      switch (outcome.kind) {
        case 'charged': result.charged++; break;
        case 'skipped': result.skipped++; break;
        case 'failed':
          result.failed++;
          result.failures.push({ subscription_id: sub.subscription_id, reason: outcome.reason });
          break;
      }
    } catch (err) {
      result.failed++;
      const reason = (err as Error).message;
      result.failures.push({ subscription_id: sub.subscription_id, reason });
      log(`! renewal error for sub ${sub.subscription_id}: ${reason}`);
    }
  }

  log(`done — charged=${result.charged} failed=${result.failed}`);
  return result;
}

async function loadDueSubscriptions(now: Date, limit: number): Promise<DueSubscription[]> {
  return await withRLS(adminCtx, async (tx) => {
    return await tx<DueSubscription[]>`
      select
        s.id as subscription_id,
        s.account_id,
        s.plan_id,
        p.code as plan_code,
        p.currency as plan_currency,
        p.price_cents as plan_price_cents,
        s.current_period_end,
        a.paystack_authorization_code,
        a.paystack_customer_code as paystack_customer_email,
        a.country_code as account_country
      from account_subscriptions s
      join plans p on p.id = s.plan_id
      join accounts a on a.id = s.account_id
      where s.status in ('active','past_due','trialing')
        and (s.current_period_end is null or s.current_period_end <= ${now.toISOString()})
        and a.status = 'active'
        and p.price_cents > 0
      order by s.current_period_end asc nulls first
      limit ${limit}
    `;
  });
}

type Outcome =
  | { kind: 'charged' }
  | { kind: 'skipped' }
  | { kind: 'failed'; reason: string };

async function processSubscription(
  sub: DueSubscription,
  now: Date,
  dryRun: boolean,
): Promise<Outcome> {
  // Period: 30 days from period_end (or now() if period_end is null/in past).
  const periodStart = sub.current_period_end ?? now;
  const periodEnd = addDays(periodStart, 30);

  // 1. Reserve a renewal row for this (subscription, period_start). If it
  // already exists, fetch it — could be retry, could be already paid.
  const renewal = await withRLS(adminCtx, async (tx) => {
    const rows = await tx<{
      id: string;
      status: string;
      attempt_count: number;
      payment_intent_id: string | null;
    }[]>`
      insert into subscription_renewals
        (account_id, subscription_id, plan_id, period_start, period_end, status, attempt_count)
      values
        (${sub.account_id}, ${sub.subscription_id}, ${sub.plan_id},
         ${periodStart.toISOString?.() ?? periodStart}, ${periodEnd.toISOString()},
         'pending', 0)
      on conflict (subscription_id, period_start) do update
        set updated_at = now()
      returning id, status, attempt_count, payment_intent_id
    `;
    return rows[0]!;
  });

  if (renewal.status === 'wallet_paid' || renewal.status === 'charged') {
    return { kind: 'skipped' };
  }
  if (dryRun) return { kind: 'skipped' };

  // Card-charge path via Paystack stored authorization.
  if (sub.paystack_authorization_code && sub.paystack_customer_email) {
    return await chargeViaPaystack(sub, renewal.id, periodStart, periodEnd);
  }

  // No saved card — flip to past_due, set grace period.
  return await markFailed(sub, renewal.id, 'no_payment_method', now);
}

async function chargeViaPaystack(
  sub: DueSubscription,
  renewalId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<Outcome> {
  const reference = newReference('sb');
  let intentId: string;

  // Reserve a payment_intent row first so reconciliation can recover.
  await withRLS(adminCtx, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into payment_intents
        (account_id, provider, provider_reference, purpose,
         amount_cents, currency, status)
      values
        (${sub.account_id}, 'paystack', ${reference}, 'subscription',
         ${sub.plan_price_cents}, ${sub.plan_currency}, 'pending')
      returning id
    `;
    intentId = row!.id;
    await tx`
      update subscription_renewals
      set payment_intent_id = ${intentId},
          attempt_count = attempt_count + 1,
          updated_at = now()
      where id = ${renewalId}
    `;
  });

  try {
    const charge = await chargeAuthorization({
      email: sub.paystack_customer_email!,
      amountCents: sub.plan_price_cents,
      authorizationCode: sub.paystack_authorization_code!,
      reference,
      currency: sub.plan_currency,
      metadata: {
        purpose: 'subscription',
        subscription_id: sub.subscription_id,
        renewal_id: renewalId,
      },
    });

    if (charge.status !== 'success') {
      return await markFailed(sub, renewalId, charge.gateway_response ?? 'paystack_declined', new Date());
    }

    await withRLS(adminCtx, async (tx) => {
      await tx`
        update payment_intents
        set status = 'succeeded', completed_at = now(), updated_at = now()
        where id = ${intentId}
      `;
      await tx`
        update subscription_renewals
        set status = 'charged', updated_at = now()
        where id = ${renewalId}
      `;
      await tx`
        update account_subscriptions
        set status = 'active',
            current_period_start = ${periodStart.toISOString?.() ?? periodStart},
            current_period_end = ${periodEnd.toISOString()},
            grace_period_end = null,
            last_renewal_id = ${renewalId},
            updated_at = now()
        where id = ${sub.subscription_id}
      `;
      await createInvoice({
        tx,
        account_id: sub.account_id,
        kind: 'subscription',
        payment_intent_id: intentId,
        total_cents: sub.plan_price_cents,
        currency: sub.plan_currency,
        line_items: [subscriptionLine(sub, periodStart, periodEnd)],
      });
    });
    return { kind: 'charged' };
  } catch (err) {
    return await markFailed(sub, renewalId, (err as Error).message, new Date());
  }
}

async function markFailed(
  sub: DueSubscription,
  renewalId: string,
  reason: string,
  now: Date,
): Promise<Outcome> {
  const attemptCount = await withRLS(adminCtx, async (tx) => {
    const rows = await tx<{ attempt_count: number }[]>`
      select attempt_count from subscription_renewals where id = ${renewalId}
    `;
    return rows[0]?.attempt_count ?? 1;
  });

  // Backoff: 4h, 12h, 24h. After exhausted, push grace_period_end and stop.
  const idx = Math.min(attemptCount - 1, RETRY_BACKOFF_HOURS.length - 1);
  const nextAttempt = new Date(now.getTime() + RETRY_BACKOFF_HOURS[idx]! * 3600_000);
  const exhausted = attemptCount >= RETRY_BACKOFF_HOURS.length;
  const graceEnd = addDays(now, GRACE_DAYS);

  await withRLS(adminCtx, async (tx) => {
    await tx`
      update subscription_renewals
      set status = ${exhausted ? 'failed' : 'pending'},
          failure_reason = ${reason},
          next_attempt_at = ${exhausted ? null : nextAttempt.toISOString()},
          updated_at = now()
      where id = ${renewalId}
    `;
    await tx`
      update account_subscriptions
      set status = 'past_due',
          grace_period_end = coalesce(grace_period_end, ${graceEnd.toISOString()}),
          last_renewal_id = ${renewalId},
          updated_at = now()
      where id = ${sub.subscription_id}
    `;
    if (exhausted) {
      await tx`
        update account_subscriptions
        set status = 'expired', updated_at = now()
        where id = ${sub.subscription_id}
          and grace_period_end < now()
      `;
    }
  });

  return { kind: 'failed', reason };
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function subscriptionLine(
  sub: DueSubscription,
  periodStart: Date,
  periodEnd: Date,
): { description: string; quantity: number; unit_cents: number; line_cents: number } {
  const start = (periodStart instanceof Date ? periodStart : new Date(periodStart))
    .toISOString()
    .slice(0, 10);
  const end = periodEnd.toISOString().slice(0, 10);
  return {
    description: `${sub.plan_code} subscription — ${start} to ${end}`,
    quantity: 1,
    unit_cents: sub.plan_price_cents,
    line_cents: sub.plan_price_cents,
  };
}

// Re-export for index.ts use even though it's unused right now in this file.
export { regionForCountry, REGIONS };
