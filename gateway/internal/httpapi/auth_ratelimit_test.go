package httpapi

import (
	"bytes"
	"log/slog"
	"net/http"
	"testing"

	"github.com/vul-os/lintel/gateway/internal/keys"
	"github.com/vul-os/lintel/gateway/internal/store"
)

// newAuthLimitTestServer is newTestServer but with caller-controlled
// AuthRateLimitConfig — the shared newTestServer helper always gets
// store.AuthRateLimitDefaults (via New()'s zero-value fallback), whose
// defaults are deliberately generous enough not to trip existing tests
// (see store/authratelimit.go); these tests need tight caps to be
// exercised in a handful of requests instead of dozens.
func newAuthLimitTestServer(t *testing.T, claimToken string, limits store.AuthRateLimitConfig) http.Handler {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ks, err := keys.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	s := New(Config{
		Version:         "test",
		AdminClaimToken: claimToken,
		JWTSecret:       []byte("0123456789abcdef0123456789abcdef"),
		AuthRateLimits:  limits,
	}, st, ks, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	return s.Router()
}

// TestLoginIPRateLimited is the core "fails before this change" case for
// fix 2: before it, POST /v1/auth/login had NO rate limiting at all — an
// unbounded number of attempts from one source all returned plain 401s,
// never a 429. httptest.NewRequest gives every request in this test the
// same fixed RemoteAddr ("192.0.2.1:..."), so they all land on the same
// per-IP counter subject.
func TestLoginIPRateLimited(t *testing.T) {
	h := newAuthLimitTestServer(t, "", store.AuthRateLimitConfig{
		LoginIPPerWindow: 3, LoginAccountPerWindow: 1000,
		RegisterIPPerWindow: 1000, RefreshIPPerWindow: 1000, ClaimIPPerWindow: 1000,
	})
	access, _ := register(t, h, "iplimit@x.com")
	_ = access

	// The first 3 attempts (all wrong password) consume the per-IP budget
	// and each still behaves like an ordinary failed login.
	for i := 0; i < 3; i++ {
		rec, out := doJSON(t, h, "POST", "/v1/auth/login", "", map[string]any{
			"email": "iplimit@x.com", "password": "wrong",
		})
		if rec.Code != http.StatusUnauthorized || out["error"] != "invalid_credentials" {
			t.Fatalf("attempt %d: want 401 invalid_credentials, got %d %v", i, rec.Code, out)
		}
	}
	// The 4th, from the same IP, must be throttled — even with the RIGHT
	// password: the per-IP limit is the hard one and applies to every
	// attempt, not just failures (see authratelimit.go's doc comment).
	rec, out := doJSON(t, h, "POST", "/v1/auth/login", "", map[string]any{
		"email": "iplimit@x.com", "password": "hunter2hunter2",
	})
	if rec.Code != http.StatusTooManyRequests || out["error"] != "rate_limited" {
		t.Fatalf("4th attempt: want 429 rate_limited, got %d %v", rec.Code, out)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("expected a Retry-After header on the 429")
	}
}

// TestLoginAccountSoftLockoutBlocksFurtherGuessesEvenWithRightPassword
// proves the per-account failure cap: once an account has accumulated
// LoginAccountPerWindow failures within the window, FURTHER attempts
// against that email are blocked — including one with the correct
// password — until the window rolls over. This is what makes password
// guessing against one known account actually bounded, distributed
// attacker or not.
func TestLoginAccountSoftLockoutBlocksFurtherGuessesEvenWithRightPassword(t *testing.T) {
	h := newAuthLimitTestServer(t, "", store.AuthRateLimitConfig{
		LoginIPPerWindow: 1000, LoginAccountPerWindow: 3,
		RegisterIPPerWindow: 1000, RefreshIPPerWindow: 1000, ClaimIPPerWindow: 1000,
	})
	register(t, h, "acctlock@x.com")

	for i := 0; i < 3; i++ {
		rec, out := doJSON(t, h, "POST", "/v1/auth/login", "", map[string]any{
			"email": "acctlock@x.com", "password": "wrong",
		})
		if rec.Code != http.StatusUnauthorized || out["error"] != "invalid_credentials" {
			t.Fatalf("failure %d: want 401, got %d %v", i, rec.Code, out)
		}
	}
	rec, out := doJSON(t, h, "POST", "/v1/auth/login", "", map[string]any{
		"email": "acctlock@x.com", "password": "hunter2hunter2", // correct
	})
	if rec.Code != http.StatusTooManyRequests || out["error"] != "rate_limited" {
		t.Fatalf("post-cap login with the RIGHT password must still be throttled: %d %v", rec.Code, out)
	}
}

// TestLoginSuccessNeverConsumesTheAccountFailureBudget proves the soft cap
// only ever counts FAILURES: a run of successful logins, well past
// LoginAccountPerWindow in count, never trips it.
func TestLoginSuccessNeverConsumesTheAccountFailureBudget(t *testing.T) {
	h := newAuthLimitTestServer(t, "", store.AuthRateLimitConfig{
		LoginIPPerWindow: 1000, LoginAccountPerWindow: 3,
		RegisterIPPerWindow: 1000, RefreshIPPerWindow: 1000, ClaimIPPerWindow: 1000,
	})
	register(t, h, "goodlogin@x.com")

	for i := 0; i < 6; i++ { // 2x the account cap
		rec, _ := doJSON(t, h, "POST", "/v1/auth/login", "", map[string]any{
			"email": "goodlogin@x.com", "password": "hunter2hunter2",
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("successful login %d must never be throttled: %d", i, rec.Code)
		}
	}
}

// TestLoginRateLimitPreservesAntiEnumeration proves the pre-existing
// "unknown email still burns a dummy Argon2id verify" behaviour (auth.go's
// dummyHash) survives the rate-limit changes untouched: an unknown email
// still gets exactly the same 401 invalid_credentials a wrong-password
// known email gets, right up to (and distinctly from) the point the
// throttle itself kicks in.
func TestLoginRateLimitPreservesAntiEnumeration(t *testing.T) {
	h := newAuthLimitTestServer(t, "", store.AuthRateLimitConfig{
		LoginIPPerWindow: 1000, LoginAccountPerWindow: 1000,
		RegisterIPPerWindow: 1000, RefreshIPPerWindow: 1000, ClaimIPPerWindow: 1000,
	})
	rec, out := doJSON(t, h, "POST", "/v1/auth/login", "", map[string]any{
		"email": "never-registered@x.com", "password": "whatever123",
	})
	if rec.Code != http.StatusUnauthorized || out["error"] != "invalid_credentials" {
		t.Errorf("unknown email: %d %v", rec.Code, out)
	}
}

// TestRegisterIPRateLimited: before fix 2, POST /v1/auth/register had no
// throttling either — an account-creation flood was unbounded.
func TestRegisterIPRateLimited(t *testing.T) {
	h := newAuthLimitTestServer(t, "", store.AuthRateLimitConfig{
		LoginIPPerWindow: 1000, LoginAccountPerWindow: 1000,
		RegisterIPPerWindow: 2, RefreshIPPerWindow: 1000, ClaimIPPerWindow: 1000,
	})
	for i := 0; i < 2; i++ {
		rec, out := doJSON(t, h, "POST", "/v1/auth/register", "", map[string]any{
			"email": "reg" + string(rune('a'+i)) + "@x.com", "password": "hunter2hunter2", "location_name": "L",
		})
		if rec.Code != http.StatusCreated {
			t.Fatalf("register %d: %d %v", i, rec.Code, out)
		}
	}
	rec, out := doJSON(t, h, "POST", "/v1/auth/register", "", map[string]any{
		"email": "regz@x.com", "password": "hunter2hunter2", "location_name": "L",
	})
	if rec.Code != http.StatusTooManyRequests || out["error"] != "rate_limited" {
		t.Fatalf("3rd register from the same IP: want 429, got %d %v", rec.Code, out)
	}
}

// TestRefreshIPRateLimited: before fix 2, POST /v1/auth/refresh had no
// throttling either.
func TestRefreshIPRateLimited(t *testing.T) {
	h := newAuthLimitTestServer(t, "", store.AuthRateLimitConfig{
		LoginIPPerWindow: 1000, LoginAccountPerWindow: 1000,
		RegisterIPPerWindow: 1000, RefreshIPPerWindow: 2, ClaimIPPerWindow: 1000,
	})
	for i := 0; i < 2; i++ {
		rec, _ := doJSON(t, h, "POST", "/v1/auth/refresh", "", map[string]any{"refresh_token": "bogus"})
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("refresh %d: want 401 (bad token, not yet throttled), got %d", i, rec.Code)
		}
	}
	rec, out := doJSON(t, h, "POST", "/v1/auth/refresh", "", map[string]any{"refresh_token": "bogus"})
	if rec.Code != http.StatusTooManyRequests || out["error"] != "rate_limited" {
		t.Fatalf("3rd refresh from the same IP: want 429, got %d %v", rec.Code, out)
	}
}

// TestAdminClaimIPRateLimited: before fix 2, POST /v1/admin/claim was
// unthrottled too — the finding's explicit "also cover" case.
func TestAdminClaimIPRateLimited(t *testing.T) {
	h := newAuthLimitTestServer(t, "op-token", store.AuthRateLimitConfig{
		LoginIPPerWindow: 1000, LoginAccountPerWindow: 1000,
		RegisterIPPerWindow: 1000, RefreshIPPerWindow: 1000, ClaimIPPerWindow: 2,
	})
	access, _ := register(t, h, "claimlimit@x.com")
	for i := 0; i < 2; i++ {
		rec, out := doJSON(t, h, "POST", "/v1/admin/claim", access, map[string]any{"token": "wrong"})
		if rec.Code != http.StatusForbidden || out["error"] != "invalid_claim_token" {
			t.Fatalf("claim attempt %d: want 403 invalid_claim_token, got %d %v", i, rec.Code, out)
		}
	}
	rec, out := doJSON(t, h, "POST", "/v1/admin/claim", access, map[string]any{"token": "op-token"})
	if rec.Code != http.StatusTooManyRequests || out["error"] != "rate_limited" {
		t.Fatalf("3rd claim attempt from the same IP: want 429, got %d %v", rec.Code, out)
	}
}
