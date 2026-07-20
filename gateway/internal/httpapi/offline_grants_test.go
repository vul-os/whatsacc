package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/vul-os/lintel/gateway/internal/keys"
	"github.com/vul-os/lintel/gateway/internal/store"
)

func genAppPubkey(t *testing.T) string {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(pub)
}

// offlineGrantFixture: tenant A (owner + a plain non-admin member + an AP
// bound to a real paired device + a second AP with NO device), tenant B
// (stranger, owns its own AP).
type offlineGrantFixture struct {
	h            http.Handler
	st           *store.Store
	accessA      string // owner
	accessB      string // stranger, own account
	memberAccess string // plain member of A's account
	memberUserID string
	ownerUserID  string
	acctA        string
	locA         string
	apID         string // device-bound
	apNoDeviceID string // no controller attached
	deviceID     string
	apB          string // stranger's own AP (device-bound), for cross-account checks
}

func setupOfflineGrantFixture(t *testing.T) *offlineGrantFixture {
	t.Helper()
	h, st := newTestServerWithStore(t, "")
	f := &offlineGrantFixture{h: h, st: st}
	f.accessA, _ = register(t, h, "owner-og@op.com")
	f.accessB, _ = register(t, h, "stranger-og@op.com")
	f.acctA, f.locA = tenantIDs(t, h, f.accessA)

	// plain (non-admin) member of A's account — offline-grant issuance is a
	// "give ME my own access" action, not an admin-only one; a bare member
	// must be able to mint for themselves.
	f.memberAccess, _ = register(t, h, "member-og@op.com")
	token := inviteAndRecoverToken(t, h, st, f.accessA, f.acctA, "member-og@op.com", "member", "+27821110001")
	rec, _ := doJSON(t, h, "POST", "/v1/accounts/invites/"+token+"/accept", f.memberAccess, map[string]any{})
	if rec.Code != 200 {
		t.Fatalf("member accept: %d %s", rec.Code, rec.Body)
	}
	_, meOut := doJSON(t, h, "GET", "/v1/auth/me", f.memberAccess, nil)
	f.memberUserID = meOut["user"].(map[string]any)["id"].(string)
	_, meOut = doJSON(t, h, "GET", "/v1/auth/me", f.accessA, nil)
	f.ownerUserID = meOut["user"].(map[string]any)["id"].(string)

	// device: create via the real HTTP route, then pair it for real over
	// /pair/redeem (the actual product flow — proves the AP's device_id
	// really is an enrolled, active controller key, not a bypass).
	rec, out := doJSON(t, h, "POST", "/v1/devices", f.accessA, map[string]any{
		"location_id": f.locA, "label": "gate-controller",
	})
	if rec.Code != 201 {
		t.Fatalf("device create: %d %s", rec.Code, rec.Body)
	}
	f.deviceID = out["id"].(string)
	claimToken := out["claim_token"].(string)
	ctrlPub := genAppPubkey(t)
	rec, out = doJSON(t, h, "POST", "/pair/redeem", "", map[string]any{
		"v": 0, "typ": "pair.redeem", "claim_token": claimToken, "controller_pubkey": ctrlPub,
		"hw": map[string]any{"model": "test", "fw": "0.0.1", "ifaces": []string{"wifi"}},
	})
	if rec.Code != 200 || out["typ"] != "pair.grant" {
		t.Fatalf("pair redeem: %d %s", rec.Code, rec.Body)
	}

	rec, out = doJSON(t, h, "POST", "/v1/access-points", f.accessA, map[string]any{
		"location_id": f.locA, "name": "Main Gate", "kind": "gate", "device_id": f.deviceID,
	})
	if rec.Code != 201 {
		t.Fatalf("ap create: %d %s", rec.Code, rec.Body)
	}
	f.apID = out["id"].(string)

	rec, out = doJSON(t, h, "POST", "/v1/access-points", f.accessA, map[string]any{
		"location_id": f.locA, "name": "Unwired Gate", "kind": "gate",
	})
	if rec.Code != 201 {
		t.Fatalf("ap (no device) create: %d %s", rec.Code, rec.Body)
	}
	f.apNoDeviceID = out["id"].(string)

	_, locB := tenantIDs(t, h, f.accessB)
	rec, out = doJSON(t, h, "POST", "/v1/access-points", f.accessB, map[string]any{
		"location_id": locB, "name": "B's Gate", "kind": "gate",
	})
	if rec.Code != 201 {
		t.Fatalf("apB create: %d %s", rec.Code, rec.Body)
	}
	f.apB = out["id"].(string)

	return f
}

// verifyIssuedGrant re-derives the gateway's public key from /v1/gateway/key
// and checks the returned grant's signature covers exactly the returned
// fields (the same Canonicalize the issuance handler used, imported fresh —
// not trusting the handler's own computation of what it signed).
func verifyIssuedGrant(t *testing.T, h http.Handler, out map[string]any) {
	t.Helper()
	_, keyOut := doJSON(t, h, "GET", "/v1/gateway/key", "", nil)
	pubB64, _ := keyOut["public_key"].(string)
	pubRaw, err := base64.RawURLEncoding.DecodeString(pubB64)
	if err != nil || len(pubRaw) != ed25519.PublicKeySize {
		t.Fatalf("bad gateway pubkey: %v", keyOut)
	}
	pub := ed25519.PublicKey(pubRaw)

	sig, _ := out["sig"].(string)
	if sig == "" {
		t.Fatalf("grant missing sig: %v", out)
	}
	m := map[string]any{}
	for k, v := range out {
		if k != "sig" {
			m[k] = v
		}
	}
	// JSON round-trips ints as float64; Canonicalize's json.Number path
	// (used by CanonicalizeJSON) tolerates that, so re-marshal through it
	// rather than hand the float64 map straight to Canonicalize (which only
	// accepts int/int64/json.Number for whole numbers).
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	canon, err := keys.CanonicalizeJSON(raw)
	if err != nil {
		t.Fatalf("canonicalize issued grant: %v", err)
	}
	if !keys.Verify(pub, canon, sig) {
		t.Fatalf("issued grant signature does not verify against the gateway's own published key")
	}
}

func TestOfflineGrantIssue_Success(t *testing.T) {
	f := setupOfflineGrantFixture(t)
	appPub := genAppPubkey(t)

	rec, out := doJSON(t, f.h, "POST", "/v1/offline-grants", f.memberAccess, map[string]any{
		"app_pubkey":       appPub,
		"access_point_ids": []string{f.apID},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("issue: %d %s", rec.Code, rec.Body)
	}
	if out["v"] != float64(0) || out["typ"] != "grant" {
		t.Fatalf("grant shape: %v", out)
	}
	if out["member"] != f.memberUserID {
		t.Errorf("member = %v, want %v", out["member"], f.memberUserID)
	}
	if out["app_pubkey"] != appPub {
		t.Errorf("app_pubkey = %v, want %v", out["app_pubkey"], appPub)
	}
	devices := out["devices"].([]any)
	if len(devices) != 1 || devices[0] != f.deviceID {
		t.Errorf("devices = %v, want [%s]", devices, f.deviceID)
	}
	aps := out["access_points"].([]any)
	if len(aps) != 1 || aps[0] != f.apID {
		t.Errorf("access_points = %v, want [%s]", aps, f.apID)
	}
	windows := out["windows"].([]any)
	if len(windows) != 1 {
		t.Fatalf("windows = %v", windows)
	}
	w := windows[0].(map[string]any)
	if w["days"] != "mon-sun" || w["from"] != "00:00" || w["to"] != "24:00" {
		t.Errorf("window = %v", w)
	}
	iat, _ := out["iat"].(float64)
	exp, _ := out["exp"].(float64)
	if exp-iat != 7*24*3600 {
		t.Errorf("exp-iat = %v, want 7d TTL (604800)", exp-iat)
	}
	if out["grant_id"] == nil || out["grant_id"] == "" {
		t.Errorf("grant_id missing")
	}

	verifyIssuedGrant(t, f.h, out)
}

// TestOfflineGrantIssue_AuditTrail issues a grant, then confirms a platform
// admin can see exactly who holds what via the existing admin audit trail —
// proto/grants.md has no revocation channel, so this is the honest
// substitute described in the file header of offline_grants.go.
func TestOfflineGrantIssue_AuditTrail(t *testing.T) {
	f := setupOfflineGrantFixture(t)
	if _, err := f.st.SetPlatformAdmin(context.Background(), f.ownerUserID, true); err != nil {
		t.Fatal(err)
	}
	appPub := genAppPubkey(t)
	rec, out := doJSON(t, f.h, "POST", "/v1/offline-grants", f.memberAccess, map[string]any{
		"app_pubkey":       appPub,
		"access_point_ids": []string{f.apID},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("issue: %d %s", rec.Code, rec.Body)
	}
	grantID := out["grant_id"].(string)

	rec, out = doJSON(t, f.h, "GET", "/v1/admin/audit/actions?limit=50", f.accessA, nil)
	if rec.Code != 200 {
		t.Fatalf("audit actions: %d %s", rec.Code, rec.Body)
	}
	var entry map[string]any
	for _, e := range out["actions"].([]any) {
		em := e.(map[string]any)
		if em["action"] == "offline_grant_issue" && em["target_id"] == grantID {
			entry = em
		}
	}
	if entry == nil {
		t.Fatalf("no audit entry for grant %s in %v", grantID, out["actions"])
	}
	if entry["actor_user_id"] != f.memberUserID {
		t.Errorf("audit actor = %v, want %v (the caller, not the account owner)", entry["actor_user_id"], f.memberUserID)
	}
	detail, _ := entry["detail"].(map[string]any)
	if detail == nil {
		t.Fatalf("audit detail missing: %v", entry)
	}
	aps, _ := detail["access_points"].([]any)
	if len(aps) != 1 || aps[0] != f.apID {
		t.Errorf("audit detail access_points = %v", detail["access_points"])
	}
}

func TestOfflineGrantIssue_MultipleAPsDedupDevices(t *testing.T) {
	f := setupOfflineGrantFixture(t)
	// second AP on the SAME device — devices must dedup to one entry.
	rec, out := doJSON(t, f.h, "POST", "/v1/access-points", f.accessA, map[string]any{
		"location_id": f.locA, "name": "Side Gate", "kind": "gate", "device_id": f.deviceID,
	})
	if rec.Code != 201 {
		t.Fatalf("ap2 create: %d %s", rec.Code, rec.Body)
	}
	ap2 := out["id"].(string)

	appPub := genAppPubkey(t)
	rec, out = doJSON(t, f.h, "POST", "/v1/offline-grants", f.accessA, map[string]any{
		"app_pubkey":       appPub,
		"access_point_ids": []string{f.apID, ap2},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("issue: %d %s", rec.Code, rec.Body)
	}
	devices := out["devices"].([]any)
	if len(devices) != 1 || devices[0] != f.deviceID {
		t.Errorf("devices not deduped: %v", devices)
	}
	aps := out["access_points"].([]any)
	if len(aps) != 2 {
		t.Errorf("access_points = %v, want 2 entries", aps)
	}
}

func TestOfflineGrantIssue_Negative(t *testing.T) {
	f := setupOfflineGrantFixture(t)
	appPub := genAppPubkey(t)

	cases := []struct {
		name       string
		bearer     string
		body       map[string]any
		wantStatus int
		wantErr    string
	}{
		{
			name:       "non-member (stranger) — 404, no existence leak",
			bearer:     f.accessB,
			body:       map[string]any{"app_pubkey": appPub, "access_point_ids": []string{f.apID}},
			wantStatus: http.StatusNotFound,
			wantErr:    "access_point_not_found",
		},
		{
			name:       "unknown access point",
			bearer:     f.accessA,
			body:       map[string]any{"app_pubkey": appPub, "access_point_ids": []string{"not-a-real-id"}},
			wantStatus: http.StatusNotFound,
			wantErr:    "access_point_not_found",
		},
		{
			name:       "all-or-nothing: one owned AP + one the caller has no access to",
			bearer:     f.accessA,
			body:       map[string]any{"app_pubkey": appPub, "access_point_ids": []string{f.apID, f.apB}},
			wantStatus: http.StatusNotFound,
			wantErr:    "access_point_not_found",
		},
		{
			name:       "access point with no controller device attached",
			bearer:     f.accessA,
			body:       map[string]any{"app_pubkey": appPub, "access_point_ids": []string{f.apNoDeviceID}},
			wantStatus: http.StatusBadRequest,
			wantErr:    "access_point_has_no_device",
		},
		{
			name:       "malformed app_pubkey",
			bearer:     f.accessA,
			body:       map[string]any{"app_pubkey": "not-base64url-ed25519", "access_point_ids": []string{f.apID}},
			wantStatus: http.StatusBadRequest,
			wantErr:    "invalid_app_pubkey",
		},
		{
			name:       "empty access_point_ids",
			bearer:     f.accessA,
			body:       map[string]any{"app_pubkey": appPub, "access_point_ids": []string{}},
			wantStatus: http.StatusBadRequest,
			wantErr:    "invalid_grant",
		},
		{
			name:       "duplicate access_point_ids",
			bearer:     f.accessA,
			body:       map[string]any{"app_pubkey": appPub, "access_point_ids": []string{f.apID, f.apID}},
			wantStatus: http.StatusBadRequest,
			wantErr:    "invalid_grant",
		},
		{
			name:       "unauthenticated",
			bearer:     "",
			body:       map[string]any{"app_pubkey": appPub, "access_point_ids": []string{f.apID}},
			wantStatus: http.StatusUnauthorized,
			wantErr:    "unauthorized",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec, out := doJSON(t, f.h, "POST", "/v1/offline-grants", tc.bearer, tc.body)
			if rec.Code != tc.wantStatus || out["error"] != tc.wantErr {
				t.Errorf("%s: %d %v, want %d %q", tc.name, rec.Code, out, tc.wantStatus, tc.wantErr)
			}
		})
	}
}

// TestOfflineGrantIssue_AccountSuspendedDeniesEvenOwner mirrors
// TestOpenEndpointVerdicts's suspended-account case: a suspended account
// must refuse to mint a NEW offline grant (which would otherwise outlive
// the suspension for up to 7 days, unrevocably) even for its owner.
func TestOfflineGrantIssue_AccountSuspendedDeniesEvenOwner(t *testing.T) {
	f := setupOfflineGrantFixture(t)
	if _, err := f.st.SetAccountStatus(context.Background(), f.acctA, "suspended"); err != nil {
		t.Fatal(err)
	}
	rec, out := doJSON(t, f.h, "POST", "/v1/offline-grants", f.accessA, map[string]any{
		"app_pubkey": genAppPubkey(t), "access_point_ids": []string{f.apID},
	})
	if rec.Code != http.StatusForbidden || out["error"] != "account_suspended" {
		t.Errorf("suspended issue: %d %v", rec.Code, out)
	}
}

// TestOfflineGrantIssue_DisabledUserDenied mirrors LogAccess's
// user_disabled check: a disabled member gets nothing, at any access
// point — issuing them a 7-day offline-redeemable document would be a much
// bigger hole than denying one live open.
//
// Since server.go's requireAuth started re-reading live user status on
// EVERY authenticated request (not just the platform-admin routes), a
// disabled member's request never reaches this handler's own
// (still-present, still-correct, now-defense-in-depth) disabled-user check
// at all — it is rejected earlier, as 401, by requireAuth itself.
func TestOfflineGrantIssue_DisabledUserDenied(t *testing.T) {
	f := setupOfflineGrantFixture(t)
	if _, err := f.st.SetUserStatus(context.Background(), f.memberUserID, "disabled"); err != nil {
		t.Fatal(err)
	}
	rec, out := doJSON(t, f.h, "POST", "/v1/offline-grants", f.memberAccess, map[string]any{
		"app_pubkey": genAppPubkey(t), "access_point_ids": []string{f.apID},
	})
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("disabled-user issue: %d %v", rec.Code, out)
	}
}
