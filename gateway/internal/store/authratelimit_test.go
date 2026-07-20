package store

import (
	"context"
	"testing"
)

func TestCheckAuthRateLimitCapsAndWindows(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	nowUnix := int64(1_700_000_000) // fixed, so window math is deterministic

	for i := 0; i < 3; i++ {
		ok, retry, err := s.CheckAuthRateLimit(ctx, "test_scope", "ip:1.2.3.4", 3, nowUnix)
		if err != nil || !ok || retry != 0 {
			t.Fatalf("attempt %d should be allowed: ok=%v retry=%d err=%v", i, ok, retry, err)
		}
	}
	ok, retry, err := s.CheckAuthRateLimit(ctx, "test_scope", "ip:1.2.3.4", 3, nowUnix)
	if err != nil || ok {
		t.Fatalf("4th attempt within the cap must be denied: ok=%v err=%v", ok, err)
	}
	if retry < 1 || retry > AuthWindowS {
		t.Errorf("retry-after out of range: %d", retry)
	}

	// A different subject is independent.
	ok, _, err = s.CheckAuthRateLimit(ctx, "test_scope", "ip:5.6.7.8", 3, nowUnix)
	if err != nil || !ok {
		t.Errorf("different subject must not share the budget: ok=%v err=%v", ok, err)
	}

	// After the window rolls over, the original subject is allowed again.
	ok, _, err = s.CheckAuthRateLimit(ctx, "test_scope", "ip:1.2.3.4", 3, nowUnix+AuthWindowS)
	if err != nil || !ok {
		t.Errorf("next window must reset the counter: ok=%v err=%v", ok, err)
	}
}

func TestAuthAttemptsOverCapOnlyCountsRecordedFailures(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	nowUnix := int64(1_700_000_000)

	if over, _, err := s.AuthAttemptsOverCap(ctx, "login_acct", "email:a@x.com", 3, nowUnix); err != nil || over {
		t.Fatalf("fresh subject must not be over cap: over=%v err=%v", over, err)
	}
	for i := 0; i < 2; i++ {
		if err := s.RecordAuthFailure(ctx, "login_acct", "email:a@x.com", nowUnix); err != nil {
			t.Fatal(err)
		}
	}
	// 2 failures recorded, cap 3: still not over.
	if over, _, err := s.AuthAttemptsOverCap(ctx, "login_acct", "email:a@x.com", 3, nowUnix); err != nil || over {
		t.Fatalf("2 failures under cap 3 must not be over: over=%v err=%v", over, err)
	}
	if err := s.RecordAuthFailure(ctx, "login_acct", "email:a@x.com", nowUnix); err != nil {
		t.Fatal(err)
	}
	// 3rd failure trips it.
	over, retry, err := s.AuthAttemptsOverCap(ctx, "login_acct", "email:a@x.com", 3, nowUnix)
	if err != nil || !over {
		t.Fatalf("3 failures at cap 3 must be over: over=%v err=%v", over, err)
	}
	if retry < 1 {
		t.Errorf("retry-after must be positive: %d", retry)
	}

	// A DIFFERENT account is unaffected by the first one's failures.
	if over, _, err := s.AuthAttemptsOverCap(ctx, "login_acct", "email:b@x.com", 3, nowUnix); err != nil || over {
		t.Errorf("unrelated account must not be over cap: over=%v err=%v", over, err)
	}
}

// TestAuthRateLimitFailsClosedOnStoreError proves the deliberate divergence
// from openpath.go's fail-OPEN physical-access policy: with the
// underlying connection gone, both auth-throttle checks return an error
// (which httpapi turns into a 503, denying the attempt) rather than
// silently reporting "allowed" the way GuardedCheckOpenLimits does for the
// physical-access path. See authratelimit.go's package doc comment for why
// that reversal is intentional here.
func TestAuthRateLimitFailsClosedOnStoreError(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	s.Close() // underlying *sql.DB now refuses all further operations

	if _, _, err := s.CheckAuthRateLimit(ctx, "login_ip", "ip:1.2.3.4", 5, 1_700_000_000); err == nil {
		t.Error("CheckAuthRateLimit must return an error (fail closed), not silently allow, once the store is unusable")
	}
	if _, _, err := s.AuthAttemptsOverCap(ctx, "login_acct", "email:a@x.com", 5, 1_700_000_000); err == nil {
		t.Error("AuthAttemptsOverCap must return an error (fail closed) once the store is unusable")
	}
}
