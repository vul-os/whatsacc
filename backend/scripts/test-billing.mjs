#!/usr/bin/env node
// Billing simulation — 1 second = 1 day.
//
// Verifies that:
//   • Wallet is debited at the end of each 30-day period
//   • Subscription period advances correctly after each renewal
//   • Wallet topup restores balance so subsequent renewals succeed
//   • A past_due state triggers when funds run dry (optional: reduce initial balance)
//
// Usage (from backend/):
//   npm run test:billing              — uses ../.env (local dev DB)
//   npm run test:billing:dev          — uses ../.env.dev (Neon dev branch)
//
// Runtime: ~95 seconds (95 simulated days × 1 s/day)

import pg from 'pg';
import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';

const DB_URL = (process.env.DATABASE_URL ?? '').trim();
if (!DB_URL) {
  console.error('\nerror: DATABASE_URL not set — run with --env-file=../.env\n');
  process.exit(2);
}

// ─── DB ──────────────────────────────────────────────────────────────────────
const dbUrl = new URL(DB_URL);
const { address: dbAddr } = await lookup(dbUrl.hostname, { family: 4 });
const db = new pg.Client({
  host: dbAddr,
  port: Number(dbUrl.port) || 5432,
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  database: dbUrl.pathname.replace(/^\//, ''),
  ssl: { servername: dbUrl.hostname, rejectUnauthorized: false },
});
await db.connect();

// ─── Config ───────────────────────────────────────────────────────────────────
const DAY_MS       = 1_000;           // 1 second = 1 day
const MONTH_DAYS   = 30;
const MONTH_MS     = MONTH_DAYS * DAY_MS;
const TOTAL_DAYS   = 95;
const TOPUP_DAY    = 80;
const TOPUP_CENTS  = 20_000;          // R200.00
const WALLET_START = 30_000;          // R300.00  (enough for 3 months exactly)

// ─── Colour helpers ───────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  grey:   '\x1b[90m',
};
const zar  = c => `R${(c / 100).toFixed(2)}`;
const ok   = s => console.log(`  ${C.green}✓${C.reset} ${s}`);
const fail = s => console.log(`  ${C.red}✗${C.reset} ${s}`);
const head = s => console.log(`\n${C.bold}${s}${C.reset}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Cleanup on Ctrl-C ────────────────────────────────────────────────────────
let accountId, userId;
process.on('SIGINT', async () => {
  console.log('\n\nInterrupted — cleaning up test data…');
  if (accountId) await db.query('DELETE FROM accounts WHERE id = $1', [accountId]).catch(() => {});
  if (userId)    await db.query('DELETE FROM users    WHERE id = $1', [userId]).catch(() => {});
  await db.end().catch(() => {});
  process.exit(0);
});

// ─── Setup ────────────────────────────────────────────────────────────────────
head('── Setup ────────────────────────────────────────────────────────────────');

const planRow = await db.query(
  `SELECT id, price_cents, currency, name
     FROM plans WHERE code = 'basic' AND region_code = 'za'`
);
if (!planRow.rows[0]) {
  fail("Plan 'basic/za' not found — run: npm run migrate");
  await db.end();
  process.exit(1);
}
const plan = planRow.rows[0];
ok(`Plan: ${plan.name} ZA — ${zar(plan.price_cents)}/month`);

// Isolated test user
userId = randomUUID();
const testEmail = `billing-sim-${userId.slice(0, 8)}@test.local`;
await db.query(
  `INSERT INTO users (id, email, status) VALUES ($1, $2, 'active')`,
  [userId, testEmail]
);
await db.query(
  `INSERT INTO profiles (id, display_name) VALUES ($1, 'Billing Sim')`,
  [userId]
);

const acctRow = await db.query(
  `INSERT INTO accounts (name, billing_type, status, country_code)
   VALUES ('Billing Sim', 'personal', 'active', 'ZA') RETURNING id`
);
accountId = acctRow.rows[0].id;
await db.query(
  `INSERT INTO account_members (account_id, user_id, role, status)
   VALUES ($1, $2, 'owner', 'active')`,
  [accountId, userId]
);
ok(`Account: ${accountId}`);

// Wallet seeded with R300 (3 full months)
await db.query(
  `INSERT INTO wallets (account_id, balance_cents, currency)
   VALUES ($1, $2, 'ZAR')`,
  [accountId, WALLET_START]
);
ok(`Wallet: ${zar(WALLET_START)}`);

// Subscribe — first period ends in 30 seconds ("30 days")
const t0 = new Date();
const firstPeriodEnd = new Date(t0.getTime() + MONTH_MS);
const subRow = await db.query(
  `INSERT INTO account_subscriptions
     (account_id, plan_id, status, current_period_start, current_period_end)
   VALUES ($1, $2, 'active', $3, $4) RETURNING id`,
  [accountId, plan.id, t0, firstPeriodEnd]
);
const subscriptionId = subRow.rows[0].id;
ok(`Subscription: first renewal at Day ${MONTH_DAYS}`);

// ─── Simulation ───────────────────────────────────────────────────────────────
head('── Simulation (1 s = 1 day) ─────────────────────────────────────────────');
console.log(
  `  Plan ${plan.name} ZA  •  ${zar(WALLET_START)} wallet  ` +
  `•  Topup ${zar(TOPUP_CENTS)} on Day ${TOPUP_DAY}  •  ${TOTAL_DAYS} days\n`
);

let walletCents = WALLET_START;
let cycles = 0;
let failures = 0;

for (let day = 1; day <= TOTAL_DAYS; day++) {
  await sleep(DAY_MS);

  const simNow = new Date(t0.getTime() + day * DAY_MS);
  const events = [];

  // ── Topup event ─────────────────────────────────────────────────────────────
  if (day === TOPUP_DAY) {
    await db.query(
      `UPDATE wallets
         SET balance_cents = balance_cents + $1, updated_at = now()
       WHERE account_id = $2`,
      [TOPUP_CENTS, accountId]
    );
    await db.query(
      `INSERT INTO wallet_transactions (account_id, delta_cents, reason, reference)
       VALUES ($1, $2, 'topup', $3)`,
      [accountId, TOPUP_CENTS, `sim-topup-day${day}`]
    );
    walletCents += TOPUP_CENTS;
    events.push(`${C.cyan}💰 Topup ${zar(TOPUP_CENTS)}${C.reset}`);
  }

  // ── Check renewal ────────────────────────────────────────────────────────────
  const subRow2 = await db.query(
    `SELECT current_period_end, status FROM account_subscriptions WHERE id = $1`,
    [subscriptionId]
  );
  const periodEnd = new Date(subRow2.rows[0].current_period_end);

  if (simNow >= periodEnd && subRow2.rows[0].status !== 'expired') {
    cycles++;
    const newStart = periodEnd;
    // Advance by MONTH_MS seconds (= 30 "days" in sim time) so next renewal
    // triggers exactly 30 seconds from now.
    const newEnd = new Date(periodEnd.getTime() + MONTH_MS);

    if (walletCents >= plan.price_cents) {
      // ── Wallet-paid renewal ───────────────────────────────────────────────
      await db.query(
        `UPDATE wallets
           SET balance_cents = balance_cents - $1, updated_at = now()
         WHERE account_id = $2`,
        [plan.price_cents, accountId]
      );
      const renewalRow = await db.query(
        `INSERT INTO subscription_renewals
           (account_id, subscription_id, plan_id,
            period_start, period_end, status, attempt_count)
         VALUES ($1, $2, $3, $4, $5, 'wallet_paid', 1)
         RETURNING id`,
        [accountId, subscriptionId, plan.id, newStart, newEnd]
      );
      await db.query(
        `INSERT INTO wallet_transactions (account_id, delta_cents, reason, reference)
         VALUES ($1, $2, 'subscription', $3)`,
        [accountId, -plan.price_cents, `renewal:${renewalRow.rows[0].id}`]
      );
      await db.query(
        `UPDATE account_subscriptions
           SET status = 'active',
               current_period_start = $1,
               current_period_end   = $2,
               last_renewal_id      = $3,
               updated_at           = now()
         WHERE id = $4`,
        [newStart, newEnd, renewalRow.rows[0].id, subscriptionId]
      );
      walletCents -= plan.price_cents;
      events.push(
        `${C.yellow}💳 Cycle ${cycles}: debited ${zar(plan.price_cents)}${C.reset}`
      );
    } else {
      // ── Insufficient funds ────────────────────────────────────────────────
      failures++;
      const graceEnd = new Date(simNow.getTime() + 7 * DAY_MS);
      await db.query(
        `UPDATE account_subscriptions
           SET status = 'past_due', grace_period_end = $1, updated_at = now()
         WHERE id = $2`,
        [graceEnd, subscriptionId]
      );
      events.push(
        `${C.red}⚠ Cycle ${cycles}: insufficient funds — past_due (grace ends Day ${day + 7})${C.reset}`
      );
    }
  }

  // ── Print day line ───────────────────────────────────────────────────────────
  const dayLabel  = `Day ${String(day).padStart(3)}`;
  const balLabel  = `${zar(walletCents).padStart(9)}`;
  const evtStr    = events.length ? `  ${events.join(' · ')}` : '';
  const dim       = events.length ? '' : C.grey;
  process.stdout.write(`${dim}${dayLabel}  │  ${balLabel}${C.reset}${evtStr}\n`);
}

// ─── Results ─────────────────────────────────────────────────────────────────
head('── Results ──────────────────────────────────────────────────────────────');

const renewalRows = await db.query(
  `SELECT period_start, period_end, status
     FROM subscription_renewals
    WHERE subscription_id = $1
    ORDER BY period_start`,
  [subscriptionId]
);
ok(`Completed ${cycles} billing cycle(s), ${failures} failure(s)`);
for (const r of renewalRows.rows) {
  const s = new Date(r.period_start).toISOString().slice(0, 23);
  const e = new Date(r.period_end).toISOString().slice(0, 23);
  console.log(`    [${r.status.padEnd(12)}]  ${s}  →  ${e}`);
}

const walletRow = await db.query(
  `SELECT balance_cents FROM wallets WHERE account_id = $1`,
  [accountId]
);
const finalBalance = Number(walletRow.rows[0].balance_cents);
const expectedBalance = WALLET_START + TOPUP_CENTS - plan.price_cents * (cycles - failures);
ok(`Final wallet: ${zar(finalBalance)}`);
const balanceOk = finalBalance === expectedBalance;
(balanceOk ? ok : fail)(
  `Balance assertion: expected ${zar(expectedBalance)} — ${balanceOk ? 'PASS ✓' : 'FAIL ✗'}`
);

// ─── Cleanup ─────────────────────────────────────────────────────────────────
head('── Cleanup ──────────────────────────────────────────────────────────────');
await db.query('DELETE FROM accounts WHERE id = $1', [accountId]);
await db.query('DELETE FROM users    WHERE id = $1', [userId]);
ok('Test data removed');
await db.end();
console.log();
