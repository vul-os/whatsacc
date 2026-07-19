package store

import (
	"context"
	"errors"
	"testing"
)

// ---------------------------------------------------------------------------
// Stage 1: members, invites, locations, quotas
// ---------------------------------------------------------------------------

func TestMemberListAndScoping(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, acctB, _, _ := twoTenants(t, s)

	ms, err := s.MemberList(ctx, acctA.ID)
	if err != nil || len(ms) != 1 {
		t.Fatalf("roster: %v %d", err, len(ms))
	}
	if ms[0].Role != "owner" || ms[0].Email != "a@x.com" {
		t.Errorf("roster row: %+v", ms[0])
	}
	// The store method itself is unscoped-by-design (handlers gate); verify
	// the scoped account getter honors tenancy.
	ua, _ := s.UserByEmail(ctx, "a@x.com")
	if _, err := s.AccountByIDScoped(ctx, acctB.ID, ua.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-tenant AccountByIDScoped: want ErrNotFound, got %v", err)
	}
	if got, err := s.AccountByIDScoped(ctx, acctA.ID, ua.ID); err != nil || got.Role != "owner" {
		t.Errorf("own AccountByIDScoped: %v %+v", err, got)
	}
}

func TestInviteLifecycle(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, _, locA, _ := twoTenants(t, s)

	invitee, err := s.CreateUser(ctx, "cleaner@x.com", "h", "C", "")
	if err != nil {
		t.Fatal(err)
	}

	future := now() + 3600
	id, err := s.CreateInvite(ctx, acctA.ID, "Cleaner@x.com", "member", "+27821234567", "hash-1", future)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	// wrong token hash → not found
	if _, err := s.AcceptInvite(ctx, "wrong-hash", invitee.ID, ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown token: want ErrNotFound, got %v", err)
	}
	// wrong user email → mismatch
	stranger, _ := s.CreateUser(ctx, "stranger@x.com", "h", "S", "")
	if _, err := s.AcceptInvite(ctx, "hash-1", stranger.ID, ""); !errors.Is(err, ErrInviteEmailMismatch) {
		t.Errorf("email mismatch: got %v", err)
	}
	// body phone conflicting with the invite phone → mismatch
	if _, err := s.AcceptInvite(ctx, "hash-1", invitee.ID, "+27829999999"); !errors.Is(err, ErrInvitePhoneMismatch) {
		t.Errorf("phone mismatch: got %v", err)
	}

	res, err := s.AcceptInvite(ctx, "hash-1", invitee.ID, "")
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if res.AccountID != acctA.ID || res.Role != "member" || !res.PhoneVerificationRequired {
		t.Errorf("accept result: %+v", res)
	}

	// membership + location membership landed
	if role, err := s.MemberRole(ctx, acctA.ID, invitee.ID); err != nil || role != "member" {
		t.Errorf("member role after accept: %q %v", role, err)
	}
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM location_members WHERE location_id = ? AND user_id = ?`,
		locA.ID, invitee.ID).Scan(&n); err != nil || n != 1 {
		t.Errorf("location membership after accept: %d %v", n, err)
	}

	// SECURITY: the phone is linked but NEVER auto-verified by an accept.
	linked, verified, err := s.PhoneVerified(ctx, invitee.ID, "+27821234567")
	if err != nil || !linked {
		t.Fatalf("phone not linked: %v %v", linked, err)
	}
	if verified {
		t.Error("accepting an invite must NEVER verify a phone")
	}

	// single-use
	if _, err := s.AcceptInvite(ctx, "hash-1", invitee.ID, ""); !errors.Is(err, ErrInviteUsed) {
		t.Errorf("second accept: want ErrInviteUsed, got %v", err)
	}
	_ = id
}

func TestInviteExpiry(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, _, _, _ := twoTenants(t, s)
	u, _ := s.CreateUser(ctx, "late@x.com", "h", "L", "")
	if _, err := s.CreateInvite(ctx, acctA.ID, "late@x.com", "member", "+27821230000", "hash-exp", now()-1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AcceptInvite(ctx, "hash-exp", u.ID, ""); !errors.Is(err, ErrInviteExpired) {
		t.Errorf("expired invite: got %v", err)
	}
}

func TestLocationDetailAndPatchTenancy(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, acctB, locA, _ := twoTenants(t, s)

	locs, err := s.LocationsByAccountDetailed(ctx, acctA.ID)
	if err != nil || len(locs) != 1 {
		t.Fatalf("detailed list: %v %d", err, len(locs))
	}
	if locs[0].AccessPointCount != 0 || locs[0].MemberCount != 0 {
		t.Errorf("counts: %+v", locs[0])
	}

	// cross-tenant patch/get/delete are not-found
	name := "Hacked"
	if err := s.UpdateLocation(ctx, acctB.ID, locA.ID, LocationPatch{Name: &name}); !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-tenant patch: %v", err)
	}
	if _, err := s.LocationDetailByID(ctx, acctB.ID, locA.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-tenant get: %v", err)
	}
	if _, err := s.DeleteLocation(ctx, acctB.ID, locA.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-tenant delete: %v", err)
	}

	// own patch applies
	if err := s.UpdateLocation(ctx, acctA.ID, locA.ID, LocationPatch{Name: &name}); err != nil {
		t.Fatalf("own patch: %v", err)
	}
	got, _ := s.LocationDetailByID(ctx, acctA.ID, locA.ID)
	if got.Name != "Hacked" {
		t.Errorf("patch not applied: %+v", got)
	}
}

func TestDeleteLocationDropsEmptyAccount(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, _, locA, _ := twoTenants(t, s)

	dropped, err := s.DeleteLocation(ctx, acctA.ID, locA.ID)
	if err != nil || !dropped {
		t.Fatalf("delete last location: dropped=%v err=%v", dropped, err)
	}
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM accounts WHERE id = ?`, acctA.ID).Scan(&n); err != nil || n != 0 {
		t.Errorf("account not dropped: %d %v", n, err)
	}
}

func TestDeleteLocationKeepsAccountWithSiblings(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, _, locA, _ := twoTenants(t, s)
	if _, err := s.CreateLocation(ctx, acctA.ID, "house", "Second"); err != nil {
		t.Fatal(err)
	}
	dropped, err := s.DeleteLocation(ctx, acctA.ID, locA.ID)
	if err != nil || dropped {
		t.Fatalf("delete with sibling: dropped=%v err=%v", dropped, err)
	}
	var n int
	s.db.QueryRow(`SELECT count(*) FROM accounts WHERE id = ?`, acctA.ID).Scan(&n)
	if n != 1 {
		t.Error("account dropped despite remaining location")
	}
}

func TestLocationQuotasPatchSemantics(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	_, _, locA, _ := twoTenants(t, s)

	// default: no settings row = unlimited
	q, err := s.LocationQuotas(ctx, locA.ID)
	if err != nil || q.MaxOpensPerMemberPerDay != nil || q.MaxOpensPerLocationPerDay != nil {
		t.Fatalf("default quotas: %+v %v", q, err)
	}

	five := int64(5)
	q, err = s.PatchLocationQuotas(ctx, locA.ID, true, &five, false, nil)
	if err != nil || q.MaxOpensPerMemberPerDay == nil || *q.MaxOpensPerMemberPerDay != 5 || q.MaxOpensPerLocationPerDay != nil {
		t.Fatalf("set member quota: %+v %v", q, err)
	}

	// omitted field unchanged, other set
	hundred := int64(100)
	q, _ = s.PatchLocationQuotas(ctx, locA.ID, false, nil, true, &hundred)
	if *q.MaxOpensPerMemberPerDay != 5 || *q.MaxOpensPerLocationPerDay != 100 {
		t.Errorf("partial patch: %+v", q)
	}

	// explicit null clears
	q, _ = s.PatchLocationQuotas(ctx, locA.ID, true, nil, false, nil)
	if q.MaxOpensPerMemberPerDay != nil || *q.MaxOpensPerLocationPerDay != 100 {
		t.Errorf("clear member quota: %+v", q)
	}
}

func TestAccessPointDetailTenancyAndDeviceCheck(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, acctB, locA, locB := twoTenants(t, s)

	dA, err := s.CreateDevice(ctx, acctA.ID, locA.ID, "ctrl-a")
	if err != nil {
		t.Fatal(err)
	}
	// device at another location of another tenant → rejected
	if _, err := s.CreateAccessPointFull(ctx, acctB.ID, locB.ID, "Gate", "gate", dA.ID, nil, nil); !errors.Is(err, ErrDeviceNotAtLocation) {
		t.Errorf("cross-location device: want ErrDeviceNotAtLocation, got %v", err)
	}
	ap, err := s.CreateAccessPointFull(ctx, acctA.ID, locA.ID, "Main gate", "gate", dA.ID, nil, nil)
	if err != nil {
		t.Fatalf("create ap: %v", err)
	}
	if ap.DeviceID != dA.ID {
		t.Errorf("device not linked: %+v", ap)
	}

	// cross-tenant detail read → not found
	if _, err := s.AccessPointDetailByID(ctx, acctB.ID, ap.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-tenant AP detail: %v", err)
	}
	// context resolver finds it (unscoped, used by gated handlers/choke point)
	apc, err := s.AccessPointContextByID(ctx, ap.ID)
	if err != nil || apc.AccountID != acctA.ID || apc.LocationID != locA.ID || apc.DeviceID != dA.ID {
		t.Errorf("AP context: %+v %v", apc, err)
	}
}

// ---------------------------------------------------------------------------
// Rate-limit config plumbing (pure)
// ---------------------------------------------------------------------------

func TestParseRateLimitValue(t *testing.T) {
	if v := ParseRateLimitValue("", 7); v != 7 {
		t.Errorf("empty: %d", v)
	}
	if v := ParseRateLimitValue("0", 7); v != 0 {
		t.Errorf("zero is a valid explicit value: %d", v)
	}
	if v := ParseRateLimitValue("-3", 7); v != 7 {
		t.Errorf("negative falls back: %d", v)
	}
	if v := ParseRateLimitValue("2.5", 7); v != 7 {
		t.Errorf("float falls back: %d", v)
	}
	if v := ParseRateLimitValue(" 42 ", 7); v != 42 {
		t.Errorf("trimmed int: %d", v)
	}
}

func TestRateLimitOverrideResolution(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	env := RateLimitConfig{OpenCooldownS: 10, OpensPerHour: 30, ChatMsgsPerMin: 10, AccountOpensPerHour: 500}

	// no overrides row → env config
	if got := s.ResolveRateLimitConfig(ctx, env); got != env {
		t.Errorf("no overrides: %+v", got)
	}

	// stored override wins; garbage fields ignored
	if err := s.InstanceSettingSet(ctx, InstanceRateLimitsKey,
		map[string]any{"opens_per_hour": 1, "chat_msgs_per_min": -4, "junk": "x", "open_cooldown_s": 2.5}, ""); err != nil {
		t.Fatal(err)
	}
	got := s.ResolveRateLimitConfig(ctx, env)
	if got.OpensPerHour != 1 {
		t.Errorf("override not applied: %+v", got)
	}
	if got.ChatMsgsPerMin != 10 || got.OpenCooldownS != 10 {
		t.Errorf("garbage override leaked in: %+v", got)
	}
}

func TestFixedWindowMath(t *testing.T) {
	if ws := FixedWindowStart(3700, HourS); ws != 3600 {
		t.Errorf("hour window: %d", ws)
	}
	if r := SecondsUntilWindowEnd(3600, HourS); r != 3600 {
		t.Errorf("window end at boundary: %d", r)
	}
	if r := SecondsUntilWindowEnd(7199, HourS); r != 1 {
		t.Errorf("window end at last second: %d", r)
	}
	if r := CooldownRemainingS(100, 105, 10); r != 5 {
		t.Errorf("cooldown remaining: %d", r)
	}
	if r := CooldownRemainingS(100, 110, 10); r != 0 {
		t.Errorf("cooldown elapsed: %d", r)
	}
}
