package httpapi

// Regression coverage for the phoneOpen source-attribution bug: phoneOpen used
// to hardcode channels.KindWhatsApp as the audit source regardless of which
// channel actually called it, so a non-WhatsApp phone-verified open would be
// misattributed in the audit log. phoneOpen now takes the caller's channel
// Kind explicitly and threads it straight through to store.LogAccess /
// store.VisitorOpenWithGrant.

import (
	"context"
	"testing"
	"time"

	"github.com/vul-os/lintel/gateway/internal/channels"
	"github.com/vul-os/lintel/gateway/internal/store"
)

// TestPhoneOpenVisitorGrantAttributesRealSource proves a visitor grant open
// driven by a non-WhatsApp channel is audited with THAT channel's source, not
// a hardcoded "whatsapp".
func TestPhoneOpenVisitorGrantAttributesRealSource(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	ctx := context.Background()

	visitorPhone := "+27825550099"
	now := time.Now().Unix()
	if _, err := e.st.CreateGrant(ctx, e.acct, store.CreateGrantArgs{
		GrantedByUserID: e.ownID,
		PhoneE164:       visitorPhone,
		VisitorName:     "Courier",
		StartsAt:        now - 10,
		EndsAt:          now + 3600,
		AccessPointIDs:  []string{e.apID},
	}); err != nil {
		t.Fatalf("create grant: %v", err)
	}

	had, v, err := e.s.phoneOpen(ctx, visitorPhone, e.apID, "open", channels.KindTelegram)
	if err != nil {
		t.Fatalf("phoneOpen: %v", err)
	}
	if !had || !v.Allowed {
		t.Fatalf("visitor open should have been allowed: had=%v v=%+v", had, v)
	}

	if n := e.successOpens(t, channels.KindTelegram); n != 1 {
		t.Fatalf("visitor open must be audited with source=telegram, got %d", n)
	}
	if n := e.successOpens(t, channels.KindWhatsApp); n != 0 {
		t.Fatalf("visitor open must NOT be audited as whatsapp, got %d", n)
	}
}

// TestPhoneOpenMemberPathAttributesRealSource covers the member-by-phone
// branch of phoneOpen (the non-visitor-grant path) with the same regression:
// the source passed in must be what lands in the audit log.
func TestPhoneOpenMemberPathAttributesRealSource(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	ctx := context.Background()

	had, v, err := e.s.phoneOpen(ctx, testPhone, e.apID, "open", channels.KindTelegram)
	if err != nil {
		t.Fatalf("phoneOpen: %v", err)
	}
	if !had || !v.Allowed {
		t.Fatalf("member open should have been allowed: had=%v v=%+v", had, v)
	}

	if n := e.successOpens(t, channels.KindTelegram); n != 1 {
		t.Fatalf("member open must be audited with source=telegram, got %d", n)
	}
	if n := e.successOpens(t, channels.KindWhatsApp); n != 0 {
		t.Fatalf("member open must NOT be audited as whatsapp, got %d", n)
	}
}

// TestWhatsAppWebhookStillAttributesWhatsApp is the non-regression check on
// the real webhook path: an actual WhatsApp open must still be logged as
// whatsapp (phoneOpen's default caller passes channels.KindWhatsApp).
func TestWhatsAppWebhookStillAttributesWhatsApp(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	rec := waPost(e.h, waTextMsg(testPhoneRaw, "wamid.src1", "open", waPhoneID))
	if rec.Code != 200 {
		t.Fatalf("code: %d", rec.Code)
	}
	if n := e.successOpens(t, channels.KindWhatsApp); n != 1 {
		t.Fatalf("whatsapp open not audited as whatsapp: %d", n)
	}
	if n := e.successOpens(t, channels.KindTelegram); n != 0 {
		t.Fatalf("whatsapp open must not leak into telegram source: %d", n)
	}
}
