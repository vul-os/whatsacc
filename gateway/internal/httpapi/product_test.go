package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vul-os/whatsacc/gateway/internal/keys"
	"github.com/vul-os/whatsacc/gateway/internal/store"
)

// newTestServerWithStore is newTestServer but hands back the store too, for
// tests that need the admin handle (invite token recovery, direct checks).
func newTestServerWithStore(t *testing.T, claimToken string) (http.Handler, *store.Store) {
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
	return s.Router(), st
}

// tenantIDs pulls the caller's (account, location) from /v1/auth/me + list.
func tenantIDs(t *testing.T, h http.Handler, access string) (accountID, locationID string) {
	t.Helper()
	_, out := doJSON(t, h, "GET", "/v1/auth/me", access, nil)
	accountID = out["accounts"].([]any)[0].(map[string]any)["id"].(string)
	_, out = doJSON(t, h, "GET", "/v1/accounts/"+accountID+"/locations", access, nil)
	locs := out["locations"].([]any)
	if len(locs) == 0 {
		t.Fatal("no anchor location")
	}
	return accountID, locs[0].(map[string]any)["id"].(string)
}

func TestAccountsCRUDAndTenancy(t *testing.T) {
	h := newTestServer(t, "")
	accessA, _ := register(t, h, "a@acc.com")
	accessB, _ := register(t, h, "b@acc.com")
	acctA, _ := tenantIDs(t, h, accessA)

	// list shows own account with role
	rec, out := doJSON(t, h, "GET", "/v1/accounts", accessA, nil)
	if rec.Code != 200 || len(out["accounts"].([]any)) != 1 {
		t.Fatalf("list: %d %v", rec.Code, out)
	}

	// cross-tenant reads are 404 — indistinguishable from missing
	for _, probe := range []struct{ method, path string }{
		{"GET", "/v1/accounts/" + acctA},
		{"PATCH", "/v1/accounts/" + acctA},
		{"GET", "/v1/accounts/" + acctA + "/members"},
		{"GET", "/v1/accounts/" + acctA + "/locations"},
	} {
		var body any
		if probe.method == "PATCH" {
			body = map[string]any{"name": "steal"}
		}
		rec, out := doJSON(t, h, probe.method, probe.path, accessB, body)
		if rec.Code != http.StatusNotFound {
			t.Errorf("cross-tenant %s %s: %d %v", probe.method, probe.path, rec.Code, out)
		}
	}

	// own rename works, then reflected
	rec, _ = doJSON(t, h, "PATCH", "/v1/accounts/"+acctA, accessA, map[string]any{"name": "Renamed"})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("rename: %d", rec.Code)
	}
	_, out = doJSON(t, h, "GET", "/v1/accounts/"+acctA, accessA, nil)
	if out["name"] != "Renamed" {
		t.Errorf("rename not applied: %v", out)
	}

	// create a second account
	rec, out = doJSON(t, h, "POST", "/v1/accounts", accessA, map[string]any{"name": "Second"})
	if rec.Code != http.StatusCreated || out["id"] == "" {
		t.Errorf("create: %d %v", rec.Code, out)
	}
}

// inviteAndRecoverToken creates an invite as `access` and force-sets a known
// token via the store handle (delivery is not wired; backend tests do the
// same by overwriting token_hash).
func inviteAndRecoverToken(t *testing.T, h http.Handler, st *store.Store, access, accountID, email, role, phone string) string {
	t.Helper()
	rec, out := doJSON(t, h, "POST", "/v1/accounts/"+accountID+"/invites", access, map[string]any{
		"email": email, "role": role, "phone_e164": phone,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("invite create: %d %s", rec.Code, rec.Body)
	}
	// SECURITY: create response must never leak the accept token.
	raw := rec.Body.String()
	if strings.Contains(raw, "token") || strings.Contains(raw, "accept_url") {
		t.Fatalf("invite create leaks token material: %s", raw)
	}
	tokenPlain := "test-recovered-token-" + email
	if err := st.SetInviteTokenHash(t.Context(), out["id"].(string), hashToken(tokenPlain)); err != nil {
		t.Fatal(err)
	}
	return tokenPlain
}

func TestInviteFlow(t *testing.T) {
	h, st := newTestServerWithStore(t, "")
	accessA, _ := register(t, h, "owner@inv.com")
	accessC, _ := register(t, h, "cleaner@inv.com")
	acctA, locA := tenantIDs(t, h, accessA)

	// invitee (plain member elsewhere) cannot create invites on A's account
	rec, _ := doJSON(t, h, "POST", "/v1/accounts/"+acctA+"/invites", accessC, map[string]any{
		"email": "x@inv.com", "phone_e164": "+27821234567",
	})
	if rec.Code != http.StatusNotFound {
		t.Errorf("non-member invite create: %d", rec.Code)
	}

	token := inviteAndRecoverToken(t, h, st, accessA, acctA, "cleaner@inv.com", "member", "+27821234567")

	// email mismatch: another logged-in user cannot burn the invite
	accessX, _ := register(t, h, "x@inv.com")
	rec, out := doJSON(t, h, "POST", "/v1/accounts/invites/"+token+"/accept", accessX, map[string]any{})
	if rec.Code != http.StatusBadRequest || out["error"] != "invite_email_mismatch" {
		t.Errorf("email mismatch: %d %v", rec.Code, out)
	}

	// right user accepts; phone never auto-verified
	rec, out = doJSON(t, h, "POST", "/v1/accounts/invites/"+token+"/accept", accessC, map[string]any{})
	if rec.Code != 200 || out["account_id"] != acctA || out["role"] != "member" {
		t.Fatalf("accept: %d %v", rec.Code, out)
	}
	if out["phone_verification_required"] != true {
		t.Error("phone must require verification after accept")
	}

	// invite is single-use
	rec, out = doJSON(t, h, "POST", "/v1/accounts/invites/"+token+"/accept", accessC, map[string]any{})
	if rec.Code != http.StatusBadRequest || out["error"] != "invite_used" {
		t.Errorf("reuse: %d %v", rec.Code, out)
	}

	// member can now read the account, see the roster, and the location
	rec, out = doJSON(t, h, "GET", "/v1/accounts/"+acctA+"/members", accessC, nil)
	if rec.Code != 200 || len(out["members"].([]any)) != 2 {
		t.Errorf("roster after accept: %d %v", rec.Code, out)
	}
	rec, _ = doJSON(t, h, "GET", "/v1/locations/"+locA, accessC, nil)
	if rec.Code != 200 {
		t.Errorf("member location read: %d", rec.Code)
	}

	// ...but member role cannot do admin things
	rec, _ = doJSON(t, h, "PATCH", "/v1/accounts/"+acctA, accessC, map[string]any{"name": "nope"})
	if rec.Code != http.StatusForbidden {
		t.Errorf("member rename: %d", rec.Code)
	}
	rec, _ = doJSON(t, h, "POST", "/v1/accounts/"+acctA+"/invites", accessC, map[string]any{
		"email": "y@inv.com", "phone_e164": "+27821234568",
	})
	if rec.Code != http.StatusForbidden {
		t.Errorf("member invite create: %d", rec.Code)
	}
	rec, _ = doJSON(t, h, "PATCH", "/v1/locations/"+locA+"/limits", accessC, map[string]any{
		"max_opens_per_member_per_day": 3,
	})
	if rec.Code != http.StatusForbidden {
		t.Errorf("member limits patch: %d", rec.Code)
	}
}

func TestLocationsRoutes(t *testing.T) {
	h := newTestServer(t, "")
	accessA, _ := register(t, h, "loc@x.com")
	accessB, _ := register(t, h, "locb@x.com")
	acctA, locA := tenantIDs(t, h, accessA)

	// nested create under own account
	rec, out := doJSON(t, h, "POST", "/v1/accounts/"+acctA+"/locations", accessA, map[string]any{
		"type": "building", "name": "Annex",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("nested create: %d %s", rec.Code, rec.Body)
	}
	annexID := out["id"].(string)

	// top-level create → fresh isolated account
	rec, out = doJSON(t, h, "POST", "/v1/locations", accessA, map[string]any{"name": "Beach House"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("top-level create: %d %s", rec.Code, rec.Body)
	}
	if out["account_id"] == acctA {
		t.Error("top-level location must get a fresh account")
	}

	// cross-tenant probes → 404
	for _, probe := range []struct{ method, path string }{
		{"GET", "/v1/locations/" + locA},
		{"PATCH", "/v1/locations/" + locA},
		{"DELETE", "/v1/locations/" + locA},
		{"GET", "/v1/locations/" + locA + "/limits"},
		{"PATCH", "/v1/locations/" + locA + "/limits"},
	} {
		var body any
		if probe.method == "PATCH" {
			body = map[string]any{}
		}
		rec, _ := doJSON(t, h, probe.method, probe.path, accessB, body)
		if rec.Code != http.StatusNotFound {
			t.Errorf("cross-tenant %s %s: %d", probe.method, probe.path, rec.Code)
		}
	}

	// limits: admin sets quota, member-visible read reflects it
	rec, out = doJSON(t, h, "PATCH", "/v1/locations/"+locA+"/limits", accessA, map[string]any{
		"max_opens_per_member_per_day": 4,
	})
	if rec.Code != 200 {
		t.Fatalf("limits patch: %d %s", rec.Code, rec.Body)
	}
	if q := out["quotas"].(map[string]any); q["max_opens_per_member_per_day"] != float64(4) {
		t.Errorf("quota set: %v", out)
	}
	rec, out = doJSON(t, h, "GET", "/v1/locations/"+locA+"/limits", accessA, nil)
	if rec.Code != 200 {
		t.Fatalf("limits get: %d", rec.Code)
	}
	usage := out["usage"].(map[string]any)
	if usage["location_opens_today"] != float64(0) || usage["my_opens_today"] != float64(0) {
		t.Errorf("fresh usage: %v", usage)
	}

	// invalid quota value
	rec, _ = doJSON(t, h, "PATCH", "/v1/locations/"+locA+"/limits", accessA, map[string]any{
		"max_opens_per_member_per_day": 0,
	})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("quota 0 must be invalid (1..100000): %d", rec.Code)
	}

	// delete annex: account survives (anchor remains)
	rec, out = doJSON(t, h, "DELETE", "/v1/locations/"+annexID, accessA, nil)
	if rec.Code != 200 || out["account_dropped"] != false {
		t.Errorf("delete annex: %d %v", rec.Code, out)
	}
	// delete anchor: 1:1 account dropped
	rec, out = doJSON(t, h, "DELETE", "/v1/locations/"+locA, accessA, nil)
	if rec.Code != 200 || out["account_dropped"] != true {
		t.Errorf("delete anchor: %d %v", rec.Code, out)
	}
}

func TestAccessPointRoutes(t *testing.T) {
	h := newTestServer(t, "")
	accessA, _ := register(t, h, "ap@x.com")
	accessB, _ := register(t, h, "apb@x.com")
	acctA, locA := tenantIDs(t, h, accessA)
	acctB, _ := tenantIDs(t, h, accessB)

	// create (admin)
	rec, out := doJSON(t, h, "POST", "/v1/access-points", accessA, map[string]any{
		"location_id": locA, "name": "Main gate", "kind": "gate",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("ap create: %d %s", rec.Code, rec.Body)
	}
	apID := out["id"].(string)
	if out["meter"].(map[string]any)["total_opens"] != float64(0) {
		t.Errorf("meter shape: %v", out)
	}

	// B cannot create an AP under A's location (404, no existence leak)
	rec, _ = doJSON(t, h, "POST", "/v1/access-points", accessB, map[string]any{
		"location_id": locA, "name": "Sneaky", "kind": "gate",
	})
	if rec.Code != http.StatusNotFound {
		t.Errorf("cross-tenant ap create: %d", rec.Code)
	}

	// B cannot read A's AP; scoped listing shows only own
	rec, _ = doJSON(t, h, "GET", "/v1/access-points/"+apID, accessB, nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("cross-tenant ap get: %d", rec.Code)
	}
	rec, out = doJSON(t, h, "GET", "/v1/access-points?account_id="+acctB, accessB, nil)
	if rec.Code != 200 || len(out["access_points"].([]any)) != 0 {
		t.Errorf("B's ap list: %d %v", rec.Code, out)
	}
	// B asking for A's account listing → 404
	rec, _ = doJSON(t, h, "GET", "/v1/access-points?account_id="+acctA, accessB, nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("cross-tenant ap list: %d", rec.Code)
	}

	// A's unscoped listing includes it
	rec, out = doJSON(t, h, "GET", "/v1/access-points", accessA, nil)
	if rec.Code != 200 || len(out["access_points"].([]any)) != 1 {
		t.Errorf("A's ap list: %d %v", rec.Code, out)
	}

	// bad kind rejected
	rec, _ = doJSON(t, h, "POST", "/v1/access-points", accessA, map[string]any{
		"location_id": locA, "name": "X", "kind": "portal",
	})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad kind: %d", rec.Code)
	}
}

// decode helper for subtests wanting typed access
func mustJSON(t *testing.T, rec *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body)
	}
}
