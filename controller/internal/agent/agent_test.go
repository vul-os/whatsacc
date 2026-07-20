package agent_test

import (
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/vul-os/lintel/controller/internal/agent"
	"github.com/vul-os/lintel/controller/internal/events"
	"github.com/vul-os/lintel/controller/internal/grants"
	"github.com/vul-os/lintel/controller/internal/relay"
)

func newTestAgent(t *testing.T) *agent.Agent {
	t.Helper()
	a, err := agent.New(agent.Options{StateDir: t.TempDir(), Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	return a
}

// orderingRelay wraps the real mock relay and, on Pulse, snapshots whether
// the grant_redeemed record was already durably queued (or overflowed) —
// proving OnRedeemed records BEFORE it actuates, not after.
type orderingRelay struct {
	*relay.Mock
	queue           *events.Queue
	pulseCalls      int
	recordedByPulse bool
}

func (r *orderingRelay) Pulse(d time.Duration) error {
	r.pulseCalls++
	if n, g := r.queue.Len(); n > 0 || g > 0 {
		r.recordedByPulse = true
	}
	if entries, _ := r.queue.OverflowEntriesForTest(); len(entries) > 0 {
		r.recordedByPulse = true
	}
	return r.Mock.Pulse(d)
}

// TestOnRedeemedRecordsBeforeActuating is the regression test for the
// defect: OnRedeemed used to call Relay.Pulse (physically open the gate)
// BEFORE any event was durably queued, so a crash between the two calls —
// or the swallowed enqueue error described below — could leave a physical
// open with zero audit trace. This proves the grant_redeemed event is on
// durable storage strictly before Pulse is invoked.
func TestOnRedeemedRecordsBeforeActuating(t *testing.T) {
	a := newTestAgent(t)
	rel := &orderingRelay{Mock: relay.NewMock(nil), queue: a.Queue}
	a.Relay = rel

	g := &grants.Grant{GrantID: "grant-1"}
	p := &grants.Proof{Cnonce: "cnonce-1", AccessPoint: "main", Sig: "sig-1"}
	a.OnRedeemed(g, p)

	if rel.pulseCalls != 1 {
		t.Fatalf("expected exactly one Pulse call, got %d", rel.pulseCalls)
	}
	if !rel.recordedByPulse {
		t.Fatal("grant_redeemed was not durably recorded before actuation")
	}
	if n, gr := a.Queue.Len(); n != 1 || gr != 1 {
		// "opened" lands in the normal partition, grant_redeemed in the
		// reserved one — both must be present after a successful redemption.
		t.Fatalf("queue after redemption: normal=%d grant=%d, want 1,1", n, gr)
	}
}

// TestOnRedeemedStillOpensWhenReservedPartitionFull is the safety-tradeoff
// regression test: when the reserved grant_redeemed partition is entirely
// full (proto/events.md's stated v0 gap), OnRedeemed must NOT refuse to
// open — this is the offline emergency access path, and a resident must
// not be stranded because the local audit disk is unhappy. It must instead
// fall back to the overflow log (still durable) and still actuate.
func TestOnRedeemedStillOpensWhenReservedPartitionFull(t *testing.T) {
	a := newTestAgent(t)
	rel := &orderingRelay{Mock: relay.NewMock(nil), queue: a.Queue}
	a.Relay = rel

	a.Queue.SetSyncForTest(false)
	for i := 0; i < events.GrantReserved; i++ {
		if err := a.Queue.Enqueue("grant_redeemed", []byte(`{"event_id":"filler"}`)); err != nil {
			t.Fatalf("filling reserved partition: %v", err)
		}
	}

	g := &grants.Grant{GrantID: "grant-2"}
	p := &grants.Proof{Cnonce: "cnonce-2", AccessPoint: "main", Sig: "sig-2"}
	a.OnRedeemed(g, p)

	if rel.pulseCalls != 1 {
		t.Fatalf("gate must still open when the reserved partition is full: pulse calls=%d", rel.pulseCalls)
	}
	entries, err := a.Queue.OverflowEntriesForTest()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected the grant_redeemed record to land in the overflow log, got %d entries", len(entries))
	}
}
