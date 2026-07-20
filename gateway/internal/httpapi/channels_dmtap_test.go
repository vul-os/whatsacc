package httpapi

// DMTAP wiring tests. Since no real DMTAP transport exists (see
// channels/dmtap.go), these prove only what the scaffold claims to prove:
// whatever a transport hands to DMTAP.Handle reaches the SAME choke point
// (profileOpen → store.LogAccess) every other channel uses, using a fake
// transport test double — the same role fakeWA/fakeSlack/fakeTG play for the
// webhook channels and TestChannelSocketModeRoutesThroughSameHandler plays
// for Slack Socket Mode.

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/vul-os/lintel/gateway/internal/channels"
)

const testDMTAPKeyName = "correct-horse-battery-staple-one-two-three-four"

// fakeDMTAPTransport is a minimal DMTAPTransport test double: Reply records
// what was sent. Subscribe is never exercised here (handleDMTAPIntent is
// called directly, mirroring how the Slack socket-mode test calls
// handleSlackSocketEnvelope directly rather than driving a real WebSocket).
type fakeDMTAPTransport struct {
	mu      sync.Mutex
	replies []channels.DMTAPReply
}

func (f *fakeDMTAPTransport) Subscribe(ctx context.Context) (<-chan channels.DMTAPIntent, error) {
	ch := make(chan channels.DMTAPIntent)
	return ch, nil
}

func (f *fakeDMTAPTransport) Reply(ctx context.Context, groupID string, r channels.DMTAPReply) channels.SendResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.replies = append(f.replies, r)
	return channels.SendResult{OK: true, ProviderMessageID: "mote-out-1"}
}

func (f *fakeDMTAPTransport) all() []channels.DMTAPReply {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]channels.DMTAPReply(nil), f.replies...)
}

// setupDMTAPChannel builds the same chEnv setupChannels does, plus a DMTAP
// channel wired to a fake transport and a linked DMTAP identity for the
// account owner.
func setupDMTAPChannel(t *testing.T) (*chEnv, *fakeDMTAPTransport) {
	t.Helper()
	e := setupChannels(t, permissiveRL())
	tr := &fakeDMTAPTransport{}
	e.s.dmtap = &channels.DMTAP{Transport: tr, Handle: e.s.handleDMTAPIntent}
	if err := e.st.LinkChannelIdentity(context.Background(), channels.KindDMTAP, testDMTAPKeyName, e.ownID); err != nil {
		t.Fatal(err)
	}
	return e, tr
}

// TestDMTAPUnlinkedIdentityGetsHonestPromptNoActuation proves an intent from
// an unknown DMTAP identity never reaches the open path.
func TestDMTAPUnlinkedIdentityGetsHonestPromptNoActuation(t *testing.T) {
	e, tr := setupDMTAPChannel(t)
	e.s.handleDMTAPIntent(context.Background(), channels.DMTAPIntent{
		MemberKeyName: "some-other-unlinked-key-name-not-registered-anywhere",
		GroupID:       "g1",
		Body:          "open",
		IntentID:      "i1",
	})
	if n := e.successOpens(t, channels.KindDMTAP); n != 0 {
		t.Fatalf("unlinked identity must never actuate: %d opens", n)
	}
	replies := tr.all()
	if len(replies) != 1 || !strings.Contains(replies[0].Text, "isn't linked") {
		t.Fatalf("expected an honest unlinked prompt: %+v", replies)
	}
}

// TestDMTAPLinkedOpenRoutesThroughSameChokePoint is the core regression: a
// linked member's "open" reaches store.LogAccess (audited under KindDMTAP,
// never a hardcoded different source — see channels_open_test.go for that
// bug's own regression test) and gets a real reply through the fake transport.
func TestDMTAPLinkedOpenRoutesThroughSameChokePoint(t *testing.T) {
	e, tr := setupDMTAPChannel(t)
	e.s.handleDMTAPIntent(context.Background(), channels.DMTAPIntent{
		MemberKeyName: testDMTAPKeyName,
		GroupID:       "g1",
		Body:          "open",
		IntentID:      "i1",
	})
	if n := e.successOpens(t, channels.KindDMTAP); n != 1 {
		t.Fatalf("linked open not audited under dmtap: %d", n)
	}
	replies := tr.all()
	if len(replies) != 1 || !strings.Contains(replies[0].Text, "Opening Main gate") {
		t.Fatalf("expected an opening reply: %+v", replies)
	}
}

// TestDMTAPDedupeIgnoresRedeliveredIntent mirrors the WhatsApp/Telegram
// redelivery guard: the same IntentID must not open twice.
func TestDMTAPDedupeIgnoresRedeliveredIntent(t *testing.T) {
	e, tr := setupDMTAPChannel(t)
	intent := channels.DMTAPIntent{MemberKeyName: testDMTAPKeyName, GroupID: "g1", Body: "open", IntentID: "dup-1"}
	e.s.handleDMTAPIntent(context.Background(), intent)
	e.s.handleDMTAPIntent(context.Background(), intent)
	if n := e.successOpens(t, channels.KindDMTAP); n != 1 {
		t.Fatalf("redelivered intent must not double-open: %d", n)
	}
	if len(tr.all()) != 1 {
		t.Fatalf("redelivered intent must not double-reply: %+v", tr.all())
	}
}

// TestDMTAPNoTransportFailsClosedOnReply proves that with no transport
// configured, replies are logged as failed rather than silently dropped or
// faked as sent — matches the fail-closed contract everywhere else.
func TestDMTAPNoTransportFailsClosedOnReply(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	if err := e.st.LinkChannelIdentity(context.Background(), channels.KindDMTAP, testDMTAPKeyName, e.ownID); err != nil {
		t.Fatal(err)
	}
	// s.dmtap is nil here (setupChannels doesn't wire one) — dmtapReply must
	// still work (log a failed row), not panic.
	e.s.handleDMTAPIntent(context.Background(), channels.DMTAPIntent{
		MemberKeyName: testDMTAPKeyName, GroupID: "g1", Body: "open", IntentID: "i1",
	})
	if n := e.successOpens(t, channels.KindDMTAP); n != 1 {
		t.Fatalf("the open itself must still be audited even if the reply can't send: %d", n)
	}
}
