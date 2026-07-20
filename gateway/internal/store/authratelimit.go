package store

// Brute-force protection for the credential endpoints (login/register/
// refresh) and the one-shot instance-admin claim — security assessment
// finding: none of POST /v1/auth/{login,register,refresh} or
// POST /v1/admin/claim had any rate limiting or lockout at all. A guessed
// password bought a 15-minute JWT and, from there, a 7-day offline grant.
//
// REUSES the existing rate_limit_counters fixed-window primitives
// (ratelimit.go's rateLimitTryBump/rateLimitBump) — no parallel mechanism.
//
// DELIBERATELY SEPARATE from RateLimitConfig (the physical-access open/
// quota engine, admin-overridable at runtime via PATCH /v1/admin/limits +
// instance_settings): these auth throttles are a SECURITY control, not a
// product quota, so they are env-only. There is no instance_settings
// override and no admin-UI surface for them — an operator (or an attacker
// who has already talked their way into the admin console) cannot quietly
// turn brute-force protection off at runtime the way opens_per_hour can be
// zeroed. Same counter table, same RATE_* naming convention, different
// (smaller, fixed) blast radius by design.
//
// TWO DIFFERENT SHAPES OF LIMIT, ON PURPOSE (see auth.go's handleLogin):
//   - Per-IP (CheckAuthRateLimit, atomic increment-then-check, EVERY
//     attempt whether it succeeds or fails): the HARD limit. This is what
//     actually stops a single-source brute-force script, and it costs the
//     attacker's own IP budget, never a victim's.
//   - Per-ACCOUNT (AuthAttemptsOverCap + RecordAuthFailure, read-then-
//     conditionally-record, FAILURES ONLY): the SOFT limit. A distributed
//     attacker spread across many IPs can't be stopped by the per-IP limit
//     alone, so guessing against one KNOWN victim email still needs a
//     cap — but any per-account cap is also a lever an attacker could use
//     to lock a VICTIM out on purpose by deliberately failing their login
//     from elsewhere. Two properties keep that cheap: it only ever counts
//     FAILURES (a legitimate correct-password login never adds to it), and
//     it is a single fixed AuthWindowS window that expires on its own —
//     continuing to hammer it does not extend or compound the lockout, so
//     the worst a malicious flood can cost a victim is one bounded (5
//     minute, by default) window of friction, never an indefinite lock.
//
// FAILURE MODE — the opposite choice from openpath.go's physical-access
// limiter, and deliberately so: a counter-store error here FAILS CLOSED
// (denies the attempt, 503) rather than failing open. openpath.go's
// documented, reviewed policy is "a gate is physical access — availability
// wins" (accepted upstream 2026-07-17); that reasoning does not transfer
// here. A brute-force gate that silently disables itself on a SQLite
// hiccup is a worse outcome than a login endpoint that is briefly
// unavailable — availability is not the value at stake on this path,
// credential-guessing resistance is.

import (
	"context"
	"database/sql"
)

// AuthWindowS is the fixed window every auth throttle in this file uses.
// Not configurable per-limit (unlike RateLimitConfig's cooldown/hour/day
// mix) — one window keeps the "bounded, self-expiring, never compounds"
// property in the per-account soft-lockout doc comment above simple to
// reason about.
const AuthWindowS int64 = 5 * MinuteS

// AuthRateLimitConfig bounds the credential endpoints. See this file's
// package doc comment for the full design.
type AuthRateLimitConfig struct {
	LoginIPPerWindow      int64 // POST /v1/auth/login, per source IP
	LoginAccountPerWindow int64 // POST /v1/auth/login, failures per account (email)
	RegisterIPPerWindow   int64 // POST /v1/auth/register, per source IP
	RefreshIPPerWindow    int64 // POST /v1/auth/refresh, per source IP
	ClaimIPPerWindow      int64 // POST /v1/admin/claim, per source IP
}

// AuthRateLimitDefaults are the built-in values, generous enough not to
// trip on normal shared-NAT/office traffic while still bounding an
// automated brute-force script to a low, fixed request rate.
var AuthRateLimitDefaults = AuthRateLimitConfig{
	LoginIPPerWindow:      20,
	LoginAccountPerWindow: 10,
	RegisterIPPerWindow:   10,
	RefreshIPPerWindow:    30,
	ClaimIPPerWindow:      10,
}

// ParseAuthRateLimitConfig builds the config from a lookup func (os.Getenv
// in production, a map in tests) — same RATE_* convention and the same
// ParseRateLimitValue parser (non-negative integers; garbage/missing falls
// back to the default) the physical-access limiter uses.
func ParseAuthRateLimitConfig(getenv func(string) string) AuthRateLimitConfig {
	d := AuthRateLimitDefaults
	return AuthRateLimitConfig{
		LoginIPPerWindow:      ParseRateLimitValue(getenv("RATE_LOGIN_IP_PER_5MIN"), d.LoginIPPerWindow),
		LoginAccountPerWindow: ParseRateLimitValue(getenv("RATE_LOGIN_ACCOUNT_PER_5MIN"), d.LoginAccountPerWindow),
		RegisterIPPerWindow:   ParseRateLimitValue(getenv("RATE_REGISTER_IP_PER_5MIN"), d.RegisterIPPerWindow),
		RefreshIPPerWindow:    ParseRateLimitValue(getenv("RATE_REFRESH_IP_PER_5MIN"), d.RefreshIPPerWindow),
		ClaimIPPerWindow:      ParseRateLimitValue(getenv("RATE_ADMIN_CLAIM_IP_PER_5MIN"), d.ClaimIPPerWindow),
	}
}

// CheckAuthRateLimit atomically consumes one unit of a fixed-window counter
// (scope, subject) capped at limit within AuthWindowS — the HARD, per-IP
// shape: every call counts, success or failure. limit <= 0 blocks
// everything (the same kill-switch convention rateLimitTryBump already
// uses elsewhere in this package).
func (s *Store) CheckAuthRateLimit(ctx context.Context, scope, subject string, limit, nowUnix int64) (allowed bool, retryAfterS int64, err error) {
	ws := FixedWindowStart(nowUnix, AuthWindowS)
	cap := limit
	ok, err := s.rateLimitTryBump(ctx, scope, subject, ws, &cap)
	if err != nil {
		return false, 0, err
	}
	if ok {
		return true, 0, nil
	}
	return false, SecondsUntilWindowEnd(nowUnix, AuthWindowS), nil
}

// AuthAttemptsOverCap reports whether subject already has >= limit recorded
// failures in the CURRENT AuthWindowS window — read-only, does not consume.
// Callers check this BEFORE doing the expensive/sensitive work (an Argon2id
// verify) and only call RecordAuthFailure AFTER learning the attempt
// actually failed — see this file's doc comment for why only failures
// count. limit <= 0 is the same kill-switch convention as everywhere else.
func (s *Store) AuthAttemptsOverCap(ctx context.Context, scope, subject string, limit, nowUnix int64) (over bool, retryAfterS int64, err error) {
	if limit <= 0 {
		return true, SecondsUntilWindowEnd(nowUnix, AuthWindowS), nil
	}
	ws := FixedWindowStart(nowUnix, AuthWindowS)
	var count int64
	err = s.db.QueryRowContext(ctx,
		`SELECT count FROM rate_limit_counters WHERE scope = ? AND subject = ? AND window_start = ?`,
		scope, subject, ws).Scan(&count)
	if err == sql.ErrNoRows {
		return false, 0, nil
	}
	if err != nil {
		return false, 0, err
	}
	if count >= limit {
		return true, SecondsUntilWindowEnd(nowUnix, AuthWindowS), nil
	}
	return false, 0, nil
}

// RecordAuthFailure increments subject's failure counter for the CURRENT
// AuthWindowS window. Best-effort consume with no cap check of its own —
// the cap is enforced by AuthAttemptsOverCap on the NEXT request, exactly
// like every other counter in this package: a denial becomes visible on
// the following attempt, not retroactively on this one.
func (s *Store) RecordAuthFailure(ctx context.Context, scope, subject string, nowUnix int64) error {
	ws := FixedWindowStart(nowUnix, AuthWindowS)
	return s.rateLimitBump(ctx, scope, subject, ws, 1)
}
