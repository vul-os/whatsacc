package noncestore_test

import (
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/vul-os/whatsacc/controller/internal/noncestore"
)

func TestPersistenceAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	s, err := noncestore.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Mark("nonce-a", 2000, 1000); err != nil {
		t.Fatal(err)
	}
	s2, err := noncestore.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !s2.Seen("nonce-a") {
		t.Fatal("nonce forgotten across reopen — replay window broken")
	}
}

func TestFullFailsClosedAndPrunes(t *testing.T) {
	dir := t.TempDir()
	s, err := noncestore.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := int64(1000)
	for i := 0; i < noncestore.Capacity; i++ {
		if err := s.Mark(fmt.Sprintf("live-%d", i), now+500, now); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Mark("one-more", now+500, now); !errors.Is(err, noncestore.ErrFull) {
		t.Fatalf("expected ErrFull, got %v", err)
	}
	// Once the horizon passes, expired entries are pruned and slots free up.
	later := now + 1000
	if err := s.Mark("fresh-after-expiry", later+500, later); err != nil {
		t.Fatalf("expected pruning to free a slot: %v", err)
	}
	if s.Len() != 1 {
		t.Fatalf("expected 1 live nonce after pruning, got %d", s.Len())
	}
}

func TestCorruptFileFailsClosed(t *testing.T) {
	dir := t.TempDir()
	s, err := noncestore.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Mark("x", 10, 1)
	// Corrupt the file.
	if err := os.WriteFile(dir+"/nonces.json", []byte("{corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := noncestore.Open(dir); err == nil {
		t.Fatal("corrupt nonce store must fail Open (fail-closed)")
	}
}
