// Monthly payout job. Pulled out of cmd/cron/run-monthly-payouts.ts so the
// behaviour can be exercised by integration tests with a Paystack fetch stub.

import { withRLS } from './db.ts';
import { createTransferRecipient, initiateTransfer, newReference } from './paystack.ts';
import { previousPeriodKey } from './payout-period.ts';

export const MIN_PAYOUT_CENTS = 50_000;

export type Eligible = {
  user_id: string;
  email: string;
  full_name: string;
  contact_email: string | null;
  bank_account_number: string;
  bank_branch_code: string;
  bank_account_holder: string;
  bank_account_type: string;
  paystack_recipient_code: string | null;
  available_cents: number;
};

export type RunMonthlyPayoutsOpts = {
  period?: string; // defaults to previousPeriodKey(now)
  dryRun?: boolean;
  log?: (line: string) => void;
};

export type RunMonthlyPayoutsResult = {
  period: string;
  processed: number;
  dispatched: number;
  skippedKyc: number;
  skippedAlreadyPaid: number;
  failed: number;
  failures: Array<{ user_id: string; email: string; error: string }>;
};

const adminCtx = { user_id: '', account_id: null, is_platform_admin: true } as const;

export async function runMonthlyPayouts(
  opts: RunMonthlyPayoutsOpts = {},
): Promise<RunMonthlyPayoutsResult> {
  const period = opts.period ?? previousPeriodKey(new Date());
  const log = opts.log ?? (() => {});

  log(`payout run for period ${period}${opts.dryRun ? ' (dry-run)' : ''}`);

  const eligible = await loadEligibleUsers();
  log(`eligible candidates: ${eligible.length}`);

  const result: RunMonthlyPayoutsResult = {
    period,
    processed: 0,
    dispatched: 0,
    skippedKyc: 0,
    skippedAlreadyPaid: 0,
    failed: 0,
    failures: [],
  };

  for (const u of eligible) {
    result.processed++;

    if (!u.bank_account_number || !u.bank_branch_code || !u.bank_account_holder) {
      result.skippedKyc++;
      continue;
    }

    if (await alreadyHasLivePayout(u.user_id, period)) {
      result.skippedAlreadyPaid++;
      continue;
    }

    if (opts.dryRun) {
      result.dispatched++;
      continue;
    }

    try {
      const recipientCode = await ensureRecipient(u);
      await dispatchTransfer(u, period, recipientCode);
      result.dispatched++;
    } catch (err) {
      const msg = (err as Error).message;
      result.failed++;
      result.failures.push({ user_id: u.user_id, email: u.email, error: msg });
      log(`! transfer failed for ${u.email}: ${msg}`);
    }
  }

  return result;
}

async function loadEligibleUsers(): Promise<Eligible[]> {
  return await withRLS(adminCtx, async (tx) => {
    return await tx<Eligible[]>`
      with earned as (
        select referrer_user_id as user_id, sum(amount_zar_cents)::bigint as cents
        from referral_earnings group by referrer_user_id
      ),
      paid as (
        select user_id, sum(amount_zar_cents)::bigint as cents
        from payout_requests where status = 'paid' group by user_id
      ),
      pending as (
        select user_id, sum(amount_zar_cents)::bigint as cents
        from payout_requests where status in ('pending','approved') group by user_id
      )
      select
        u.id as user_id,
        u.email::text as email,
        coalesce(k.full_name, '') as full_name,
        k.contact_email::text as contact_email,
        coalesce(k.bank_account_number, '') as bank_account_number,
        coalesce(k.bank_branch_code, '') as bank_branch_code,
        coalesce(k.bank_account_holder, '') as bank_account_holder,
        coalesce(k.bank_account_type, '') as bank_account_type,
        k.paystack_recipient_code,
        greatest(
          0,
          coalesce(e.cents, 0) - coalesce(pa.cents, 0) - coalesce(pe.cents, 0)
        )::bigint as available_cents
      from users u
      join kyc_profiles k on k.user_id = u.id
      left join earned e on e.user_id = u.id
      left join paid pa on pa.user_id = u.id
      left join pending pe on pe.user_id = u.id
      where u.status = 'active'
        and k.full_name is not null
        and k.cellphone is not null
        and k.id_kind is not null
        and k.id_number is not null
        and k.bank_name is not null
        and k.bank_branch_code is not null
        and k.bank_account_number is not null
        and k.bank_account_holder is not null
        and k.bank_account_type is not null
        and greatest(
          0,
          coalesce(e.cents, 0) - coalesce(pa.cents, 0) - coalesce(pe.cents, 0)
        ) >= ${MIN_PAYOUT_CENTS}
    `;
  });
}

async function alreadyHasLivePayout(userId: string, period: string): Promise<boolean> {
  return await withRLS(adminCtx, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      select id from payout_requests
      where user_id = ${userId}
        and payout_period = ${period}
        and status in ('pending','approved','paid')
      limit 1
    `;
    return rows.length > 0;
  });
}

async function ensureRecipient(u: Eligible): Promise<string> {
  if (u.paystack_recipient_code) return u.paystack_recipient_code;

  const r = await createTransferRecipient({
    name: u.bank_account_holder,
    account_number: u.bank_account_number,
    bank_code: u.bank_branch_code,
    currency: 'ZAR',
    email: u.contact_email ?? u.email,
  });

  await withRLS(adminCtx, async (tx) => {
    await tx`
      update kyc_profiles
      set paystack_recipient_code = ${r.recipient_code},
          paystack_recipient_synced_at = now(),
          updated_at = now()
      where user_id = ${u.user_id}
    `;
  });

  return r.recipient_code;
}

async function dispatchTransfer(
  u: Eligible,
  period: string,
  recipientCode: string,
): Promise<void> {
  const reference = newReference('po');

  const reqId = await withRLS(adminCtx, async (tx) => {
    const snapshot = {
      full_name: u.full_name,
      contact_email: u.contact_email,
      bank_account_number: u.bank_account_number,
      bank_branch_code: u.bank_branch_code,
      bank_account_holder: u.bank_account_holder,
      bank_account_type: u.bank_account_type,
    };
    const [row] = await tx<{ id: string }[]>`
      insert into payout_requests
        (user_id, amount_zar_cents, status, kyc_snapshot, payout_period, auto_generated)
      values
        (${u.user_id}, ${u.available_cents}, 'pending', ${tx.json(snapshot)}, ${period}, true)
      returning id
    `;
    return row!.id;
  });

  try {
    const t = await initiateTransfer({
      amountCents: u.available_cents,
      recipientCode,
      reference,
      reason: `whatsacc referral payout ${period}`,
    });
    await withRLS(adminCtx, async (tx) => {
      await tx`
        update payout_requests
        set status = 'approved',
            paystack_transfer_code = ${t.transfer_code},
            paystack_transfer_id = ${String(t.id)},
            updated_at = now()
        where id = ${reqId}
      `;
    });
  } catch (err) {
    await withRLS(adminCtx, async (tx) => {
      await tx`
        update payout_requests
        set status = 'rejected',
            failure_reason = ${(err as Error).message},
            processed_at = now(),
            updated_at = now()
        where id = ${reqId}
      `;
    });
    throw err;
  }
}
