package store

import (
	"context"
	"errors"
	"testing"
)

// chanFixture: owner + a member with a verified phone AND a Slack identity,
// plus one access point.
type chanFixture struct {
	s        *Store
	acct     *Account
	loc      *Location
	ap       *AccessPointDetail
	owner    *User
	member   *User
	phone    string
	slackUID string
}

func newChanFixture(t *testing.T) *chanFixture {
	t.Helper()
	s := openTest(t)
	ctx := context.Background()
	owner, err := s.CreateUser(ctx, "owner@ch.com", "h", "Owner", "")
	if err != nil {
		t.Fatal(err)
	}
	acct, loc, err := s.CreateAccountWithOwner(ctx, owner.ID, "Estate", "ZA")
	if err != nil {
		t.Fatal(err)
	}
	ap, err := s.CreateAccessPointFull(ctx, acct.ID, loc.ID, "Main gate", "gate", "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	member, err := s.CreateUser(ctx, "member@ch.com", "h", "Mia", "")
	if err != nil {
		t.Fatal(err)
	}
	tx, _ := s.db.Begin()
	if err := upsertAccountMember(ctx, tx, acct.ID, member.ID, "member"); err != nil {
		t.Fatal(err)
	}
	tx.Commit()

	f := &chanFixture{s: s, acct: acct, loc: loc, ap: ap, owner: owner, member: member,
		phone: "+27821234567", slackUID: "U0MEMBER"}
	if err := s.AddVerifiedPhone(ctx, member.ID, f.phone); err != nil {
		t.Fatal(err)
	}
	if err := s.LinkChannelIdentity(ctx, "slack", f.slackUID, member.ID); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestChannelIdentityResolutionAndTenancy(t *testing.T) {
	f := newChanFixture(t)
	ctx := context.Background()

	// resolve → member profile id
	got, err := f.s.ResolveChannelIdentity(ctx, "slack", f.slackUID)
	if err != nil || got != f.member.ID {
		t.Fatalf("resolve: %v %q", err, got)
	}
	name, err := f.s.ChannelIdentityDisplayName(ctx, "slack", f.slackUID)
	if err != nil || name != "Mia" {
		t.Errorf("display name: %v %q", err, name)
	}
	// unknown identity → ErrNotFound (fail closed at the caller)
	if _, err := f.s.ResolveChannelIdentity(ctx, "slack", "U-NOBODY"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown identity: %v", err)
	}
	// channel is part of the key: same external id on another channel is distinct
	if _, err := f.s.ResolveChannelIdentity(ctx, "telegram", f.slackUID); !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-channel leak: %v", err)
	}

	// available APs by profile (Slack path) and by phone (WhatsApp path) both
	// resolve the member's one gate.
	byProfile, _ := f.s.AvailableAccessPointsByProfile(ctx, f.member.ID)
	if len(byProfile) != 1 || byProfile[0].APID != f.ap.ID || byProfile[0].Type != APMember {
		t.Errorf("by profile: %+v", byProfile)
	}
	byPhone, _ := f.s.AvailableAccessPointsByPhone(ctx, f.phone, 0)
	if len(byPhone) != 1 || byPhone[0].APID != f.ap.ID {
		t.Errorf("by phone: %+v", byPhone)
	}
	// member id resolvable for the WhatsApp open path
	uid, ok, _ := f.s.MemberUserIDByPhoneForAP(ctx, f.phone, f.ap.ID)
	if !ok || uid != f.member.ID {
		t.Errorf("member by phone/ap: %v %q", ok, uid)
	}
}

func TestChannelDisabledUserLosesAccess(t *testing.T) {
	f := newChanFixture(t)
	ctx := context.Background()
	if _, err := f.s.SetUserStatus(ctx, f.member.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	if aps, _ := f.s.AvailableAccessPointsByProfile(ctx, f.member.ID); len(aps) != 0 {
		t.Errorf("disabled member still has profile access: %+v", aps)
	}
	if aps, _ := f.s.AvailableAccessPointsByPhone(ctx, f.phone, 0); len(aps) != 0 {
		t.Errorf("disabled member still has phone access: %+v", aps)
	}
	if _, ok, _ := f.s.MemberUserIDByPhoneForAP(ctx, f.phone, f.ap.ID); ok {
		t.Error("disabled member still resolves for open")
	}
	// PhoneLinkState distinguishes linked-but-disabled from unlinked.
	linked, active, _ := f.s.PhoneLinkState(ctx, f.phone)
	if !linked || active {
		t.Errorf("link state: linked=%v active=%v (want linked, inactive)", linked, active)
	}
	if l, _, _ := f.s.PhoneLinkState(ctx, "+27000000000"); l {
		t.Error("unknown phone reported linked")
	}
}

func TestChannelChatDedupeAndLog(t *testing.T) {
	f := newChanFixture(t)
	ctx := context.Background()
	chatID, err := f.s.UpsertChannelChat(ctx, "whatsapp", f.phone, "", f.phone, nil)
	if err != nil || chatID == "" {
		t.Fatalf("upsert chat: %v", err)
	}
	// same (channel, external_key) → same chat row
	chatID2, _ := f.s.UpsertChannelChat(ctx, "whatsapp", f.phone, "", f.phone, nil)
	if chatID2 != chatID {
		t.Errorf("chat not deduped: %q vs %q", chatID, chatID2)
	}

	// first inbound is new; the redelivered one (same provider id) is not
	isNew, err := f.s.InsertInboundMessage(ctx, chatID, "whatsapp", "text", map[string]any{"b": 1}, "wamid.1", 100)
	if err != nil || !isNew {
		t.Fatalf("first inbound: %v %v", err, isNew)
	}
	again, _ := f.s.InsertInboundMessage(ctx, chatID, "whatsapp", "text", map[string]any{"b": 1}, "wamid.1", 100)
	if again {
		t.Error("redelivered message not deduped")
	}
	// a message with no provider id is never deduped
	n1, _ := f.s.InsertInboundMessage(ctx, chatID, "whatsapp", "text", nil, "", 100)
	n2, _ := f.s.InsertInboundMessage(ctx, chatID, "whatsapp", "text", nil, "", 100)
	if !n1 || !n2 {
		t.Error("no-provider-id messages should both insert")
	}

	if err := f.s.InsertOutboundMessage(ctx, chatID, "whatsapp", "text", map[string]any{"text": "hi"}, "wamid.out", "sent"); err != nil {
		t.Fatalf("outbound: %v", err)
	}
}

func TestAvailableAccessPointsVisitorGrant(t *testing.T) {
	f := newChanFixture(t)
	ctx := context.Background()
	visitorPhone := "+27829998888"
	max := int64(2)
	_, err := f.s.CreateGrant(ctx, f.acct.ID, CreateGrantArgs{
		GrantedByUserID: f.owner.ID, PhoneE164: visitorPhone, VisitorName: "Plumber",
		StartsAt: now() - 10, EndsAt: now() + 3600, MaxUses: &max, AccessPointIDs: []string{f.ap.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	aps, _ := f.s.AvailableAccessPointsByPhone(ctx, visitorPhone, 0)
	if len(aps) != 1 || aps[0].Type != APVisitor || aps[0].GrantID == "" {
		t.Fatalf("visitor grant lookup: %+v", aps)
	}
	if !aps[0].MaxUses.Valid || aps[0].MaxUses.Int64 != 2 {
		t.Errorf("visitor max uses: %+v", aps[0].MaxUses)
	}
	// a stranger phone sees nothing
	if aps, _ := f.s.AvailableAccessPointsByPhone(ctx, "+27000000000", 0); len(aps) != 0 {
		t.Errorf("stranger sees APs: %+v", aps)
	}
}

func TestLinkedLocationsByPhone(t *testing.T) {
	f := newChanFixture(t)
	ctx := context.Background()
	locs, err := f.s.LinkedLocationsByPhone(ctx, f.phone)
	if err != nil || len(locs) != 1 || locs[0].ID != f.loc.ID {
		t.Fatalf("linked locations: %v %+v", err, locs)
	}
}
