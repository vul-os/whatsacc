package store

// The open-path choke point: the port of backend logAccess()
// (src/routes/access.ts) + checkAndConsumeOpenLimits (src/lib/rate-limit.ts).
// Every open path (portal, API, chat channels) funnels through LogAccess so
// rate limits and quotas cannot be bypassed by picking a different channel.

import (
	"context"
	"fmt"
)

// OpenLimitInput mirrors the backend's OpenLimitInput.
type OpenLimitInput struct {
	UserID        string // authenticated member ("" for visitors)
	PhoneE164     string // opener's phone (chat path)
	AccessPointID string
	LocationID    string
	AccountID     string
	Now           int64 // 0 = wall clock
}

// OpenLimitDecision mirrors the backend's OpenLimitDecision.
type OpenLimitDecision struct {
	Allowed     bool
	Degraded    bool   // counter store failed; enforcement skipped
	Reason      string // rate_limited | quota_exceeded
	RetryAfterS int64
	// Limit names which bound tripped (logs/tests, not user-facing):
	// open_cooldown | member_opens_per_hour | account_opens_per_hour |
	// member_opens_per_day | location_opens_per_day
	Limit string
}

func openSubject(in OpenLimitInput) string {
	if in.UserID != "" {
		return "user:" + in.UserID
	}
	if in.PhoneE164 != "" {
		return "phone:" + in.PhoneE164
	}
	return ""
}

type consumedCounter struct {
	scope, subject string
	windowStart    int64
}

// CheckAndConsumeOpenLimits checks every open limit and, when allowed,
// consumes the counters — increment-then-check, one atomic statement per
// limit, so the bound is EXACT under concurrency. Counters consumed for an
// attempt that a later limit denies are handed back: denials never consume,
// and counters exactly equal successful opens.
//
// Errors propagate — GuardedCheckOpenLimits is the fail-open wrapper.
func (s *Store) CheckAndConsumeOpenLimits(ctx context.Context, envCfg RateLimitConfig, in OpenLimitInput) (OpenLimitDecision, error) {
	cfg := s.ResolveRateLimitConfig(ctx, envCfg)
	nowUnix := in.Now
	if nowUnix == 0 {
		nowUnix = now()
	}
	subject := openSubject(in)
	hourStart := FixedWindowStart(nowUnix, HourS)
	dayStart := FixedWindowStart(nowUnix, DayS)
	acctSubject := "acct:" + in.AccountID
	locSubject := "loc:" + in.LocationID

	// Quota config + admin exemption. Owners/admins are exempt from QUOTAS,
	// never from rate limits; their opens still count.
	quotas, err := s.LocationQuotas(ctx, in.LocationID)
	if err != nil {
		return OpenLimitDecision{}, err
	}
	isAdmin := false
	if in.UserID != "" {
		if role, err := s.MemberRole(ctx, in.AccountID, in.UserID); err == nil {
			isAdmin = role == "owner" || role == "admin"
		}
	}

	var cdSubject string
	if subject != "" {
		cdSubject = subject + "|ap:" + in.AccessPointID
	}

	var consumed []consumedCounter
	handBack := func() {
		for _, c := range consumed {
			_ = s.rateLimitBump(ctx, c.scope, c.subject, c.windowStart, -1)
		}
	}

	// --- Cooldown fast-path (read-only; the atomic claim below is
	// authoritative — this alone would race) ------------------------------
	if cdSubject != "" && cfg.OpenCooldownS > 0 {
		if last, ok, err := s.rateLimitLast(ctx, cdSubject); err != nil {
			return OpenLimitDecision{}, err
		} else if ok {
			if rem := CooldownRemainingS(last, nowUnix, cfg.OpenCooldownS); rem > 0 {
				return OpenLimitDecision{Reason: "rate_limited", RetryAfterS: rem, Limit: "open_cooldown"}, nil
			}
		}
	}

	// --- Rate limits (everyone, admins included) -------------------------
	if subject != "" {
		ok, err := s.rateLimitTryBump(ctx, "opens_1h", subject, hourStart, &cfg.OpensPerHour)
		if err != nil {
			return OpenLimitDecision{}, err
		}
		if !ok {
			handBack()
			return OpenLimitDecision{Reason: "rate_limited",
				RetryAfterS: SecondsUntilWindowEnd(nowUnix, HourS), Limit: "member_opens_per_hour"}, nil
		}
		consumed = append(consumed, consumedCounter{"opens_1h", subject, hourStart})
	}

	ok, err := s.rateLimitTryBump(ctx, "acct_opens_1h", acctSubject, hourStart, &cfg.AccountOpensPerHour)
	if err != nil {
		handBack()
		return OpenLimitDecision{}, err
	}
	if !ok {
		handBack()
		return OpenLimitDecision{Reason: "rate_limited",
			RetryAfterS: SecondsUntilWindowEnd(nowUnix, HourS), Limit: "account_opens_per_hour"}, nil
	}
	consumed = append(consumed, consumedCounter{"acct_opens_1h", acctSubject, hourStart})

	// --- Quotas (admin policy; owners/admins exempt but still counted) ---
	if subject != "" {
		mdSubject := subject + "|loc:" + in.LocationID
		var memberCap *int64
		if !isAdmin && quotas.MaxOpensPerMemberPerDay != nil {
			memberCap = quotas.MaxOpensPerMemberPerDay
		}
		ok, err := s.rateLimitTryBump(ctx, "opens_1d", mdSubject, dayStart, memberCap)
		if err != nil {
			handBack()
			return OpenLimitDecision{}, err
		}
		if !ok {
			handBack()
			return OpenLimitDecision{Reason: "quota_exceeded",
				RetryAfterS: SecondsUntilWindowEnd(nowUnix, DayS), Limit: "member_opens_per_day"}, nil
		}
		consumed = append(consumed, consumedCounter{"opens_1d", mdSubject, dayStart})
	}

	var locCap *int64
	if !isAdmin && quotas.MaxOpensPerLocationPerDay != nil {
		locCap = quotas.MaxOpensPerLocationPerDay
	}
	ok, err = s.rateLimitTryBump(ctx, "loc_opens_1d", locSubject, dayStart, locCap)
	if err != nil {
		handBack()
		return OpenLimitDecision{}, err
	}
	if !ok {
		handBack()
		return OpenLimitDecision{Reason: "quota_exceeded",
			RetryAfterS: SecondsUntilWindowEnd(nowUnix, DayS), Limit: "location_opens_per_day"}, nil
	}
	consumed = append(consumed, consumedCounter{"loc_opens_1d", locSubject, dayStart})

	// --- Cooldown claim (authoritative, atomic; LAST so a denied attempt
	// never restarts anyone's cooldown) -----------------------------------
	if cdSubject != "" {
		claimed, err := s.rateLimitClaimCooldown(ctx, cdSubject, nowUnix, cfg.OpenCooldownS)
		if err != nil {
			handBack()
			return OpenLimitDecision{}, err
		}
		if !claimed {
			handBack()
			rem := cfg.OpenCooldownS
			if last, ok, _ := s.rateLimitLast(ctx, cdSubject); ok {
				rem = CooldownRemainingS(last, nowUnix, cfg.OpenCooldownS)
			}
			if rem < 1 {
				rem = 1
			}
			return OpenLimitDecision{Reason: "rate_limited", RetryAfterS: rem, Limit: "open_cooldown"}, nil
		}
	}

	return OpenLimitDecision{Allowed: true}, nil
}

// GuardedCheckOpenLimits is the fail-open wrapper: a counter-store error
// ALLOWS the open, flagged degraded so the audit row records
// error='rate_limit_check_failed'. A gate is physical access — availability
// wins for enforcement, visibility is preserved. (Fail-open reviewed
// upstream 2026-07-17: accepted.)
func (s *Store) GuardedCheckOpenLimits(ctx context.Context, envCfg RateLimitConfig, in OpenLimitInput) OpenLimitDecision {
	d, err := s.CheckAndConsumeOpenLimits(ctx, envCfg, in)
	if err != nil {
		return OpenLimitDecision{Allowed: true, Degraded: true}
	}
	return d
}

// ---------------------------------------------------------------------------
// LogAccess — the single choke point
// ---------------------------------------------------------------------------

// LogAccessArgs mirrors backend logAccess args.
type LogAccessArgs struct {
	UserID        string // "" for visitor-grant opens
	PhoneE164     string // rate-limit subject for visitors
	AccessPointID string
	Command       string // "open" | "close"
	Source        string // web | whatsapp | api | ...
	Lat, Long     *float64
}

// LogAccessResult is the verdict. Every attempt — allowed or denied — leaves
// an access_logs row (LogID); on denial Reason is one of the backend's exact
// vocabulary: rate_limited | quota_exceeded | account_suspended |
// user_disabled.
type LogAccessResult struct {
	Allowed     bool
	Reason      string
	RetryAfterS int64
	Limit       string // which bound tripped, when Reason is a limit denial
	LogID       string
	AP          *AccessPointContext
}

// LogAccess runs the full verdict + audit for one gate command:
// access-point resolution, account-suspension check, live user-status check,
// rate limits + quotas (open only — 'close' is the safe direction and is
// never limited), then the audit row. Denials are audit-logged with
// success=0 and error=reason; the caller translates the verdict per channel
// (429 + Retry-After over HTTP, honest chat replies on channels).
//
// The caller is responsible for the MEMBERSHIP gate (portal/API paths 404
// non-members before calling; chat channels resolve members/grants by phone
// first) — exactly the backend's split between RLS-at-route and logAccess.
func (s *Store) LogAccess(ctx context.Context, envCfg RateLimitConfig, args LogAccessArgs) (*LogAccessResult, error) {
	if args.Command != "open" && args.Command != "close" {
		return nil, fmt.Errorf("bad command %q", args.Command)
	}
	ap, err := s.AccessPointContextByID(ctx, args.AccessPointID)
	if err != nil {
		return nil, err // ErrNotFound → handler 404s (access_point_not_found)
	}

	deny := func(reason string, retryAfterS int64, limit string) (*LogAccessResult, error) {
		logID, err := s.InsertAccessLog(ctx, AccessLog{
			AccessPointID: ap.ID, LocationID: ap.LocationID, AccountID: ap.AccountID,
			UserID: args.UserID, Command: args.Command, Source: args.Source,
			Lat: args.Lat, Long: args.Long, Success: false, Error: reason,
		})
		if err != nil {
			return nil, err
		}
		return &LogAccessResult{Reason: reason, RetryAfterS: retryAfterS, Limit: limit, LogID: logID, AP: ap}, nil
	}

	// Suspended account: every open denied, regardless of channel,
	// membership or grants. 'close' stays allowed (safe direction).
	if args.Command == "open" && ap.AccountStatus == "suspended" {
		return deny("account_suspended", 0, "")
	}

	// Disabled user: chat paths resolve members without a JWT, so the choke
	// point must check users.status itself. Fail-closed: a missing users row
	// or any non-active status denies. Visitor grants (UserID=="") unaffected.
	if args.Command == "open" && args.UserID != "" {
		u, err := s.UserByID(ctx, args.UserID)
		if err != nil || u.Status != "active" {
			if err != nil {
				// No users row at all: still deny + audit, but the audit row
				// carries user_id NULL (the FK cannot reference a ghost).
				args.UserID = ""
			}
			return deny("user_disabled", 0, "")
		}
	}

	degradedNote := ""
	if args.Command == "open" {
		decision := s.GuardedCheckOpenLimits(ctx, envCfg, OpenLimitInput{
			UserID: args.UserID, PhoneE164: args.PhoneE164,
			AccessPointID: ap.ID, LocationID: ap.LocationID, AccountID: ap.AccountID,
		})
		if !decision.Allowed {
			return deny(decision.Reason, decision.RetryAfterS, decision.Limit)
		}
		if decision.Degraded {
			degradedNote = "rate_limit_check_failed"
		}
	}

	logID, err := s.InsertAccessLog(ctx, AccessLog{
		AccessPointID: ap.ID, LocationID: ap.LocationID, AccountID: ap.AccountID,
		UserID: args.UserID, Command: args.Command, Source: args.Source,
		Lat: args.Lat, Long: args.Long, Success: true, Error: degradedNote,
	})
	if err != nil {
		return nil, err
	}
	return &LogAccessResult{Allowed: true, LogID: logID, AP: ap}, nil
}

// VisitorOpenWithGrant is the chat-channel visitor path (whatsapp.ts
// semantics): atomically consume one grant use for (phone, access point),
// run the choke-point verdict, and REFUND the use when the verdict denies —
// a visitor never loses a use on a denied attempt. grantID == "" means no
// usable grant existed (result nil in that case).
func (s *Store) VisitorOpenWithGrant(ctx context.Context, envCfg RateLimitConfig, phoneE164, accessPointID, source string) (*LogAccessResult, string, error) {
	grantID, err := s.TryConsumeGrant(ctx, phoneE164, accessPointID, 0)
	if err != nil {
		return nil, "", err
	}
	if grantID == "" {
		return nil, "", nil
	}
	res, err := s.LogAccess(ctx, envCfg, LogAccessArgs{
		PhoneE164: phoneE164, AccessPointID: accessPointID, Command: "open", Source: source,
	})
	if err != nil {
		_ = s.RefundGrantUse(ctx, grantID)
		return nil, grantID, err
	}
	if !res.Allowed {
		if err := s.RefundGrantUse(ctx, grantID); err != nil {
			return res, grantID, err
		}
	}
	return res, grantID, nil
}

// ---------------------------------------------------------------------------
// Late cmd.ack reconciliation (proto/commands.md "The lost-ack case,
// specified honestly" — v1 fix for the stated v0 gap)
// ---------------------------------------------------------------------------

// ReconcileLateAck appends a NEW access_logs row recording a late-but-valid
// cmd.ack for a dispatch whose row was already written (typically tagged
// 'undelivered' by UpdateAccessLogError once the ack-wait deadline passed,
// but this also covers a dispatch that was never tagged at all). The
// original row is left completely untouched — append-only discipline: "we
// didn't hear back by the deadline" stays true forever, exactly as it was
// recorded at the time. The new row is what makes "we heard back late, and
// here is what it said" a visible, equally durable fact instead of being
// silently collapsed into the first one.
//
// Caller contract: result/detail/ackTS come from an ack that MUST already
// be fully verified — signature against the enrolled device key, and nonce
// ownership + recency against the specific dispatch it claims to answer
// (see hub.LateAckReconcile, which enforces both before this is ever
// called). This method trusts its inputs; it performs no verification of
// its own and must never be reachable from an unauthenticated path.
func (s *Store) ReconcileLateAck(ctx context.Context, originalLogID, result, detail string, ackTS int64) (string, error) {
	var l AccessLog
	err := s.db.QueryRowContext(ctx,
		`SELECT coalesce(access_point_id,''), coalesce(location_id,''), coalesce(account_id,''),
		        coalesce(user_id,''), coalesce(command,''), coalesce(source,'')
		 FROM access_logs WHERE id = ?`, originalLogID).
		Scan(&l.AccessPointID, &l.LocationID, &l.AccountID, &l.UserID, &l.Command, &l.Source)
	if err != nil {
		return "", err // ErrNotFound: the original row is gone (should not happen)
	}
	tag := "late_ack:" + result
	if detail != "" {
		tag += ":" + detail
	}
	// The controller's own signed word on what actually happened: only
	// opened/held/closed mean the gate did the thing; denied/error did not.
	l.Success = result == "opened" || result == "held" || result == "closed"
	l.Error = tag
	l.TS = ackTS
	l.ReconcilesLogID = originalLogID
	return s.InsertAccessLog(ctx, l)
}
