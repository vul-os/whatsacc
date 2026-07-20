package channels

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeDMTAPTransport is a DMTAPTransport test double: Subscribe returns a
// channel the test feeds directly, Reply records what was sent. It exists to
// prove DMTAP.Run's dispatch/backoff plumbing without a real DMTAP session —
// exactly the role fakeConn plays for SocketMode.
type fakeDMTAPTransport struct {
	mu         sync.Mutex
	subscribed int
	failNext   bool
	ch         chan DMTAPIntent
	replies    []DMTAPReply
}

func newFakeDMTAPTransport() *fakeDMTAPTransport {
	return &fakeDMTAPTransport{ch: make(chan DMTAPIntent, 8)}
}

func (f *fakeDMTAPTransport) Subscribe(ctx context.Context) (<-chan DMTAPIntent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.subscribed++
	if f.failNext {
		f.failNext = false
		return nil, errors.New("subscribe failed")
	}
	return f.ch, nil
}

func (f *fakeDMTAPTransport) Reply(ctx context.Context, groupID string, r DMTAPReply) SendResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.replies = append(f.replies, r)
	return SendResult{OK: true, ProviderMessageID: "mote-1"}
}

func (f *fakeDMTAPTransport) subscribeCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.subscribed
}

func TestDMTAPEnabledIsFailClosed(t *testing.T) {
	if (&DMTAP{}).Enabled() {
		t.Error("nil transport must be disabled")
	}
	if !(&DMTAP{Transport: newFakeDMTAPTransport()}).Enabled() {
		t.Error("a real transport should enable the channel")
	}
	if (&DMTAP{Transport: NotImplementedTransport{}}).Transport == nil {
		t.Error("sanity: NotImplementedTransport is a non-nil interface value")
	}
}

func TestNotImplementedTransportFailsClosed(t *testing.T) {
	var tr DMTAPTransport = NotImplementedTransport{}
	if _, err := tr.Subscribe(context.Background()); err == nil {
		t.Error("NotImplementedTransport.Subscribe must error, never succeed")
	}
	res := tr.Reply(context.Background(), "g1", DMTAPReply{Text: "hi"})
	if res.OK {
		t.Error("NotImplementedTransport.Reply must never report OK")
	}
}

// TestDMTAPRunDispatchesIntentsToHandle proves the seam: whatever the
// transport delivers on Subscribe's channel reaches Handle, and only Handle —
// Run itself makes no authorization decision.
func TestDMTAPRunDispatchesIntentsToHandle(t *testing.T) {
	tr := newFakeDMTAPTransport()
	var mu sync.Mutex
	var seen []string
	d := &DMTAP{
		Transport: tr,
		Handle: func(ctx context.Context, intent DMTAPIntent) {
			mu.Lock()
			seen = append(seen, intent.MemberKeyName+":"+intent.Body)
			mu.Unlock()
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go d.Run(ctx)

	tr.ch <- DMTAPIntent{MemberKeyName: "alice", GroupID: "g1", Body: "open"}
	tr.ch <- DMTAPIntent{MemberKeyName: "bob", GroupID: "g1", Body: "help"}

	deadline := time.Now().Add(1 * time.Second)
	for {
		mu.Lock()
		n := len(seen)
		mu.Unlock()
		if n >= 2 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 || seen[0] != "alice:open" || seen[1] != "bob:help" {
		t.Fatalf("intents not dispatched to Handle: %v", seen)
	}
}

// TestDMTAPRunReconnectsOnSubscribeError proves Run backs off and retries
// Subscribe rather than giving up — the same resilience contract SocketMode.Run
// has for Slack.
func TestDMTAPRunReconnectsOnSubscribeError(t *testing.T) {
	tr := newFakeDMTAPTransport()
	tr.failNext = true // first Subscribe call fails
	d := &DMTAP{Transport: tr, ReconnectMin: 10 * time.Millisecond}

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	go d.Run(ctx)

	deadline := time.Now().Add(400 * time.Millisecond)
	for tr.subscribeCount() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if tr.subscribeCount() < 2 {
		t.Fatalf("Run did not retry Subscribe after a failure: %d calls", tr.subscribeCount())
	}
}

// TestDMTAPRunNoopWithoutTransport documents the fail-closed contract: Run
// must not busy-loop or panic when Transport is nil (StartChannels is
// expected to gate on Enabled() first, but Run itself must still be safe).
func TestDMTAPRunNoopWithoutTransport(t *testing.T) {
	d := &DMTAP{}
	done := make(chan struct{})
	go func() { d.Run(context.Background()); close(done) }()
	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("Run with nil Transport should return immediately")
	}
}
