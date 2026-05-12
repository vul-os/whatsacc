import type { TxSql } from '../db.ts';

export type QuotaStatus = {
  allowed: boolean;
  remaining_included: number;
  total_included: number;
  wallet_balance_cents: number;
  wallet_currency: string;
  payg_price_cents: number;
  can_payg: boolean;
  warning?: string;
};

/**
 * Calculates the current quota status for an account.
 */
export async function getAccountQuotaStatus(
  tx: TxSql,
  accountId: string,
): Promise<QuotaStatus> {
  // 1. Get plan details and current subscription period
  const planRows = await tx<{
    included_opens: number;
    payg_open_price_cents: number;
    current_period_start: Date;
    wallet_balance_cents: number;
    currency: string;
  }[]>`
    select 
      p.included_opens,
      p.payg_open_price_cents,
      s.current_period_start,
      coalesce(w.balance_cents, 0) as wallet_balance_cents,
      coalesce(w.currency, 'ZAR') as currency
    from account_subscriptions s
    join plans p on p.id = s.plan_id
    left join wallets w on w.account_id = s.account_id
    where s.account_id = ${accountId}
      and s.status in ('active', 'trialing', 'past_due')
    limit 1
  `;

  const plan = planRows[0];
  if (!plan) {
    // No active subscription? No access.
    return {
      allowed: false,
      remaining_included: 0,
      total_included: 0,
      wallet_balance_cents: 0,
      wallet_currency: 'ZAR',
      payg_price_cents: 0,
      can_payg: false,
      warning: 'No active subscription found.',
    };
  }

  // 2. Count successful opens in this period
  // We count 'open' commands from any source that were successful.
  const usageRows = await tx<{ count: string }[]>`
    select count(*) as count
    from access_logs
    where account_id = ${accountId}
      and command = 'open'
      and success = true
      and created_at >= ${plan.current_period_start}
  `;
  const used = parseInt(usageRows[0]?.count ?? '0', 10);
  const remainingIncluded = Math.max(0, plan.included_opens - used);

  const canPayg = plan.wallet_balance_cents >= plan.payg_open_price_cents;
  const allowed = remainingIncluded > 0 || canPayg;

  let warning: string | undefined;
  if (remainingIncluded > 0 && remainingIncluded <= 5) {
    warning = `Warning: Only ${remainingIncluded} included opens remaining for this period.`;
  } else if (remainingIncluded === 0 && canPayg) {
    const remainingPayg = Math.floor(plan.wallet_balance_cents / plan.payg_open_price_cents);
    if (remainingPayg <= 5) {
      warning = `Warning: Low wallet balance. Approx ${remainingPayg} opens remaining.`;
    }
  } else if (!allowed) {
    warning = 'Access denied: Monthly quota exhausted and insufficient wallet balance.';
  }

  return {
    allowed,
    remaining_included: remainingIncluded,
    total_included: plan.included_opens,
    wallet_balance_cents: Number(plan.wallet_balance_cents),
    wallet_currency: plan.currency,
    payg_price_cents: plan.payg_open_price_cents,
    can_payg: canPayg,
    warning,
  };
}
