package store

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

// openFixture: one tenant, one AP, generous default env limits with the
// cooldown DISABLED (tests that want the cooldown re-enable it).
type openFixture struct {
	s     *Store
	cfg   RateLimitConfig
	acct  *Account
	loc   *Location
	ap    *AccessPointDetail
	owner *User
}

func newOpenFixture(t *testing.T) *openFixture {
	t.Helper()
	s := openTest(t)
	ctx := context.Background()
	u, err := s.CreateUser(ctx, "owner@open.com", "h", "O", "")
	if err != nil {
		t.Fatal(err)
	}
	acct, loc, err := s.CreateAccountWithOwner(ctx, u.ID, "Open House", "ZA")
	if err != nil {
		t.Fatal(err)
	}
	ap, err := s.CreateAccessPointFull(ctx, acct.ID, loc.ID, "Main gate", "gate", "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	return &openFixture{
		s:     s,
		cfg:   RateLimitConfig{OpenCooldownS: 0, OpensPerHour: 1000, ChatMsgsPerMin: 10, AccountOpensPerHour: 100000},
		acct:  acct,
		loc:   loc,
		ap:    ap,
		owner: u,
	}
}

func (f *openFixture) addMember(t *testing.T, email string) *User {
	t.Helper()
	ctx := context.Background()
	u, err := f.s.CreateUser(ctx, email, "h", "M", "")
	if err != nil {
		t.Fatal(err)
	}
	tx, _ := f.s.db.Begin()
	if err := upsertAccountMember(ctx, tx, f.acct.ID, u.ID, "member"); err != nil {
		t.Fatal(err)
	}
	tx.Commit()
	return u
}

func (f *openFixture) open(t *testing.T, userID string) *LogAccessResult {
	t.Helper()
	res, err := f.s.LogAccess(context.Background(), f.cfg, LogAccessArgs{
		UserID: userID, AccessPointID: f.ap.ID, Command: "open", Source: "web",
	})
	if err != nil {
		t.Fatalf("LogAccess: %v", err)
	}
	return res
}

func TestOpenPathMemberAllowedAndAudited(t *testing.T) {
	f := newOpenFixture(t)
	res := f.open(t, f.owner.ID)
	if !res.Allowed || res.LogID == "" {
		t.Fatalf("member open: %+v", res)
	}
	logs, err := f.s.AccessLogsByAccount(context.Background(), f.acct.ID, 10)
	if err != nil || len(logs) != 1 || !logs[0].Success || logs[0].Command != "open" {
		t.Errorf("audit row: %v %+v", err, logs)
	}
}

func TestOpenPathUnknownAccessPoint(t *testing.T) {
	f := newOpenFixture(t)
	_, err := f.s.LogAccess(context.Background(), f.cfg, LogAccessArgs{
		UserID: f.owner.ID, AccessPointID: "no-such-ap", Command: "open", Source: "web",
	})
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown AP: want ErrNotFound, got %v", err)
	}
}

func TestOpenPathSuspendedAccount(t *testing.T) {
	f := newOpenFixture(t)
	ctx := context.Background()
	if _, err := f.s.SetAccountStatus(ctx, f.acct.ID, "suspended"); err != nil {
		t.Fatal(err)
	}
	res := f.open(t, f.owner.ID)
	if res.Allowed || res.Reason != "account_suspended" {
		t.Errorf("suspended open: %+v", res)
	}
	// denial audited with the exact reason
	logs, _ := f.s.AccessLogsByAccount(ctx, f.acct.ID, 10)
	if len(logs) != 1 || logs[0].Success || logs[0].Error != "account_suspended" {
		t.Errorf("denial audit: %+v", logs)
	}
	// 'close' stays allowed — the safe direction
	closeRes, err := f.s.LogAccess(ctx, f.cfg, LogAccessArgs{
		UserID: f.owner.ID, AccessPointID: f.ap.ID, Command: "close", Source: "web",
	})
	if err != nil || !closeRes.Allowed {
		t.Errorf("close on suspended account must be allowed: %v %+v", err, closeRes)
	}
}

func TestOpenPathDisabledUser(t *testing.T) {
	f := newOpenFixture(t)
	ctx := context.Background()
	m := f.addMember(t, "disabled@open.com")
	if _, err := f.s.SetUserStatus(ctx, m.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	res := f.open(t, m.ID)
	if res.Allowed || res.Reason != "user_disabled" {
		t.Errorf("disabled user open: %+v", res)
	}
	// Fail-closed: a user id with NO users row denies too.
	res2, err := f.s.LogAccess(ctx, f.cfg, LogAccessArgs{
		UserID: "ghost-user", AccessPointID: f.ap.ID, Command: "open", Source: "web",
	})
	if err != nil || res2.Allowed || res2.Reason != "user_disabled" {
		t.Errorf("ghost user must fail closed: %v %+v", err, res2)
	}
}

func TestOpenPathCooldown(t *testing.T) {
	f := newOpenFixture(t)
	f.cfg.OpenCooldownS = 10
	if res := f.open(t, f.owner.ID); !res.Allowed {
		t.Fatalf("first open: %+v", res)
	}
	res := f.open(t, f.owner.ID)
	if res.Allowed || res.Reason != "rate_limited" {
		t.Fatalf("cooldown miss: %+v", res)
	}
	if res.RetryAfterS < 1 || res.RetryAfterS > 10 {
		t.Errorf("retry-after: %d", res.RetryAfterS)
	}
}

func TestOpenPathMemberHourlyCapAndNoConsumeOnDenial(t *testing.T) {
	f := newOpenFixture(t)
	f.cfg.OpensPerHour = 2
	if !f.open(t, f.owner.ID).Allowed || !f.open(t, f.owner.ID).Allowed {
		t.Fatal("first two opens should pass")
	}
	for i := 0; i < 3; i++ { // repeated denials must not consume anything
		res := f.open(t, f.owner.ID)
		if res.Allowed || res.Reason != "rate_limited" || res.Limit != "member_opens_per_hour" {
			t.Fatalf("cap miss: %+v", res)
		}
	}
	// counter == successful opens exactly
	var count int64
	if err := f.s.db.QueryRow(
		`SELECT count FROM rate_limit_counters WHERE scope='opens_1h' AND subject=?`,
		"user:"+f.owner.ID).Scan(&count); err != nil || count != 2 {
		t.Errorf("counter drift: %d %v (denials must never consume)", count, err)
	}
}

func TestOpenPathAccountHourlyCeiling(t *testing.T) {
	f := newOpenFixture(t)
	f.cfg.AccountOpensPerHour = 2
	m1 := f.addMember(t, "m1@open.com")
	m2 := f.addMember(t, "m2@open.com")
	if !f.open(t, m1.ID).Allowed || !f.open(t, m2.ID).Allowed {
		t.Fatal("first two")
	}
	res := f.open(t, f.owner.ID)
	if res.Allowed || res.Limit != "account_opens_per_hour" {
		t.Fatalf("account ceiling: %+v", res)
	}
	// the denied member's OWN hour counter was handed back
	var count int64
	f.s.db.QueryRow(`SELECT count FROM rate_limit_counters WHERE scope='opens_1h' AND subject=?`,
		"user:"+f.owner.ID).Scan(&count)
	if count != 0 {
		t.Errorf("denied attempt consumed member counter: %d", count)
	}
}

func TestOpenPathQuotaMemberDailyAndAdminExemption(t *testing.T) {
	f := newOpenFixture(t)
	ctx := context.Background()
	one := int64(1)
	if _, err := f.s.PatchLocationQuotas(ctx, f.loc.ID, true, &one, false, nil); err != nil {
		t.Fatal(err)
	}
	m := f.addMember(t, "quota@open.com")
	if !f.open(t, m.ID).Allowed {
		t.Fatal("first member open")
	}
	res := f.open(t, m.ID)
	if res.Allowed || res.Reason != "quota_exceeded" || res.Limit != "member_opens_per_day" {
		t.Fatalf("quota miss: %+v", res)
	}
	// owner/admin is EXEMPT from quotas...
	if !f.open(t, f.owner.ID).Allowed || !f.open(t, f.owner.ID).Allowed {
		t.Error("admin must be quota-exempt")
	}
	// ...but NOT from rate limits
	f.cfg.OpensPerHour = 2
	res = f.open(t, f.owner.ID)
	if res.Allowed || res.Reason != "rate_limited" {
		t.Errorf("admin must still be rate-limited: %+v", res)
	}
}

func TestOpenPathQuotaLocationDaily(t *testing.T) {
	f := newOpenFixture(t)
	ctx := context.Background()
	two := int64(2)
	if _, err := f.s.PatchLocationQuotas(ctx, f.loc.ID, false, nil, true, &two); err != nil {
		t.Fatal(err)
	}
	m1 := f.addMember(t, "l1@open.com")
	m2 := f.addMember(t, "l2@open.com")
	m3 := f.addMember(t, "l3@open.com")
	if !f.open(t, m1.ID).Allowed || !f.open(t, m2.ID).Allowed {
		t.Fatal("first two")
	}
	res := f.open(t, m3.ID)
	if res.Allowed || res.Limit != "location_opens_per_day" {
		t.Fatalf("location quota: %+v", res)
	}
	// admin exempt from the location quota too — and still counted
	if !f.open(t, f.owner.ID).Allowed {
		t.Error("admin exempt from location quota")
	}
	var count int64
	f.s.db.QueryRow(`SELECT count FROM rate_limit_counters WHERE scope='loc_opens_1d' AND subject=?`,
		"loc:"+f.loc.ID).Scan(&count)
	if count != 3 {
		t.Errorf("admin opens must still increment the location counter: %d", count)
	}
}

// The hammer: N concurrent opens against a cap of K admit EXACTLY K.
func TestOpenPathExactOnceUnderConcurrency(t *testing.T) {
	t.Parallel()
	f := newOpenFixture(t)
	ctx := context.Background()
	quota := int64(5)
	if _, err := f.s.PatchLocationQuotas(ctx, f.loc.ID, true, &quota, false, nil); err != nil {
		t.Fatal(err)
	}
	m := f.addMember(t, "hammer@open.com")

	const workers = 32
	var allowed, denied atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := f.s.LogAccess(ctx, f.cfg, LogAccessArgs{
				UserID: m.ID, AccessPointID: f.ap.ID, Command: "open", Source: "api",
			})
			if err != nil {
				t.Errorf("LogAccess: %v", err)
				return
			}
			if res.Allowed {
				allowed.Add(1)
			} else {
				denied.Add(1)
			}
		}()
	}
	wg.Wait()
	if allowed.Load() != 5 || denied.Load() != workers-5 {
		t.Fatalf("exact-once violated: allowed=%d denied=%d (want 5/%d)", allowed.Load(), denied.Load(), workers-5)
	}
	// counters equal successful opens exactly
	var count int64
	f.s.db.QueryRow(`SELECT count FROM rate_limit_counters WHERE scope='opens_1d' AND subject=?`,
		"user:"+m.ID+"|loc:"+f.loc.ID).Scan(&count)
	if count != 5 {
		t.Errorf("counter drift after hammer: %d", count)
	}
	// every attempt audited: 5 success + 27 denials
	logs, _ := f.s.AccessLogsByAccount(ctx, f.acct.ID, 100)
	succ, den := 0, 0
	for _, l := range logs {
		if l.Success {
			succ++
		} else {
			den++
		}
	}
	if succ != 5 || den != workers-5 {
		t.Errorf("audit trail: %d success %d denied", succ, den)
	}
}

// Concurrent cooldown claims: exactly one of N simultaneous opens wins.
func TestOpenPathCooldownExactOnceUnderConcurrency(t *testing.T) {
	t.Parallel()
	f := newOpenFixture(t)
	f.cfg.OpenCooldownS = 3600
	m := f.addMember(t, "cd@open.com")

	const workers = 16
	var allowed atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := f.s.LogAccess(context.Background(), f.cfg, LogAccessArgs{
				UserID: m.ID, AccessPointID: f.ap.ID, Command: "open", Source: "api",
			})
			if err == nil && res.Allowed {
				allowed.Add(1)
			}
		}()
	}
	wg.Wait()
	if allowed.Load() != 1 {
		t.Fatalf("cooldown admitted %d of %d simultaneous opens (want exactly 1)", allowed.Load(), workers)
	}
}

func TestOpenPathKillSwitch(t *testing.T) {
	f := newOpenFixture(t)
	f.cfg.OpensPerHour = 0 // explicit 0 = block everything (kill switch)
	res := f.open(t, f.owner.ID)
	if res.Allowed || res.Reason != "rate_limited" {
		t.Errorf("kill switch: %+v", res)
	}
}

func TestOpenPathDBOverrideBeatsEnv(t *testing.T) {
	f := newOpenFixture(t)
	ctx := context.Background()
	if err := f.s.InstanceSettingSet(ctx, InstanceRateLimitsKey, map[string]int{"opens_per_hour": 1}, ""); err != nil {
		t.Fatal(err)
	}
	if !f.open(t, f.owner.ID).Allowed {
		t.Fatal("first open under override")
	}
	res := f.open(t, f.owner.ID)
	if res.Allowed || res.Limit != "member_opens_per_hour" {
		t.Errorf("db override not enforced: %+v", res)
	}
}

// ---------------------------------------------------------------------------
// Temporary grants: consume + refund semantics
// ---------------------------------------------------------------------------

func grantFixture(t *testing.T, f *openFixture, maxUses *int64, startsAt, endsAt int64) *Grant {
	t.Helper()
	g, err := f.s.CreateGrant(context.Background(), f.acct.ID, CreateGrantArgs{
		GrantedByUserID: f.owner.ID,
		PhoneE164:       "+27825550001",
		VisitorName:     "Plumber",
		StartsAt:        startsAt,
		EndsAt:          endsAt,
		MaxUses:         maxUses,
		AccessPointIDs:  []string{f.ap.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestGrantConsumeSemantics(t *testing.T) {
	f := newOpenFixture(t)
	ctx := context.Background()
	two := int64(2)
	g := grantFixture(t, f, &two, now()-10, now()+3600)

	// consume twice, then exhausted
	for i := 0; i < 2; i++ {
		id, err := f.s.TryConsumeGrant(ctx, "+27825550001", f.ap.ID, 0)
		if err != nil || id != g.ID {
			t.Fatalf("consume %d: %q %v", i, id, err)
		}
	}
	if id, _ := f.s.TryConsumeGrant(ctx, "+27825550001", f.ap.ID, 0); id != "" {
		t.Error("exhausted grant consumed")
	}
	got, _ := f.s.GrantByID(ctx, f.acct.ID, g.ID)
	if got.UsesCount != 2 || got.EffectiveStatus(now()) != "exhausted" {
		t.Errorf("uses/effective: %+v", got)
	}

	// refund restores a use
	if err := f.s.RefundGrantUse(ctx, g.ID); err != nil {
		t.Fatal(err)
	}
	if id, _ := f.s.TryConsumeGrant(ctx, "+27825550001", f.ap.ID, 0); id != g.ID {
		t.Error("refunded use not consumable")
	}

	// wrong phone / wrong AP never consume
	if id, _ := f.s.TryConsumeGrant(ctx, "+27829999999", f.ap.ID, 0); id != "" {
		t.Error("wrong phone consumed")
	}
	ap2, _ := f.s.CreateAccessPointFull(ctx, f.acct.ID, f.loc.ID, "Side door", "door", "", nil, nil)
	if id, _ := f.s.TryConsumeGrant(ctx, "+27825550001", ap2.ID, 0); id != "" {
		t.Error("uncovered AP consumed")
	}
}

func TestGrantWindowAndRevocation(t *testing.T) {
	f := newOpenFixture(t)
	ctx := context.Background()

	// pending (starts in the future)
	pending := grantFixture(t, f, nil, now()+1000, now()+2000)
	if id, _ := f.s.TryConsumeGrant(ctx, "+27825550001", f.ap.ID, 0); id != "" {
		t.Error("pending grant consumed")
	}
	if pending.EffectiveStatus(now()) != "pending" {
		t.Errorf("effective: %s", pending.EffectiveStatus(now()))
	}

	// revoke → not consumable, not double-revocable
	active := grantFixture(t, f, nil, now()-10, now()+3600)
	if _, err := f.s.RevokeGrant(ctx, f.acct.ID, active.ID, f.owner.ID); err != nil {
		t.Fatal(err)
	}
	if id, _ := f.s.TryConsumeGrant(ctx, "+27825550001", f.ap.ID, 0); id != "" {
		t.Error("revoked grant consumed")
	}
	if _, err := f.s.RevokeGrant(ctx, f.acct.ID, active.ID, f.owner.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("double revoke: %v", err)
	}
	// cross-tenant revoke is not-found
	other, _ := f.s.CreateUser(ctx, "other@grant.com", "h", "O", "")
	acctB, _, _ := f.s.CreateAccountWithOwner(ctx, other.ID, "B House", "ZA")
	g2 := grantFixture(t, f, nil, now()-10, now()+3600)
	if _, err := f.s.RevokeGrant(ctx, acctB.ID, g2.ID, other.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-tenant revoke: %v", err)
	}
}

func TestVisitorOpenWithGrantRefundsOnDenial(t *testing.T) {
	f := newOpenFixture(t)
	ctx := context.Background()
	one := int64(1)
	// location daily quota 1 → second visitor open denied
	if _, err := f.s.PatchLocationQuotas(ctx, f.loc.ID, false, nil, true, &one); err != nil {
		t.Fatal(err)
	}
	five := int64(5)
	g := grantFixture(t, f, &five, now()-10, now()+3600)

	res, gid, err := f.s.VisitorOpenWithGrant(ctx, f.cfg, "+27825550001", f.ap.ID, "whatsapp")
	if err != nil || gid != g.ID || res == nil || !res.Allowed {
		t.Fatalf("first visitor open: %v %q %+v", err, gid, res)
	}
	// second: quota denies → the consumed use is REFUNDED
	res2, gid2, err := f.s.VisitorOpenWithGrant(ctx, f.cfg, "+27825550001", f.ap.ID, "whatsapp")
	if err != nil || gid2 != g.ID || res2 == nil || res2.Allowed || res2.Reason != "quota_exceeded" {
		t.Fatalf("second visitor open: %v %q %+v", err, gid2, res2)
	}
	got, _ := f.s.GrantByID(ctx, f.acct.ID, g.ID)
	if got.UsesCount != 1 {
		t.Errorf("denied open must refund the grant use: uses=%d", got.UsesCount)
	}
	// no usable grant → (nil, "")
	res3, gid3, err := f.s.VisitorOpenWithGrant(ctx, f.cfg, "+27820000000", f.ap.ID, "whatsapp")
	if err != nil || res3 != nil || gid3 != "" {
		t.Errorf("no-grant visitor: %v %q %+v", err, gid3, res3)
	}
	// visitor denial audited with phone-only subject (user_id empty)
	logs, _ := f.s.AccessLogsByAccount(ctx, f.acct.ID, 10)
	foundDenial := false
	for _, l := range logs {
		if !l.Success && l.Error == "quota_exceeded" && l.UserID == "" {
			foundDenial = true
		}
	}
	if !foundDenial {
		t.Error("visitor denial not audited")
	}
}
