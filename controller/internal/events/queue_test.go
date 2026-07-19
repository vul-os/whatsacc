package events_test

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/vul-os/whatsacc/controller/internal/events"
)

func mustOpen(t *testing.T, dir string) *events.Queue {
	t.Helper()
	q, err := events.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	return q
}

func TestDurabilityAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	q := mustOpen(t, dir)
	for i := 0; i < 5; i++ {
		if err := q.Enqueue("opened", []byte(fmt.Sprintf(`{"event_id":"e%d"}`, i))); err != nil {
			t.Fatal(err)
		}
	}
	if err := q.Enqueue("grant_redeemed", []byte(`{"event_id":"g0"}`)); err != nil {
		t.Fatal(err)
	}
	q.Close() // simulated kill: no ack, no compact

	q2 := mustOpen(t, dir)
	defer q2.Close()
	n, g := q2.Len()
	if n != 5 || g != 1 {
		t.Fatalf("after reopen: normal=%d grant=%d", n, g)
	}
	pend := q2.Drain(100)
	if len(pend) != 6 {
		t.Fatalf("drain: %d", len(pend))
	}
	// Grants drain first (audit continuity).
	if !pend[0].Grant {
		t.Fatal("grant partition must drain first")
	}
	// Ack everything; cursor survives reopen.
	for _, p := range pend {
		if err := q2.Ack(p); err != nil {
			t.Fatal(err)
		}
	}
	q2.Close()
	q3 := mustOpen(t, dir)
	defer q3.Close()
	if n, g := q3.Len(); n != 0 || g != 0 {
		t.Fatalf("acked events resurrected: normal=%d grant=%d", n, g)
	}
}

func TestTornTailTruncated(t *testing.T) {
	dir := t.TempDir()
	q := mustOpen(t, dir)
	if err := q.Enqueue("opened", []byte(`{"event_id":"keep"}`)); err != nil {
		t.Fatal(err)
	}
	q.Close()
	// Simulate a torn write: garbage without trailing newline.
	path := filepath.Join(dir, "queue", "events.jsonl")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString(`{"seq":99,"raw":{"tr`)
	f.Close()

	q2 := mustOpen(t, dir)
	defer q2.Close()
	if n, _ := q2.Len(); n != 1 {
		t.Fatalf("torn tail handling: normal=%d", n)
	}
	// And the log keeps accepting appends afterwards.
	if err := q2.Enqueue("opened", []byte(`{"event_id":"after"}`)); err != nil {
		t.Fatal(err)
	}
	if n, _ := q2.Len(); n != 2 {
		t.Fatal("append after truncation failed")
	}
}

func TestRingDropsOldestButNeverGrants(t *testing.T) {
	dir := t.TempDir()
	q := mustOpen(t, dir)
	defer q.Close()
	q.SetSyncForTest(false) // bulk fill; durability path covered elsewhere
	normalCap := events.Capacity - events.GrantReserved
	for i := 0; i < normalCap+10; i++ {
		if err := q.Enqueue("net", []byte(fmt.Sprintf(`{"event_id":"n%d"}`, i))); err != nil {
			t.Fatal(err)
		}
	}
	n, _ := q.Len()
	if n != normalCap {
		t.Fatalf("ring did not cap: %d != %d", n, normalCap)
	}
	// Oldest were dropped: first pending normal is n10.
	pend := q.Drain(1)
	if string(pend[0].Raw) != `{"event_id":"n10"}` {
		t.Fatalf("expected n10 first, got %s", pend[0].Raw)
	}

	// Grant partition refuses to drop when full.
	for i := 0; i < events.GrantReserved; i++ {
		if err := q.Enqueue("grant_redeemed", []byte(fmt.Sprintf(`{"event_id":"g%d"}`, i))); err != nil {
			t.Fatal(err)
		}
	}
	if err := q.Enqueue("grant_redeemed", []byte(`{"event_id":"overflow"}`)); err == nil {
		t.Fatal("grant partition overflow must error, never drop")
	}
}

func TestCompact(t *testing.T) {
	dir := t.TempDir()
	q := mustOpen(t, dir)
	for i := 0; i < 10; i++ {
		if err := q.Enqueue("opened", []byte(fmt.Sprintf(`{"event_id":"c%d"}`, i))); err != nil {
			t.Fatal(err)
		}
	}
	pend := q.Drain(5)
	for _, p := range pend {
		if err := q.Ack(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := q.Compact(); err != nil {
		t.Fatal(err)
	}
	q.Close()
	q2 := mustOpen(t, dir)
	defer q2.Close()
	if n, _ := q2.Len(); n != 5 {
		t.Fatalf("after compact+reopen: %d", n)
	}
}
