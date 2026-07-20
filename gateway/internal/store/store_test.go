package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// TestDatabaseFilenameMatchesDocs: site/docs/self-host.md and
// troubleshooting.md document the SQLite file as lintel.db; Open must
// create exactly that file (there are no deployments yet, so the code was
// made to match the docs).
func TestDatabaseFilenameMatchesDocs(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	if _, err := os.Stat(filepath.Join(dir, "lintel.db")); err != nil {
		t.Errorf("expected lintel.db in the data dir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "gateway.db")); err == nil {
		t.Error("found gateway.db — filename must be lintel.db, not gateway.db")
	}
}

func TestMigrateIdempotent(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	s.Close()
	// Re-open: migrations must be recorded, not re-applied.
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	s2.Close()
}

func TestUserCRUDRoundTrip(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()

	u, err := s.CreateUser(ctx, "Alice@Example.com", "hash", "Alice", "ZA")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if u.Email != "alice@example.com" {
		t.Errorf("email not lowercased: %q", u.Email)
	}

	// duplicate email (case-insensitive) rejected
	if _, err := s.CreateUser(ctx, "ALICE@example.com", "h", "A", ""); !errors.Is(err, ErrEmailTaken) {
		t.Errorf("dup email: want ErrEmailTaken, got %v", err)
	}

	got, err := s.UserByEmail(ctx, "alice@example.com")
	if err != nil {
		t.Fatalf("UserByEmail: %v", err)
	}
	if got.ID != u.ID || got.PasswordHash != "hash" || got.Status != "active" || got.IsPlatformAdmin {
		t.Errorf("round-trip mismatch: %+v", got)
	}
	if _, err := s.UserByID(ctx, u.ID); err != nil {
		t.Errorf("UserByID: %v", err)
	}
	if _, err := s.UserByEmail(ctx, "nobody@example.com"); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing user: want ErrNotFound, got %v", err)
	}
}

// twoTenants sets up two users each owning one account with an anchor
// location, an access point and a device.
func twoTenants(t *testing.T, s *Store) (acctA, acctB *Account, locA, locB *Location) {
	t.Helper()
	ctx := context.Background()
	ua, err := s.CreateUser(ctx, "a@x.com", "h", "A", "")
	if err != nil {
		t.Fatal(err)
	}
	ub, err := s.CreateUser(ctx, "b@x.com", "h", "B", "")
	if err != nil {
		t.Fatal(err)
	}
	acctA, locA, err = s.CreateAccountWithOwner(ctx, ua.ID, "Alpha House", "ZA")
	if err != nil {
		t.Fatal(err)
	}
	acctB, locB, err = s.CreateAccountWithOwner(ctx, ub.ID, "Beta House", "ZA")
	if err != nil {
		t.Fatal(err)
	}
	return
}

func TestTenancyScoping(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, acctB, locA, locB := twoTenants(t, s)

	apA, err := s.CreateAccessPoint(ctx, acctA.ID, locA.ID, "Main gate", "gate")
	if err != nil {
		t.Fatalf("CreateAccessPoint: %v", err)
	}
	if _, err := s.CreateDevice(ctx, acctA.ID, locA.ID, "controller-1"); err != nil {
		t.Fatalf("CreateDevice: %v", err)
	}

	// B cannot read A's location, access point, or devices through any
	// scoped accessor — indistinguishable from not-found.
	if _, err := s.LocationByID(ctx, acctB.ID, locA.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-tenant LocationByID: want ErrNotFound, got %v", err)
	}
	if _, err := s.AccessPointByID(ctx, acctB.ID, apA.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-tenant AccessPointByID: want ErrNotFound, got %v", err)
	}
	if aps, _ := s.AccessPointsByAccount(ctx, acctB.ID); len(aps) != 0 {
		t.Errorf("B sees %d of A's access points", len(aps))
	}
	if ds, _ := s.DevicesByAccount(ctx, acctB.ID); len(ds) != 0 {
		t.Errorf("B sees %d of A's devices", len(ds))
	}

	// B cannot create resources under A's location.
	if _, err := s.CreateAccessPoint(ctx, acctB.ID, locA.ID, "sneaky", "gate"); !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-tenant CreateAccessPoint: want ErrNotFound, got %v", err)
	}
	if _, err := s.CreateDevice(ctx, acctB.ID, locA.ID, "sneaky"); !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-tenant CreateDevice: want ErrNotFound, got %v", err)
	}

	// A still sees its own.
	if got, err := s.AccessPointByID(ctx, acctA.ID, apA.ID); err != nil || got.Name != "Main gate" {
		t.Errorf("own AccessPointByID: %v %+v", err, got)
	}
	if locs, _ := s.LocationsByAccount(ctx, acctA.ID); len(locs) != 1 || locs[0].ID != locA.ID {
		t.Errorf("own locations wrong: %+v", locs)
	}
	_ = locB
}

func TestAccessLogsScoping(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, acctB, locA, _ := twoTenants(t, s)

	if _, err := s.InsertAccessLog(ctx, AccessLog{
		AccountID: acctA.ID, LocationID: locA.ID, Command: "open", Source: "web", Success: true,
	}); err != nil {
		t.Fatalf("InsertAccessLog: %v", err)
	}
	logsA, err := s.AccessLogsByAccount(ctx, acctA.ID, 10)
	if err != nil || len(logsA) != 1 {
		t.Fatalf("A's logs: %v (n=%d)", err, len(logsA))
	}
	if logsA[0].Command != "open" || !logsA[0].Success {
		t.Errorf("log round-trip: %+v", logsA[0])
	}
	logsB, err := s.AccessLogsByAccount(ctx, acctB.ID, 10)
	if err != nil || len(logsB) != 0 {
		t.Errorf("B sees A's logs: %v (n=%d)", err, len(logsB))
	}
}

func TestMemberRole(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, acctB, _, _ := twoTenants(t, s)

	ua, _ := s.UserByEmail(ctx, "a@x.com")
	role, err := s.MemberRole(ctx, acctA.ID, ua.ID)
	if err != nil || role != "owner" {
		t.Errorf("own role: %q %v", role, err)
	}
	if _, err := s.MemberRole(ctx, acctB.ID, ua.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-tenant role: want ErrNotFound, got %v", err)
	}
}

func TestClaimPlatformAdmin(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()

	u1, _ := s.CreateUser(ctx, "one@x.com", "h", "One", "")
	u2, _ := s.CreateUser(ctx, "two@x.com", "h", "Two", "")

	claimed, err := s.AdminClaimState(ctx)
	if err != nil || claimed {
		t.Fatalf("fresh instance should be unclaimed: %v %v", claimed, err)
	}

	won, err := s.ClaimPlatformAdmin(ctx, u1.ID)
	if err != nil || !won {
		t.Fatalf("first claim should win: %v %v", won, err)
	}
	got, _ := s.UserByID(ctx, u1.ID)
	if !got.IsPlatformAdmin {
		t.Error("winner not promoted")
	}

	// Burned: second claim loses, state reads claimed.
	won, err = s.ClaimPlatformAdmin(ctx, u2.ID)
	if err != nil || won {
		t.Errorf("second claim must lose: %v %v", won, err)
	}
	claimed, _ = s.AdminClaimState(ctx)
	if !claimed {
		t.Error("state should be claimed after win")
	}
	if raw, err := s.InstanceSettingGet(ctx, "admin_claimed"); err != nil || len(raw) == 0 {
		t.Errorf("burn flag missing: %v", err)
	}
}

func TestClaimRequiresActiveUser(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	// Nonexistent user: claim returns false and does NOT burn.
	won, err := s.ClaimPlatformAdmin(ctx, "no-such-user")
	if err != nil || won {
		t.Fatalf("ghost claim: %v %v", won, err)
	}
	if claimed, _ := s.AdminClaimState(ctx); claimed {
		t.Error("failed claim must not burn the mechanism")
	}
}

func TestRefreshTokenLifecycle(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	u, _ := s.CreateUser(ctx, "r@x.com", "h", "R", "")

	id, fam := NewID(), NewID()
	if err := s.InsertRefreshToken(ctx, id, fam, u.ID, "hash-1", 9999999999); err != nil {
		t.Fatalf("insert: %v", err)
	}
	rt, err := s.RefreshTokenByHash(ctx, "hash-1")
	if err != nil || rt.ID != id || rt.FamilyID != fam {
		t.Fatalf("lookup: %v %+v", err, rt)
	}

	newID := NewID()
	if err := s.RotateRefreshToken(ctx, id, newID, fam, u.ID, "hash-2", 9999999999); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	old, _ := s.RefreshTokenByHash(ctx, "hash-1")
	if !old.RevokedAt.Valid || old.ReplacedBy.String != newID {
		t.Errorf("old token not marked rotated: %+v", old)
	}
	// Double-rotate of the same token must fail (reuse window).
	if err := s.RotateRefreshToken(ctx, id, NewID(), fam, u.ID, "hash-3", 9999999999); err == nil {
		t.Error("double rotate should fail")
	}

	if err := s.RevokeRefreshFamily(ctx, fam); err != nil {
		t.Fatalf("revoke family: %v", err)
	}
	cur, _ := s.RefreshTokenByHash(ctx, "hash-2")
	if !cur.RevokedAt.Valid {
		t.Error("family revoke missed the live token")
	}
}

func TestInstanceSettings(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	if err := s.InstanceSettingSet(ctx, "rate_limits", map[string]int{"open_per_hour": 30}, ""); err != nil {
		t.Fatalf("set: %v", err)
	}
	raw, err := s.InstanceSettingGet(ctx, "rate_limits")
	if err != nil || string(raw) != `{"open_per_hour":30}` {
		t.Errorf("get: %v %s", err, raw)
	}
	if err := s.InstanceSettingSet(ctx, "rate_limits", map[string]int{"open_per_hour": 10}, ""); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	raw, _ = s.InstanceSettingGet(ctx, "rate_limits")
	if string(raw) != `{"open_per_hour":10}` {
		t.Errorf("upsert value: %s", raw)
	}
}
