// Abuse-protection rate limits + admin-configured quotas.
//
// Strictly NON-MONETARY — lintel has no billing. Two layers:
//
//   1. Rate limits (always on, env-tunable): per-member open cooldown,
//      per-member opens/hour, per-account opens/hour ceiling, and a
//      per-sender chat-message throttle for webhook floods.
//   2. Quotas (admin policy, off by default): per-location optional caps in
//      location_settings — opens per member per UTC day, opens per location
//      per UTC day. NULL = unlimited.
//
// Counting uses fixed-window counters in Postgres (rate_limit_counters),
// updated atomically via the SECURITY DEFINER app.rate_limit_* functions
// (see migrations/20260505010000_rate_limits.sql). The table itself is
// internal: FORCEd RLS with no policies, so tenants can neither inspect nor
// exhaust each other's counters.
//
// Enforcement is centralized in logAccess() (routes/access.ts), the single
// choke point shared by portal, API, WhatsApp and Slack opens — no open path
// can bypass it.
//
// POLICY CHOICES (documented on purpose):
//   - Quotas apply to every open path (portal, chat, API) for consistency,
//     EXCEPT account owners/admins, who are exempt from quotas — but NOT
//     from rate limits. An admin can always let the plumber in, but a
//     runaway admin script still hits the cooldown/hourly caps.
//   - Admin opens still increment the location's daily counter (they are
//     real gate movements), they just cannot be denied by a quota.
//   - 'close' commands are never limited: closing a gate is the safe
//     direction and should never be refused.
//   - Denied attempts do NOT consume counters — counters track successful
//     opens only, so they double as honest usage numbers for the UI.
//     Enforcement is EXACT under concurrency: every limit is consumed via an
//     atomic increment-if-under-cap (app.rate_limit_try_bump) and the
//     cooldown via an atomic sentinel claim (app.rate_limit_claim_cooldown),
//     so N simultaneous opens can never land a counter past its cap.
//   - FAILURE MODE: if the counter store errors, the open is ALLOWED and the
//     success audit row is tagged error='rate_limit_check_failed'. A gate is
//     physical access — availability wins for enforcement, visibility is
//     preserved through the audit tag. (Fail-open reviewed 2026-07-17:
//     accepted — physical access availability wins; audit-tagged.)

import type { TxSql } from './db.ts';
import { getEnv } from './env.ts';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type RateLimitConfig = {
  /** Min seconds between successful opens per (member, access point). 0 disables. */
  openCooldownS: number;
  /** Max successful opens per member per hour. */
  opensPerHour: number;
  /** Max inbound chat messages per sender per minute before the bot goes quiet. */
  chatMsgsPerMin: number;
  /** Max successful opens per account per hour (runaway-integration ceiling). */
  accountOpensPerHour: number;
};

export const RATE_LIMIT_DEFAULTS: RateLimitConfig = {
  openCooldownS: 10,
  opensPerHour: 30,
  chatMsgsPerMin: 10,
  accountOpensPerHour: 500,
};

/**
 * Parse one env value. Accepts non-negative integers; 0 is a valid explicit
 * value (0 cooldown = disabled; 0 cap = block everything, a kill switch).
 * Missing / malformed / negative values fall back to the default.
 */
export function parseRateLimitValue(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

export function parseRateLimitConfig(raw: {
  RATE_OPEN_COOLDOWN_S?: string;
  RATE_OPENS_PER_HOUR?: string;
  RATE_CHAT_MSGS_PER_MIN?: string;
  RATE_ACCOUNT_OPENS_PER_HOUR?: string;
}): RateLimitConfig {
  return {
    openCooldownS: parseRateLimitValue(raw.RATE_OPEN_COOLDOWN_S, RATE_LIMIT_DEFAULTS.openCooldownS),
    opensPerHour: parseRateLimitValue(raw.RATE_OPENS_PER_HOUR, RATE_LIMIT_DEFAULTS.opensPerHour),
    chatMsgsPerMin: parseRateLimitValue(
      raw.RATE_CHAT_MSGS_PER_MIN,
      RATE_LIMIT_DEFAULTS.chatMsgsPerMin,
    ),
    accountOpensPerHour: parseRateLimitValue(
      raw.RATE_ACCOUNT_OPENS_PER_HOUR,
      RATE_LIMIT_DEFAULTS.accountOpensPerHour,
    ),
  };
}

export function getRateLimitConfig(): RateLimitConfig {
  return parseRateLimitConfig(getEnv());
}

// ---------------------------------------------------------------------------
// Runtime overrides (instance_settings, set by the instance admin)
// ---------------------------------------------------------------------------
// The gateway operator can override the env-configured limits at runtime via
// PATCH /admin/limits. Overrides persist in the internal instance_settings
// table under key 'rate_limits' as a PARTIAL object, e.g. {"opens_per_hour":1}.
// Resolution order per field: db override > env var > built-in default.

/** External (snake_case) override field → internal config key. */
export const RATE_LIMIT_OVERRIDE_FIELDS = {
  open_cooldown_s: 'openCooldownS',
  opens_per_hour: 'opensPerHour',
  chat_msgs_per_min: 'chatMsgsPerMin',
  account_opens_per_hour: 'accountOpensPerHour',
} as const;

export type RateLimitOverrideField = keyof typeof RATE_LIMIT_OVERRIDE_FIELDS;

/** Partial set of overridden values, keyed by external field name. */
export type RateLimitOverrides = Partial<Record<RateLimitOverrideField, number>>;

export const INSTANCE_RATE_LIMITS_KEY = 'rate_limits';

/**
 * Parse the stored jsonb override object defensively: only non-negative
 * integers are accepted; anything else (missing key, garbage, negatives,
 * floats) is ignored so a corrupted settings row can never wedge the limiter.
 */
export function parseStoredOverrides(raw: unknown): RateLimitOverrides {
  const out: RateLimitOverrides = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  for (const field of Object.keys(RATE_LIMIT_OVERRIDE_FIELDS) as RateLimitOverrideField[]) {
    const v = obj[field];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[field] = v;
  }
  return out;
}

/** Apply overrides on top of the env/default config. db > env > default. */
export function mergeRateLimitConfig(
  base: RateLimitConfig,
  overrides: RateLimitOverrides,
): RateLimitConfig {
  const cfg = { ...base };
  for (const [field, key] of Object.entries(RATE_LIMIT_OVERRIDE_FIELDS) as [
    RateLimitOverrideField,
    keyof RateLimitConfig,
  ][]) {
    const v = overrides[field];
    if (v !== undefined) cfg[key] = v;
  }
  return cfg;
}

/** Read the persisted override object (empty when none / unreadable). */
export async function readRateLimitOverrides(tx: TxSql): Promise<RateLimitOverrides> {
  const rows = await tx<{ v: unknown }[]>`
    select app.instance_setting_get(${INSTANCE_RATE_LIMITS_KEY}) as v
  `;
  return parseStoredOverrides(rows[0]?.v ?? null);
}

/**
 * Effective config for enforcement: db override > env > default.
 * FAILURE MODE: if the settings read errors (e.g. migration not applied),
 * fall back to the env config — never block on the settings store. The read
 * runs in a savepoint so a failure can't poison the caller's transaction.
 */
export async function resolveRateLimitConfig(tx: TxSql): Promise<RateLimitConfig> {
  const envCfg = getRateLimitConfig();
  try {
    const overrides = await tx.savepoint(async (stx) => await readRateLimitOverrides(stx));
    return mergeRateLimitConfig(envCfg, overrides);
  } catch (err) {
    console.error('rate_limit_overrides_read_failed', err);
    return envCfg;
  }
}

// ---------------------------------------------------------------------------
// Window math (pure, unit-tested)
// ---------------------------------------------------------------------------

export const HOUR_S = 3600;
export const MINUTE_S = 60;
export const DAY_S = 86400;

/** UTC epoch-aligned fixed-window start containing `now`. */
export function fixedWindowStart(now: Date, windowS: number): Date {
  const epochS = Math.floor(now.getTime() / 1000);
  return new Date(Math.floor(epochS / windowS) * windowS * 1000);
}

/** Whole seconds until the current fixed window rolls over (min 1). */
export function secondsUntilWindowEnd(now: Date, windowS: number): number {
  const start = fixedWindowStart(now, windowS).getTime();
  const end = start + windowS * 1000;
  return Math.max(1, Math.ceil((end - now.getTime()) / 1000));
}

/** Remaining cooldown seconds; 0 when the cooldown has fully elapsed. */
export function cooldownRemainingS(lastOpenAt: Date, now: Date, cooldownS: number): number {
  const elapsedS = (now.getTime() - lastOpenAt.getTime()) / 1000;
  if (elapsedS >= cooldownS) return 0;
  return Math.max(1, Math.ceil(cooldownS - elapsedS));
}

// ---------------------------------------------------------------------------
// Open-path enforcement
// ---------------------------------------------------------------------------

export type OpenLimitInput = {
  /** Authenticated member opening the gate, when known. */
  userId: string | null;
  /** E.164 phone of the opener (WhatsApp path — members and visitor grants). */
  phoneE164?: string | null;
  accessPointId: string;
  locationId: string;
  accountId: string;
  now?: Date;
};

export type OpenLimitDecision =
  | {
      allowed: true;
      /** Set when the counter store failed and enforcement was skipped. */
      degraded?: boolean;
    }
  | {
      allowed: false;
      reason: 'rate_limited' | 'quota_exceeded';
      /** Seconds after which a retry can succeed. */
      retryAfterS: number;
      /** Which limit tripped (for logs/tests, not user-facing). */
      limit:
        | 'open_cooldown'
        | 'member_opens_per_hour'
        | 'account_opens_per_hour'
        | 'member_opens_per_day'
        | 'location_opens_per_day';
    };

function openSubject(input: OpenLimitInput): string | null {
  if (input.userId) return `user:${input.userId}`;
  if (input.phoneE164) return `phone:${input.phoneE164}`;
  return null;
}

async function bump(
  tx: TxSql,
  scope: string,
  subject: string,
  windowStart: Date,
  amount = 1,
): Promise<number> {
  const rows = await tx<{ count: number }[]>`
    select app.rate_limit_bump(${scope}, ${subject}, ${windowStart}, ${amount}) as count
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Atomically consume one unit of a capped counter. Returns the
 * post-increment count when consumed, or null when the cap would be
 * exceeded — in which case NOTHING was consumed. cap === null means
 * uncapped (plain increment).
 */
async function tryBump(
  tx: TxSql,
  scope: string,
  subject: string,
  windowStart: Date,
  cap: number | null,
): Promise<number | null> {
  const rows = await tx<{ count: number | null }[]>`
    select app.rate_limit_try_bump(${scope}, ${subject}, ${windowStart}, ${cap}) as count
  `;
  const v = rows[0]?.count;
  return v === null || v === undefined ? null : Number(v);
}

/**
 * Atomically claim the cooldown sentinel: true iff the previous successful
 * open is at least cooldownS old (the sentinel is then refreshed). A failed
 * claim leaves the sentinel untouched. cooldownS <= 0 always claims.
 */
async function claimCooldown(tx: TxSql, subject: string, cooldownS: number): Promise<boolean> {
  const rows = await tx<{ ok: boolean }[]>`
    select app.rate_limit_claim_cooldown(${subject}, ${cooldownS}) as ok
  `;
  return rows[0]?.ok === true;
}

/**
 * Check every open limit and, when allowed, consume the counters.
 *
 * Increment-then-check, one atomic statement per limit: each counter is
 * consumed via app.rate_limit_try_bump, which increments ONLY when the
 * post-increment count stays within the cap (ON CONFLICT DO UPDATE ...
 * WHERE count < cap). Concurrent opens serialize on the counter row, so the
 * bound is EXACT — N simultaneous requests at count = cap-1 admit exactly
 * one, never cap+N. The cooldown is claimed the same way (atomic
 * conditional UPDATE on the sentinel row), so two simultaneous opens cannot
 * both pass it. When a later limit denies the attempt, counters already
 * consumed for THIS attempt are handed back (bump -1), preserving the
 * documented semantics: denials never consume, and counters exactly equal
 * successful opens.
 *
 * Throws on counter-store failure — use guardedCheckOpenLimits() for the
 * fail-open wrapper.
 */
export async function checkAndConsumeOpenLimits(
  tx: TxSql,
  input: OpenLimitInput,
): Promise<OpenLimitDecision> {
  // db override > env > default (see resolveRateLimitConfig).
  const cfg = await resolveRateLimitConfig(tx);
  const now = input.now ?? new Date();
  const subject = openSubject(input);
  const hourStart = fixedWindowStart(now, HOUR_S);
  const dayStart = fixedWindowStart(now, DAY_S);
  const acctSubject = `acct:${input.accountId}`;
  const locSubject = `loc:${input.locationId}`;

  // Quota config + admin exemption in one round trip. Runs under the
  // caller's RLS context: members can see their own account_members rows and
  // the location settings; the anon webhook context passes the NULL-user
  // policies.
  const cfgRows = await tx<
    { member_quota: number | null; location_quota: number | null; is_admin: boolean }[]
  >`
    select
      ls.max_opens_per_member_per_day as member_quota,
      ls.max_opens_per_location_per_day as location_quota,
      (
        ${input.userId ?? null}::uuid is not null
        and exists (
          select 1 from account_members am
          where am.account_id = ${input.accountId}::uuid
            and am.user_id = ${input.userId ?? null}::uuid
            and am.status = 'active'
            and am.role in ('owner', 'admin')
        )
      ) as is_admin
    from (select 1) as one
    left join location_settings ls on ls.location_id = ${input.locationId}::uuid
  `;
  const quota = cfgRows[0] ?? { member_quota: null, location_quota: null, is_admin: false };

  const cdSubject = subject ? `${subject}|ap:${input.accessPointId}` : null;

  // Counters consumed for THIS attempt so far — handed back if a later
  // limit denies it (denials must never consume).
  const consumed: Array<{ scope: string; subject: string; windowStart: Date }> = [];
  const handBack = async (): Promise<void> => {
    for (const c of consumed) await bump(tx, c.scope, c.subject, c.windowStart, -1);
  };

  // --- Cooldown fast-path (read-only) --------------------------------------
  // Cheap early deny with a precise Retry-After. The AUTHORITATIVE check is
  // the atomic sentinel claim at the end — this read alone would race.

  if (cdSubject && cfg.openCooldownS > 0) {
    const rows = await tx<{ last: Date | null }[]>`
      select app.rate_limit_last('open_cd', ${cdSubject}) as last
    `;
    const last = rows[0]?.last ? new Date(rows[0].last) : null;
    if (last) {
      const remaining = cooldownRemainingS(last, now, cfg.openCooldownS);
      if (remaining > 0) {
        return { allowed: false, reason: 'rate_limited', retryAfterS: remaining, limit: 'open_cooldown' };
      }
    }
  }

  // --- Rate limits (everyone, admins included) -----------------------------

  if (subject) {
    const memberHour = await tryBump(tx, 'opens_1h', subject, hourStart, cfg.opensPerHour);
    if (memberHour === null) {
      await handBack();
      return {
        allowed: false,
        reason: 'rate_limited',
        retryAfterS: secondsUntilWindowEnd(now, HOUR_S),
        limit: 'member_opens_per_hour',
      };
    }
    consumed.push({ scope: 'opens_1h', subject, windowStart: hourStart });
  }

  const acctHour = await tryBump(tx, 'acct_opens_1h', acctSubject, hourStart, cfg.accountOpensPerHour);
  if (acctHour === null) {
    await handBack();
    return {
      allowed: false,
      reason: 'rate_limited',
      retryAfterS: secondsUntilWindowEnd(now, HOUR_S),
      limit: 'account_opens_per_hour',
    };
  }
  consumed.push({ scope: 'acct_opens_1h', subject: acctSubject, windowStart: hourStart });

  // --- Quotas (admin policy; owners/admins exempt) -------------------------
  // Admin-exempt opens still increment the daily counters (they are real
  // gate movements) — cap null = uncapped increment.

  if (subject) {
    const mdSubject = `${subject}|loc:${input.locationId}`;
    const memberDayCap =
      !quota.is_admin && quota.member_quota !== null ? Number(quota.member_quota) : null;
    const memberDay = await tryBump(tx, 'opens_1d', mdSubject, dayStart, memberDayCap);
    if (memberDay === null) {
      await handBack();
      return {
        allowed: false,
        reason: 'quota_exceeded',
        retryAfterS: secondsUntilWindowEnd(now, DAY_S),
        limit: 'member_opens_per_day',
      };
    }
    consumed.push({ scope: 'opens_1d', subject: mdSubject, windowStart: dayStart });
  }

  const locDayCap =
    !quota.is_admin && quota.location_quota !== null ? Number(quota.location_quota) : null;
  const locDay = await tryBump(tx, 'loc_opens_1d', locSubject, dayStart, locDayCap);
  if (locDay === null) {
    await handBack();
    return {
      allowed: false,
      reason: 'quota_exceeded',
      retryAfterS: secondsUntilWindowEnd(now, DAY_S),
      limit: 'location_opens_per_day',
    };
  }
  consumed.push({ scope: 'loc_opens_1d', subject: locSubject, windowStart: dayStart });

  // --- Cooldown claim (authoritative, atomic) ------------------------------
  // Last on purpose: the sentinel's updated_at is only refreshed when the
  // open is fully allowed, so a denied attempt never restarts anyone's
  // cooldown. With cooldown disabled (0) the claim always succeeds and
  // still records the last successful open.

  if (cdSubject) {
    const claimed = await claimCooldown(tx, cdSubject, cfg.openCooldownS);
    if (!claimed) {
      await handBack();
      // Lost a concurrent race for the sentinel — recompute Retry-After
      // from the winner's refreshed timestamp.
      const rows = await tx<{ last: Date | null }[]>`
        select app.rate_limit_last('open_cd', ${cdSubject}) as last
      `;
      const last = rows[0]?.last ? new Date(rows[0].last) : null;
      const remaining = last ? cooldownRemainingS(last, now, cfg.openCooldownS) : cfg.openCooldownS;
      return {
        allowed: false,
        reason: 'rate_limited',
        retryAfterS: Math.max(1, remaining),
        limit: 'open_cooldown',
      };
    }
  }

  return { allowed: true };
}

/**
 * Fail-open wrapper. If the counter store errors, roll back to a savepoint
 * (Postgres poisons the surrounding transaction after any error, so the
 * caller's audit-log insert would otherwise fail too) and ALLOW the open,
 * flagged degraded so logAccess records error='rate_limit_check_failed'.
 * A gate is physical access — availability wins for enforcement,
 * visibility is preserved. (Fail-open reviewed 2026-07-17: accepted —
 * physical access availability wins; audit-tagged.)
 */
export async function guardedCheckOpenLimits(
  tx: TxSql,
  input: OpenLimitInput,
): Promise<OpenLimitDecision> {
  try {
    return await tx.savepoint(async (stx) => await checkAndConsumeOpenLimits(stx, input));
  } catch (err) {
    console.error('rate_limit_check_failed', err);
    return { allowed: true, degraded: true };
  }
}

// ---------------------------------------------------------------------------
// Phone-OTP flow limits
// ---------------------------------------------------------------------------
// Persistent fixed-window counters for the phone verification flow
// (src/routes/phones.ts). These exist because the per-challenge attempt cap
// alone is resettable: POST /me/phones re-add restarts the challenge with a
// fresh code and attempts = 0, so without a persistent counter an attacker
// could grind the 10^6 code space indefinitely.
//
//   otp_start  — challenges started per USER per hour (also bounds how many
//                fresh codes / WhatsApp sends one user can trigger).
//   otp_verify — verify attempts per PHONE ROW per hour, surviving challenge
//                restarts within the window.
//
// FAILURE MODE: unlike the gate-open path these are NOT fail-open — an OTP
// verification is an identity claim, not physical access, so a counter-store
// error propagates (request fails closed).

export const OTP_START_MAX_PER_HOUR = 5;
export const OTP_VERIFY_MAX_PER_HOUR = 15;

export type OtpLimitDecision = { allowed: true } | { allowed: false; retryAfterS: number };

async function consumeOtpLimit(
  tx: TxSql,
  scope: 'otp_start' | 'otp_verify',
  subject: string,
  cap: number,
  now: Date,
): Promise<OtpLimitDecision> {
  const hourStart = fixedWindowStart(now, HOUR_S);
  const count = await tryBump(tx, scope, subject, hourStart, cap);
  if (count === null) {
    return { allowed: false, retryAfterS: secondsUntilWindowEnd(now, HOUR_S) };
  }
  return { allowed: true };
}

/** Consume one OTP-challenge start for a user; deny past the hourly cap. */
export async function consumeOtpStartLimit(
  tx: TxSql,
  userId: string,
  now: Date = new Date(),
): Promise<OtpLimitDecision> {
  return await consumeOtpLimit(tx, 'otp_start', `user:${userId}`, OTP_START_MAX_PER_HOUR, now);
}

/** Consume one OTP verify attempt for a phone row; deny past the hourly cap. */
export async function consumeOtpVerifyLimit(
  tx: TxSql,
  phoneRowId: string,
  now: Date = new Date(),
): Promise<OtpLimitDecision> {
  return await consumeOtpLimit(
    tx,
    'otp_verify',
    `phone_row:${phoneRowId}`,
    OTP_VERIFY_MAX_PER_HOUR,
    now,
  );
}

// ---------------------------------------------------------------------------
// Chat flood throttle
// ---------------------------------------------------------------------------

/**
 * Count an inbound chat message for a sender subject ('phone:+27...',
 * 'slack:U123', 'tg:12345'). Returns quiet=true when the sender exceeded
 * RATE_CHAT_MSGS_PER_MIN in the current minute window — the bot should stop
 * replying (but the webhook must still return 200 so the provider does not
 * amplify with retries). Fail-open on counter-store errors: keep replying.
 */
export async function noteChatMessage(
  tx: TxSql,
  subject: string,
  now: Date = new Date(),
): Promise<{ quiet: boolean }> {
  const cfg = await resolveRateLimitConfig(tx);
  try {
    const count = await tx.savepoint(
      async (stx) => await bump(stx, 'chat_1m', subject, fixedWindowStart(now, MINUTE_S)),
    );
    return { quiet: count > cfg.chatMsgsPerMin };
  } catch (err) {
    console.error('chat_rate_limit_check_failed', err);
    return { quiet: false };
  }
}

// ---------------------------------------------------------------------------
// User-facing denial copy (shared by WhatsApp + Slack)
// ---------------------------------------------------------------------------

export function chatDenialMessage(denial: {
  reason: 'rate_limited' | 'quota_exceeded' | 'account_suspended' | 'user_disabled';
  retry_after_s: number;
}): string {
  if (denial.reason === 'account_suspended') {
    return 'This account has been suspended by the gateway operator — the gate cannot be opened. Contact your operator for help.';
  }
  if (denial.reason === 'user_disabled') {
    return 'Your lintel user has been disabled by the gateway operator — the gate cannot be opened. Contact your operator for help.';
  }
  if (denial.reason === 'quota_exceeded') {
    const base = getEnv().APP_PUBLIC_URL.replace(/\/$/, '');
    return `Daily limit reached for this location — contact your admin. The web portal: ${base}/app`;
  }
  const mins = Math.max(1, Math.ceil(denial.retry_after_s / 60));
  return `Too many opens — try again in ~${mins} min.`;
}
