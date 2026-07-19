package store

// Abuse-protection rate limits + admin quotas, porting backend
// src/lib/rate-limit.ts onto SQLite. Strictly NON-MONETARY.
//
// Counting uses fixed-window counters (rate_limit_counters) plus a cooldown
// sentinel table (rate_limit_cooldowns), updated with atomic
// increment-if-under-cap statements. SQLite has one writer and the store
// runs a single serialized connection, so each statement is atomic and the
// bounds are EXACT under concurrency (the Postgres backend needed
// SECURITY DEFINER upsert functions for the same guarantee).
//
// POLICY (ported verbatim):
//   - Quotas exempt account owners/admins; rate limits never exempt anyone.
//   - Admin opens still increment daily counters (real gate movements).
//   - 'close' is never limited.
//   - Denials never consume: counters equal successful opens exactly.
//     Counters consumed for a denied attempt are handed back (bump -1).
//   - FAILURE MODE: counter-store errors ALLOW the open, tagged
//     error='rate_limit_check_failed' in the audit row (physical access —
//     availability wins; reviewed + accepted upstream 2026-07-17).

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
	"strings"
)

// Window sizes (seconds).
const (
	MinuteS int64 = 60
	HourS   int64 = 3600
	DayS    int64 = 86400
)

// FixedWindowStart is the UTC epoch-aligned window containing now.
func FixedWindowStart(nowUnix, windowS int64) int64 {
	return nowUnix - nowUnix%windowS
}

// SecondsUntilWindowEnd is the whole seconds until rollover (min 1).
func SecondsUntilWindowEnd(nowUnix, windowS int64) int64 {
	rem := FixedWindowStart(nowUnix, windowS) + windowS - nowUnix
	if rem < 1 {
		return 1
	}
	return rem
}

// CooldownRemainingS is the remaining cooldown (0 when elapsed, min 1 otherwise).
func CooldownRemainingS(lastOpenAt, nowUnix, cooldownS int64) int64 {
	elapsed := nowUnix - lastOpenAt
	if elapsed >= cooldownS {
		return 0
	}
	rem := cooldownS - elapsed
	if rem < 1 {
		return 1
	}
	return rem
}

// ---------------------------------------------------------------------------
// Config: built-in defaults < env < instance_settings overrides
// ---------------------------------------------------------------------------

// RateLimitConfig mirrors the backend's RateLimitConfig.
type RateLimitConfig struct {
	OpenCooldownS       int64 // min seconds between opens per (subject, access point); 0 disables
	OpensPerHour        int64 // per member
	ChatMsgsPerMin      int64 // webhook flood throttle (channel seam)
	AccountOpensPerHour int64 // runaway-integration ceiling
}

// RateLimitDefaults are the built-in values (backend RATE_LIMIT_DEFAULTS).
var RateLimitDefaults = RateLimitConfig{
	OpenCooldownS:       10,
	OpensPerHour:        30,
	ChatMsgsPerMin:      10,
	AccountOpensPerHour: 500,
}

// ParseRateLimitValue accepts non-negative integers; 0 is valid (0 cooldown =
// disabled; 0 cap = kill switch). Missing/garbage/negative → fallback.
func ParseRateLimitValue(raw string, fallback int64) int64 {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 0 {
		return fallback
	}
	return n
}

// ParseRateLimitConfig builds the env layer from a lookup func (os.Getenv in
// production, a map in tests). Env vars are the backend's names.
func ParseRateLimitConfig(getenv func(string) string) RateLimitConfig {
	d := RateLimitDefaults
	return RateLimitConfig{
		OpenCooldownS:       ParseRateLimitValue(getenv("RATE_OPEN_COOLDOWN_S"), d.OpenCooldownS),
		OpensPerHour:        ParseRateLimitValue(getenv("RATE_OPENS_PER_HOUR"), d.OpensPerHour),
		ChatMsgsPerMin:      ParseRateLimitValue(getenv("RATE_CHAT_MSGS_PER_MIN"), d.ChatMsgsPerMin),
		AccountOpensPerHour: ParseRateLimitValue(getenv("RATE_ACCOUNT_OPENS_PER_HOUR"), d.AccountOpensPerHour),
	}
}

// InstanceRateLimitsKey is the instance_settings key for runtime overrides.
const InstanceRateLimitsKey = "rate_limits"

// RateLimitOverrides is the partial override object stored by PATCH
// /admin/limits, keyed by the external snake_case field names.
type RateLimitOverrides map[string]int64

// RateLimitOverrideFields are the accepted external field names.
var RateLimitOverrideFields = []string{
	"open_cooldown_s", "opens_per_hour", "chat_msgs_per_min", "account_opens_per_hour",
}

// ParseStoredOverrides parses the stored json defensively: only non-negative
// integers on known fields are accepted — a corrupted settings row can never
// wedge the limiter.
func ParseStoredOverrides(raw json.RawMessage) RateLimitOverrides {
	out := RateLimitOverrides{}
	if len(raw) == 0 {
		return out
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return out
	}
	for _, f := range RateLimitOverrideFields {
		num, ok := m[f].(json.Number)
		if !ok {
			continue
		}
		n, err := num.Int64()
		// Reject floats (Int64 errors) and negatives; strconv round-trip
		// guards "1.0"-style numbers that Int64 would accept on some paths.
		if err != nil || n < 0 || num.String() != strconv.FormatInt(n, 10) {
			continue
		}
		out[f] = n
	}
	return out
}

// MergeRateLimitConfig applies overrides on top of the env/default config.
func MergeRateLimitConfig(base RateLimitConfig, o RateLimitOverrides) RateLimitConfig {
	cfg := base
	if v, ok := o["open_cooldown_s"]; ok {
		cfg.OpenCooldownS = v
	}
	if v, ok := o["opens_per_hour"]; ok {
		cfg.OpensPerHour = v
	}
	if v, ok := o["chat_msgs_per_min"]; ok {
		cfg.ChatMsgsPerMin = v
	}
	if v, ok := o["account_opens_per_hour"]; ok {
		cfg.AccountOpensPerHour = v
	}
	return cfg
}

// ReadRateLimitOverrides reads the persisted override object (empty when
// none / unreadable).
func (s *Store) ReadRateLimitOverrides(ctx context.Context) RateLimitOverrides {
	raw, err := s.InstanceSettingGet(ctx, InstanceRateLimitsKey)
	if err != nil {
		return RateLimitOverrides{}
	}
	return ParseStoredOverrides(raw)
}

// ResolveRateLimitConfig is the effective enforcement config: db override >
// env > default. FAILURE MODE: an unreadable settings row falls back to the
// env config — the limiter never blocks on the settings store.
func (s *Store) ResolveRateLimitConfig(ctx context.Context, envCfg RateLimitConfig) RateLimitConfig {
	return MergeRateLimitConfig(envCfg, s.ReadRateLimitOverrides(ctx))
}

// ---------------------------------------------------------------------------
// Counter primitives (each one statement = atomic under SQLite's writer lock)
// ---------------------------------------------------------------------------

// bump adjusts a counter unconditionally (used with -1 to hand back a unit
// consumed by an attempt that a later limit denied). Floors at 0.
func (s *Store) rateLimitBump(ctx context.Context, scope, subject string, windowStart, amount int64) error {
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO rate_limit_counters (scope, subject, window_start, count)
		 VALUES (?, ?, ?, 0) ON CONFLICT (scope, subject, window_start) DO NOTHING`,
		scope, subject, windowStart); err != nil {
		return err
	}
	// The adjustment itself is one atomic UPDATE; interleavings with other
	// bumps still net correctly.
	_, err := s.db.ExecContext(ctx,
		`UPDATE rate_limit_counters SET count = max(count + ?, 0)
		 WHERE scope = ? AND subject = ? AND window_start = ?`,
		amount, scope, subject, windowStart)
	return err
}

// rateLimitTryBump atomically consumes one unit of a capped counter.
// Returns consumed=false (nothing consumed) when the cap would be exceeded.
// cap == nil means uncapped; cap == 0 denies everything (kill switch).
func (s *Store) rateLimitTryBump(ctx context.Context, scope, subject string, windowStart int64, cap *int64) (bool, error) {
	if cap == nil {
		return true, s.rateLimitBump(ctx, scope, subject, windowStart, 1)
	}
	if *cap <= 0 {
		return false, nil
	}
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO rate_limit_counters (scope, subject, window_start, count)
		 VALUES (?, ?, ?, 1)
		 ON CONFLICT (scope, subject, window_start) DO UPDATE SET count = count + 1
		 WHERE count < ?`,
		scope, subject, windowStart, *cap)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// rateLimitLast reads the cooldown sentinel's last successful open.
func (s *Store) rateLimitLast(ctx context.Context, subject string) (int64, bool, error) {
	var last int64
	err := s.db.QueryRowContext(ctx,
		`SELECT last_open_at FROM rate_limit_cooldowns WHERE subject = ?`, subject).Scan(&last)
	if err == sql.ErrNoRows {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return last, true, nil
}

// rateLimitClaimCooldown atomically claims the cooldown sentinel: true iff
// the previous successful open is at least cooldownS old (sentinel then
// refreshed). A failed claim leaves the sentinel untouched. cooldownS <= 0
// always claims (and still records the last successful open).
func (s *Store) rateLimitClaimCooldown(ctx context.Context, subject string, nowUnix, cooldownS int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO rate_limit_cooldowns (subject, last_open_at)
		 VALUES (?, ?)
		 ON CONFLICT (subject) DO UPDATE SET last_open_at = excluded.last_open_at
		 WHERE excluded.last_open_at - last_open_at >= ?`,
		subject, nowUnix, cooldownS)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// NoteChatMessage counts an inbound chat message for a sender subject.
// quiet=true past the per-minute cap (the bot should stop replying, but the
// webhook still 200s). Fail-open on counter errors: keep replying.
func (s *Store) NoteChatMessage(ctx context.Context, envCfg RateLimitConfig, subject string, nowUnix int64) bool {
	cfg := s.ResolveRateLimitConfig(ctx, envCfg)
	ws := FixedWindowStart(nowUnix, MinuteS)
	if err := s.rateLimitBump(ctx, "chat_1m", subject, ws, 1); err != nil {
		return false
	}
	var count int64
	if err := s.db.QueryRowContext(ctx,
		`SELECT count FROM rate_limit_counters WHERE scope='chat_1m' AND subject=? AND window_start=?`,
		subject, ws).Scan(&count); err != nil {
		return false
	}
	return count > cfg.ChatMsgsPerMin
}
