package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vul-os/whatsacc/gateway/internal/keys"
	"github.com/vul-os/whatsacc/gateway/internal/store"
)

func newTestServer(t *testing.T, claimToken string) http.Handler {
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
	}, st, ks, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	return s.Router()
}

func doJSON(t *testing.T, h http.Handler, method, path, bearer string, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	} else {
		rd = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rd)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	out := map[string]any{}
	if rec.Body.Len() > 0 && strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
	}
	return rec, out
}

func register(t *testing.T, h http.Handler, email string) (access, refresh string) {
	t.Helper()
	rec, out := doJSON(t, h, "POST", "/v1/auth/register", "", map[string]any{
		"email": email, "password": "hunter2hunter2", "display_name": "T", "location_name": "Test House",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("register %s: %d %s", email, rec.Code, rec.Body)
	}
	tok := out["tokens"].(map[string]any)
	return tok["access_token"].(string), tok["refresh_token"].(string)
}

func TestHealth(t *testing.T) {
	h := newTestServer(t, "")
	rec, out := doJSON(t, h, "GET", "/health", "", nil)
	// Shape parity with backend/src/app.ts so the Tauri picker
	// (src/lib/gateway.ts testGatewayUrl) accepts it: {ok, env, db_now}.
	if rec.Code != 200 || out["ok"] != true || out["version"] != "test" {
		t.Errorf("health: %d %v", rec.Code, out)
	}
	if out["env"] == nil || out["env"] == "" {
		t.Errorf("health missing env: %v", out)
	}
	if _, ok := out["db_now"].(float64); !ok {
		t.Errorf("health missing db_now: %v", out)
	}
}

func TestGatewayKeyEndpoint(t *testing.T) {
	h := newTestServer(t, "")
	rec, out := doJSON(t, h, "GET", "/v1/gateway/key", "", nil)
	if rec.Code != 200 || out["alg"] != "ed25519" || out["public_key"] == "" {
		t.Errorf("gateway key: %d %v", rec.Code, out)
	}
}

func TestPortalPlaceholderServed(t *testing.T) {
	h := newTestServer(t, "")
	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	// Build-agnostic: the default build serves the static/ placeholder, the
	// -tags portal build serves dist/index.html — both contain "whatsacc".
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "whatsacc") {
		t.Errorf("portal root: %d", rec.Code)
	}
}

func TestRegisterLoginMe(t *testing.T) {
	h := newTestServer(t, "")
	access, _ := register(t, h, "a@x.com")

	// duplicate email
	rec, out := doJSON(t, h, "POST", "/v1/auth/register", "", map[string]any{
		"email": "a@x.com", "password": "hunter2hunter2", "location_name": "L",
	})
	if rec.Code != http.StatusConflict || out["error"] != "email_taken" {
		t.Errorf("dup register: %d %v", rec.Code, out)
	}

	// login wrong password
	rec, out = doJSON(t, h, "POST", "/v1/auth/login", "", map[string]any{"email": "a@x.com", "password": "wrong-password"})
	if rec.Code != http.StatusUnauthorized || out["error"] != "invalid_credentials" {
		t.Errorf("bad login: %d %v", rec.Code, out)
	}
	// login unknown user — same error, no enumeration
	rec, out = doJSON(t, h, "POST", "/v1/auth/login", "", map[string]any{"email": "z@x.com", "password": "whatever123"})
	if rec.Code != http.StatusUnauthorized || out["error"] != "invalid_credentials" {
		t.Errorf("unknown login: %d %v", rec.Code, out)
	}
	// login right password
	rec, out = doJSON(t, h, "POST", "/v1/auth/login", "", map[string]any{"email": "a@x.com", "password": "hunter2hunter2"})
	if rec.Code != 200 {
		t.Fatalf("login: %d %s", rec.Code, rec.Body)
	}

	// /me with the register token
	rec, out = doJSON(t, h, "GET", "/v1/auth/me", access, nil)
	if rec.Code != 200 {
		t.Fatalf("me: %d %s", rec.Code, rec.Body)
	}
	accounts := out["accounts"].([]any)
	if len(accounts) != 1 || accounts[0].(map[string]any)["role"] != "owner" {
		t.Errorf("me accounts: %v", accounts)
	}

	// /me unauthenticated + garbage token
	rec, _ = doJSON(t, h, "GET", "/v1/auth/me", "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("me no token: %d", rec.Code)
	}
	rec, _ = doJSON(t, h, "GET", "/v1/auth/me", "not.a.jwt", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("me bad token: %d", rec.Code)
	}
}

func TestRefreshRotationAndReuseDetection(t *testing.T) {
	h := newTestServer(t, "")
	_, refresh := register(t, h, "r@x.com")

	// rotate once
	rec, out := doJSON(t, h, "POST", "/v1/auth/refresh", "", map[string]any{"refresh_token": refresh})
	if rec.Code != 200 {
		t.Fatalf("refresh: %d %s", rec.Code, rec.Body)
	}
	newRefresh := out["tokens"].(map[string]any)["refresh_token"].(string)
	if newRefresh == refresh {
		t.Fatal("refresh token not rotated")
	}

	// replaying the OLD token = reuse → family revoked
	rec, out = doJSON(t, h, "POST", "/v1/auth/refresh", "", map[string]any{"refresh_token": refresh})
	if rec.Code != http.StatusUnauthorized || out["error"] != "refresh_token_reused" {
		t.Errorf("reuse: %d %v", rec.Code, out)
	}
	// ...which kills the NEW token too
	rec, _ = doJSON(t, h, "POST", "/v1/auth/refresh", "", map[string]any{"refresh_token": newRefresh})
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("family survivor: %d", rec.Code)
	}
}

func TestLogoutRevokesFamily(t *testing.T) {
	h := newTestServer(t, "")
	_, refresh := register(t, h, "l@x.com")
	rec, _ := doJSON(t, h, "POST", "/v1/auth/logout", "", map[string]any{"refresh_token": refresh})
	if rec.Code != 200 {
		t.Fatalf("logout: %d", rec.Code)
	}
	rec, _ = doJSON(t, h, "POST", "/v1/auth/refresh", "", map[string]any{"refresh_token": refresh})
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("refresh after logout: %d", rec.Code)
	}
}

func TestAdminClaimFlow(t *testing.T) {
	h := newTestServer(t, "s3cret-claim-token")
	accessA, _ := register(t, h, "first@x.com")
	accessB, _ := register(t, h, "second@x.com")

	// claim state before: claimable
	rec, out := doJSON(t, h, "GET", "/v1/admin/claim", accessA, nil)
	if rec.Code != 200 || out["claimed"] != false || out["claimable"] != true {
		t.Errorf("pre state: %d %v", rec.Code, out)
	}

	// wrong token → 403 invalid_claim_token, not burned
	rec, out = doJSON(t, h, "POST", "/v1/admin/claim", accessA, map[string]any{"token": "wrong"})
	if rec.Code != http.StatusForbidden || out["error"] != "invalid_claim_token" {
		t.Errorf("wrong token: %d %v", rec.Code, out)
	}

	// unauthenticated → 401
	rec, _ = doJSON(t, h, "POST", "/v1/admin/claim", "", map[string]any{"token": "s3cret-claim-token"})
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("anon claim: %d", rec.Code)
	}

	// right token → wins once
	rec, out = doJSON(t, h, "POST", "/v1/admin/claim", accessA, map[string]any{"token": "s3cret-claim-token"})
	if rec.Code != 200 || out["ok"] != true || out["is_platform_admin"] != true {
		t.Fatalf("claim: %d %v", rec.Code, out)
	}

	// second claim, even with the right token → burned
	rec, out = doJSON(t, h, "POST", "/v1/admin/claim", accessB, map[string]any{"token": "s3cret-claim-token"})
	if rec.Code != http.StatusForbidden || out["error"] != "claim_closed" {
		t.Errorf("post-burn claim: %d %v", rec.Code, out)
	}
	rec, out = doJSON(t, h, "GET", "/v1/admin/claim", accessB, nil)
	if out["claimed"] != true || out["claimable"] != false {
		t.Errorf("post state: %v", out)
	}
}

func TestAdminClaimFailClosedWhenUnconfigured(t *testing.T) {
	h := newTestServer(t, "") // no token configured
	access, _ := register(t, h, "u@x.com")
	rec, out := doJSON(t, h, "POST", "/v1/admin/claim", access, map[string]any{"token": ""})
	if rec.Code != http.StatusForbidden || out["error"] != "claim_disabled" {
		t.Errorf("unconfigured claim must fail closed: %d %v", rec.Code, out)
	}
	rec, out = doJSON(t, h, "GET", "/v1/admin/claim", access, nil)
	if out["claimable"] != false {
		t.Errorf("claimable should be false with no token: %v", out)
	}
}

func TestPasswordHashVerify(t *testing.T) {
	h1, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h1, "$argon2id$") {
		t.Errorf("not PHC argon2id: %s", h1)
	}
	if !VerifyPassword("correct horse battery staple", h1) {
		t.Error("right password rejected")
	}
	if VerifyPassword("wrong", h1) {
		t.Error("wrong password accepted")
	}
	// unique salts
	h2, _ := HashPassword("correct horse battery staple")
	if h1 == h2 {
		t.Error("salt reuse")
	}
	// garbage hashes never verify
	for _, bad := range []string{"", "$argon2id$", "plaintext", "$argon2i$v=19$m=1,t=1,p=1$AA$AA"} {
		if VerifyPassword("x", bad) {
			t.Errorf("garbage hash verified: %q", bad)
		}
	}
}

func TestJWTIssueVerifyExpiry(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	tok, err := SignJWT(secret, "user-1", "u@x.com", true, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	c, err := VerifyJWT(secret, tok)
	if err != nil || c.Sub != "user-1" || c.Email != "u@x.com" || !c.IsAdmin {
		t.Fatalf("verify: %v %+v", err, c)
	}

	// expired
	old, _ := SignJWT(secret, "user-1", "", false, -time.Minute)
	if _, err := VerifyJWT(secret, old); !errors.Is(err, ErrTokenExpired) {
		t.Errorf("expired: want ErrTokenExpired, got %v", err)
	}

	// wrong secret
	if _, err := VerifyJWT([]byte("another-secret-another-secret-00"), tok); !errors.Is(err, ErrTokenInvalid) {
		t.Errorf("wrong secret: %v", err)
	}

	// tampered payload
	parts := strings.Split(tok, ".")
	tampered := parts[0] + "." + parts[1][:len(parts[1])-2] + "AA" + "." + parts[2]
	if _, err := VerifyJWT(secret, tampered); err == nil {
		t.Error("tampered token verified")
	}

	// alg confusion: swapped header rejected outright
	noneHdr := "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0" // {"alg":"none","typ":"JWT"}
	if _, err := VerifyJWT(secret, noneHdr+"."+parts[1]+"."); !errors.Is(err, ErrTokenInvalid) {
		t.Errorf("alg none: %v", err)
	}
}
