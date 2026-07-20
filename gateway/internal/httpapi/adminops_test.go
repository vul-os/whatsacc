package httpapi

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// claimAdmin registers a user and wins the first-run claim, returning their
// access token (now a live platform admin).
func claimAdmin(t *testing.T, h http.Handler, email string) string {
	t.Helper()
	access, _ := register(t, h, email)
	rec, out := doJSON(t, h, "POST", "/v1/admin/claim", access, map[string]any{"token": "op-token"})
	if rec.Code != 200 || out["ok"] != true {
		t.Fatalf("claim: %d %v", rec.Code, out)
	}
	// The old access token still has adm=false in its claims, but the gate
	// re-reads the LIVE users row — so it is already admin-capable. Re-login
	// is unnecessary; verify via a gated route below.
	return access
}

func TestAdminGateLiveCheck(t *testing.T) {
	h := newTestServer(t, "op-token")
	adminAccess := claimAdmin(t, h, "op@x.com")
	nonAdmin, _ := register(t, h, "user@x.com")

	// non-admin is refused every gated route
	for _, path := range []string{"/v1/admin/overview", "/v1/admin/accounts", "/v1/admin/users", "/v1/admin/limits", "/v1/admin/audit", "/v1/admin/audit/actions"} {
		rec, out := doJSON(t, h, "GET", path, nonAdmin, nil)
		if rec.Code != http.StatusForbidden || out["error"] != "not_platform_admin" {
			t.Errorf("non-admin %s: %d %v", path, rec.Code, out)
		}
	}
	// unauthenticated → 401
	rec, _ := doJSON(t, h, "GET", "/v1/admin/overview", "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("anon overview: %d", rec.Code)
	}
	// admin passes
	rec, out := doJSON(t, h, "GET", "/v1/admin/overview", adminAccess, nil)
	if rec.Code != 200 || out["totals"] == nil {
		t.Fatalf("admin overview: %d %v", rec.Code, out)
	}
}

func TestAdminOverviewAndListings(t *testing.T) {
	h := newTestServer(t, "op-token")
	adminAccess := claimAdmin(t, h, "op@x.com")
	register(t, h, "alice@x.com")
	register(t, h, "bob@x.com")

	rec, out := doJSON(t, h, "GET", "/v1/admin/overview", adminAccess, nil)
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	totals := out["totals"].(map[string]any)
	if totals["users"].(float64) < 3 || totals["accounts"].(float64) < 3 {
		t.Errorf("overview totals: %v", totals)
	}
	if len(out["recent_signups"].([]any)) < 3 {
		t.Errorf("recent signups: %v", out["recent_signups"])
	}

	// accounts listing + search
	rec, out = doJSON(t, h, "GET", "/v1/admin/accounts", adminAccess, nil)
	if rec.Code != 200 || out["total"].(float64) < 3 {
		t.Fatalf("accounts: %d %v", rec.Code, out)
	}
	rec, out = doJSON(t, h, "GET", "/v1/admin/accounts?query=Test%20House", adminAccess, nil)
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}

	// users listing + search (email substring, wildcards escaped)
	rec, out = doJSON(t, h, "GET", "/v1/admin/users?query=alice", adminAccess, nil)
	if rec.Code != 200 || out["total"].(float64) != 1 {
		t.Errorf("user search: %d %v", rec.Code, out)
	}
	rec, out = doJSON(t, h, "GET", "/v1/admin/users?query=%25", adminAccess, nil)
	if rec.Code != 200 || out["total"].(float64) != 0 {
		t.Errorf("wildcard must be literal: %d %v", rec.Code, out)
	}
}

func TestAdminAccountSuspendEnforced(t *testing.T) {
	h, st := newTestServerWithStore(t, "op-token")
	adminAccess := claimAdmin(t, h, "op@x.com")

	victim, _ := register(t, h, "victim@x.com")
	acctV, locV := tenantIDs(t, h, victim)
	rec, out := doJSON(t, h, "POST", "/v1/access-points", victim, map[string]any{
		"location_id": locV, "name": "Gate", "kind": "gate",
	})
	if rec.Code != 201 {
		t.Fatal(rec.Code)
	}
	apV := out["id"].(string)

	// suspend via admin route
	rec, out = doJSON(t, h, "PATCH", "/v1/admin/accounts/"+acctV, adminAccess, map[string]any{"status": "suspended"})
	if rec.Code != 200 || out["account"].(map[string]any)["status"] != "suspended" {
		t.Fatalf("suspend: %d %v", rec.Code, out)
	}
	// victim's open is now denied
	rec, out = doJSON(t, h, "POST", "/v1/access-points/"+apV+"/open", victim, map[string]any{})
	if rec.Code != http.StatusForbidden || out["error"] != "account_suspended" {
		t.Errorf("suspended open: %d %v", rec.Code, out)
	}
	// action audited
	rec, out = doJSON(t, h, "GET", "/v1/admin/audit/actions", adminAccess, nil)
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	found := false
	for _, a := range out["actions"].([]any) {
		if a.(map[string]any)["action"] == "account_status" {
			found = true
		}
	}
	if !found {
		t.Error("account_status not in admin audit trail")
	}
	_ = st
}

func TestAdminUserDisableEnforcedAndGuards(t *testing.T) {
	h := newTestServer(t, "op-token")
	adminAccess := claimAdmin(t, h, "op@x.com")
	_, meAdmin := doJSON(t, h, "GET", "/v1/auth/me", adminAccess, nil)
	adminID := meAdmin["user"].(map[string]any)["id"].(string)

	victim, victimRefresh := register(t, h, "victim@x.com")
	_, meV := doJSON(t, h, "GET", "/v1/auth/me", victim, nil)
	victimID := meV["user"].(map[string]any)["id"].(string)

	// cannot disable self
	rec, out := doJSON(t, h, "PATCH", "/v1/admin/users/"+adminID, adminAccess, map[string]any{"status": "disabled"})
	if rec.Code != http.StatusBadRequest || out["error"] != "cannot_disable_self" {
		t.Errorf("disable self: %d %v", rec.Code, out)
	}
	// cannot disable the LAST admin (admin is the only platform admin) —
	// covered by cannot_disable_self here; test last-admin via revoke below.

	// disable victim → their refresh token dies immediately
	rec, _ = doJSON(t, h, "PATCH", "/v1/admin/users/"+victimID, adminAccess, map[string]any{"status": "disabled"})
	if rec.Code != 200 {
		t.Fatalf("disable victim: %d", rec.Code)
	}
	rec, _ = doJSON(t, h, "POST", "/v1/auth/refresh", "", map[string]any{"refresh_token": victimRefresh})
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("disabled user refresh must fail: %d", rec.Code)
	}
	// their STILL-UNEXPIRED access token dies at the live requireAuth gate
	// too, immediately — not just at 15-minute natural expiry. This is the
	// fix: requireAuth (server.go) now re-reads the users row on every
	// authenticated request, exactly like requireAdmin already did, instead
	// of only trusting the JWT's signature and exp. Before that fix this
	// assertion failed (the old code left /me returning 200 for a disabled
	// user for the rest of the token's 15-minute life).
	rec, _ = doJSON(t, h, "GET", "/v1/auth/me", victim, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("disabled user's still-valid access token must be rejected immediately: %d", rec.Code)
	}
}

// TestLogoutAllRevokesEverySession proves POST /v1/auth/logout-all kills
// ALL of a user's refresh-token families, not just one (contrast
// /v1/auth/logout, which only burns the ONE family the presented token
// belongs to) — the "stolen phone" answer: a user with N devices logged in
// can end every session without knowing which one is compromised.
func TestLogoutAllRevokesEverySession(t *testing.T) {
	h := newTestServer(t, "")

	// Two independent "device" sessions for the same account: register
	// gives the first, login gives the second (issueTokensCtx mints a
	// fresh refresh-token family every time).
	rec, out := doJSON(t, h, "POST", "/v1/auth/register", "", map[string]any{
		"email": "multi@x.com", "password": "hunter2hunter2", "location_name": "L",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", rec.Code, rec.Body)
	}
	deviceARefresh := out["tokens"].(map[string]any)["refresh_token"].(string)

	rec, out = doJSON(t, h, "POST", "/v1/auth/login", "", map[string]any{
		"email": "multi@x.com", "password": "hunter2hunter2",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("login: %d %s", rec.Code, rec.Body)
	}
	deviceAAccess := out["tokens"].(map[string]any)["access_token"].(string)
	deviceBRefresh := out["tokens"].(map[string]any)["refresh_token"].(string)

	// Sanity: both refresh tokens still work before logout-all.
	rec, _ = doJSON(t, h, "POST", "/v1/auth/refresh", "", map[string]any{"refresh_token": deviceARefresh})
	if rec.Code != http.StatusOK {
		t.Fatalf("device A refresh before logout-all: %d", rec.Code)
	}
	rec, _ = doJSON(t, h, "POST", "/v1/auth/refresh", "", map[string]any{"refresh_token": deviceBRefresh})
	if rec.Code != http.StatusOK {
		t.Fatalf("device B refresh before logout-all: %d", rec.Code)
	}

	rec, out = doJSON(t, h, "POST", "/v1/auth/logout-all", deviceAAccess, nil)
	if rec.Code != http.StatusOK || out["ok"] != true {
		t.Fatalf("logout-all: %d %v", rec.Code, out)
	}

	// Both families are dead now, including the SECOND one that was never
	// presented to /logout-all directly — proving this is a per-USER
	// revocation, not per-token/per-family like /v1/auth/logout.
	rec, _ = doJSON(t, h, "POST", "/v1/auth/refresh", "", map[string]any{"refresh_token": deviceARefresh})
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("device A refresh after logout-all must fail: %d", rec.Code)
	}
	rec, _ = doJSON(t, h, "POST", "/v1/auth/refresh", "", map[string]any{"refresh_token": deviceBRefresh})
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("device B refresh after logout-all must fail: %d", rec.Code)
	}
}

func TestAdminPlatformAdminLastAdminGuard(t *testing.T) {
	h := newTestServer(t, "op-token")
	adminAccess := claimAdmin(t, h, "op@x.com")
	_, me := doJSON(t, h, "GET", "/v1/auth/me", adminAccess, nil)
	adminID := me["user"].(map[string]any)["id"].(string)

	// revoking the only admin is refused
	rec, out := doJSON(t, h, "POST", "/v1/admin/users/"+adminID+"/platform-admin", adminAccess, map[string]any{"grant": false})
	if rec.Code != http.StatusBadRequest || out["error"] != "cannot_revoke_last_admin" {
		t.Errorf("revoke last admin: %d %v", rec.Code, out)
	}

	// grant a second admin, then revoking the first is allowed
	second, _ := register(t, h, "second@x.com")
	_, me2 := doJSON(t, h, "GET", "/v1/auth/me", second, nil)
	secondID := me2["user"].(map[string]any)["id"].(string)
	rec, out = doJSON(t, h, "POST", "/v1/admin/users/"+secondID+"/platform-admin", adminAccess, map[string]any{"grant": true})
	if rec.Code != 200 || out["user"].(map[string]any)["is_platform_admin"] != true {
		t.Fatalf("grant second admin: %d %v", rec.Code, out)
	}
	rec, _ = doJSON(t, h, "POST", "/v1/admin/users/"+adminID+"/platform-admin", adminAccess, map[string]any{"grant": false})
	if rec.Code != 200 {
		t.Errorf("revoke with second admin present: %d", rec.Code)
	}
}

func TestAdminLimitsAndKillSwitch(t *testing.T) {
	h := newTestServer(t, "op-token")
	adminAccess := claimAdmin(t, h, "op@x.com")

	rec, out := doJSON(t, h, "GET", "/v1/admin/limits", adminAccess, nil)
	if rec.Code != 200 || out["defaults"] == nil || out["effective"] == nil {
		t.Fatalf("limits get: %d %v", rec.Code, out)
	}

	// set an override
	rec, out = doJSON(t, h, "PATCH", "/v1/admin/limits", adminAccess, map[string]any{"opens_per_hour": 7})
	if rec.Code != 200 {
		t.Fatalf("limits patch: %d %s", rec.Code, out)
	}
	if out["effective"].(map[string]any)["opens_per_hour"] != float64(7) {
		t.Errorf("override not effective: %v", out["effective"])
	}

	// kill switch requires confirmation
	rec, out = doJSON(t, h, "PATCH", "/v1/admin/limits", adminAccess, map[string]any{"opens_per_hour": 0})
	if rec.Code != http.StatusBadRequest || out["error"] != "kill_switch_confirmation_required" {
		t.Errorf("kill switch unconfirmed: %d %v", rec.Code, out)
	}
	rec, out = doJSON(t, h, "PATCH", "/v1/admin/limits", adminAccess, map[string]any{
		"opens_per_hour": 0, "confirm_kill_switch": true,
	})
	if rec.Code != 200 || out["effective"].(map[string]any)["opens_per_hour"] != float64(0) {
		t.Errorf("kill switch confirmed: %d %v", rec.Code, out)
	}

	// clear an override with null
	rec, out = doJSON(t, h, "PATCH", "/v1/admin/limits", adminAccess, map[string]any{"opens_per_hour": nil})
	if rec.Code != 200 {
		t.Fatalf("clear override: %d %v", rec.Code, out)
	}
	if out["overrides"].(map[string]any)["opens_per_hour"] != nil {
		t.Errorf("override not cleared: %v", out["overrides"])
	}

	// no fields → 400
	rec, _ = doJSON(t, h, "PATCH", "/v1/admin/limits", adminAccess, map[string]any{})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("empty patch: %d", rec.Code)
	}
}

func TestAdminAuditFilters(t *testing.T) {
	h := newTestServer(t, "op-token")
	adminAccess := claimAdmin(t, h, "op@x.com")

	// generate one success + one denial
	victim, _ := register(t, h, "v@x.com")
	_, locV := tenantIDs(t, h, victim)
	rec, out := doJSON(t, h, "POST", "/v1/access-points", victim, map[string]any{
		"location_id": locV, "name": "Gate", "kind": "gate",
	})
	apV := out["id"].(string)
	doJSON(t, h, "POST", "/v1/access-points/"+apV+"/open", victim, map[string]any{}) // success
	doJSON(t, h, "POST", "/v1/access-points/"+apV+"/open", victim, map[string]any{}) // cooldown denial

	rec, out = doJSON(t, h, "GET", "/v1/admin/audit", adminAccess, nil)
	if rec.Code != 200 || out["total"].(float64) < 2 {
		t.Fatalf("audit all: %d %v", rec.Code, out)
	}
	rec, out = doJSON(t, h, "GET", "/v1/admin/audit?kind=denied", adminAccess, nil)
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	for _, e := range out["entries"].([]any) {
		if e.(map[string]any)["success"] != false {
			t.Error("denied filter returned a success row")
		}
	}
	rec, out = doJSON(t, h, "GET", "/v1/admin/audit?kind=rate_limited", adminAccess, nil)
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	for _, e := range out["entries"].([]any) {
		if e.(map[string]any)["error"] != "rate_limited" {
			t.Errorf("rate_limited filter row: %v", e)
		}
	}
	// bad kind
	rec, _ = doJSON(t, h, "GET", "/v1/admin/audit?kind=bogus", adminAccess, nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad kind: %d", rec.Code)
	}
}

// TestAdminAuditReconciliationLinkage proves that a late-cmd.ack
// reconciliation row (store.ReconcileLateAck; see the
// TestLateAckReconcilesAccessLog end-to-end regression in devices_test.go
// for how one actually gets created off a real dispatch) surfaces its
// reconciles_log_id linkage in both admin audit surfaces that query
// access_logs directly — GET /v1/admin/audit and the recent_access_logs
// block of GET /v1/admin/accounts/{id} — and that ordinary rows keep
// serializing the field as JSON null (present key, not omitted, matching
// every other optional field's convention here), never a mysterious
// unexplained value.
func TestAdminAuditReconciliationLinkage(t *testing.T) {
	h, st := newTestServerWithStore(t, "op-token")
	adminAccess := claimAdmin(t, h, "op@x.com")

	victim, _ := register(t, h, "v@x.com")
	acctV, locV := tenantIDs(t, h, victim)
	rec, out := doJSON(t, h, "POST", "/v1/access-points", victim, map[string]any{
		"location_id": locV, "name": "Gate", "kind": "gate",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("ap create: %d %v", rec.Code, out)
	}
	apV := out["id"].(string)

	rec, out = doJSON(t, h, "POST", "/v1/access-points/"+apV+"/open", victim, map[string]any{})
	if rec.Code != http.StatusOK {
		t.Fatalf("open: %d %v", rec.Code, out)
	}

	ctx := context.Background()
	logs, err := st.AccessLogsByAccount(ctx, acctV, 10)
	if err != nil {
		t.Fatal(err)
	}
	origID := ""
	for _, l := range logs {
		if l.AccessPointID == apV && l.Command == "open" {
			origID = l.ID
		}
	}
	if origID == "" {
		t.Fatalf("original open row not found: %+v", logs)
	}

	// Build the reconciliation row directly via the store method the
	// gateway's late-ack path calls (hub.LateAckReconcile + handleLateAck
	// in devices.go) — exercising ReconcileLateAck itself rather than
	// redriving the full WS dispatch/late-ack dance already covered by
	// TestLateAckReconcilesAccessLog.
	reconID, err := st.ReconcileLateAck(ctx, origID, "opened", "", time.Now().Unix())
	if err != nil {
		t.Fatalf("ReconcileLateAck: %v", err)
	}

	rec, out = doJSON(t, h, "GET", "/v1/admin/audit", adminAccess, nil)
	if rec.Code != 200 {
		t.Fatalf("admin audit: %d %v", rec.Code, out)
	}
	var origEntry, reconEntry map[string]any
	for _, e := range out["entries"].([]any) {
		m := e.(map[string]any)
		switch m["id"] {
		case origID:
			origEntry = m
		case reconID:
			reconEntry = m
		}
	}
	if origEntry == nil || reconEntry == nil {
		t.Fatalf("expected both original (%s) and reconciliation (%s) rows in /v1/admin/audit: %v",
			origID, reconID, out["entries"])
	}
	if origEntry["reconciles_log_id"] != nil {
		t.Errorf("ordinary row must serialize reconciles_log_id as null, got %v", origEntry["reconciles_log_id"])
	}
	if reconEntry["reconciles_log_id"] != origID {
		t.Errorf("reconciliation row reconciles_log_id = %v, want %v", reconEntry["reconciles_log_id"], origID)
	}
	if reconEntry["error"] != "late_ack:opened" || reconEntry["success"] != true {
		t.Errorf("reconciliation row: success=%v error=%v", reconEntry["success"], reconEntry["error"])
	}

	// The account-detail surface (AdminAccountByID → recent_access_logs)
	// queries access_logs independently (AccessLogsByAccount, not
	// AdminAudit) — verify the same linkage isn't dropped there either.
	rec, out = doJSON(t, h, "GET", "/v1/admin/accounts/"+acctV, adminAccess, nil)
	if rec.Code != 200 {
		t.Fatalf("admin account get: %d %v", rec.Code, out)
	}
	origEntry, reconEntry = nil, nil
	for _, e := range out["recent_access_logs"].([]any) {
		m := e.(map[string]any)
		switch m["id"] {
		case origID:
			origEntry = m
		case reconID:
			reconEntry = m
		}
	}
	if origEntry == nil || reconEntry == nil {
		t.Fatalf("expected both rows in account detail recent_access_logs: %v", out["recent_access_logs"])
	}
	if origEntry["reconciles_log_id"] != nil {
		t.Errorf("account-detail ordinary row must be null, got %v", origEntry["reconciles_log_id"])
	}
	if reconEntry["reconciles_log_id"] != origID {
		t.Errorf("account-detail reconciliation row reconciles_log_id = %v, want %v", reconEntry["reconciles_log_id"], origID)
	}
}
