// Package noncestore is the persistent command-nonce replay store
// (proto/commands.md §Verification step 4). A nonce is remembered until its
// envelope's exp + skew has passed (after which the window check rejects it
// anyway), so the store is small and bounded — 1024 slots. If the store
// ever fills with live nonces, new commands are rejected fail-closed rather
// than evicting a live nonce. Persistence is fail-closed too: a nonce that
// cannot be durably recorded is treated as unusable and the command is
// rejected.
package noncestore

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// Capacity is the bounded number of live nonce slots.
const Capacity = 1024

// ErrFull means the store is full of live nonces; callers must reject the
// command (reported as `replay` — never evict, never "open on doubt").
var ErrFull = errors.New("noncestore: full of live nonces (fail-closed)")

// ErrPersist wraps a durable-write failure; callers must reject.
var ErrPersist = errors.New("noncestore: persist failed (fail-closed)")

const fileName = "nonces.json"

// Store is a persistent nonce→horizon map.
type Store struct {
	mu   sync.Mutex
	path string
	m    map[string]int64 // nonce → keep-until (exp + skew), unix seconds
}

// Open loads (or initializes) the store in dir. A corrupt file fails Open
// (fail-closed) rather than silently forgetting seen nonces.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, fileName), m: map[string]int64{}}
	raw, err := os.ReadFile(s.path)
	switch {
	case err == nil:
		if err := json.Unmarshal(raw, &s.m); err != nil {
			return nil, errors.New("noncestore: corrupt " + fileName)
		}
	case os.IsNotExist(err):
	default:
		return nil, err
	}
	return s, nil
}

// Seen reports whether nonce was already accepted (and is still remembered).
func (s *Store) Seen(nonce string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.m[nonce]
	return ok
}

// Mark durably records an accepted nonce with its keep-until horizon
// (envelope exp + skew). Expired entries (horizon < now) are pruned first.
// Returns ErrFull when Capacity live nonces are already held, or ErrPersist
// when the write fails — both must cause command rejection.
func (s *Store) Mark(nonce string, keepUntil, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for n, h := range s.m {
		if h < now {
			delete(s.m, n)
		}
	}
	if _, ok := s.m[nonce]; !ok && len(s.m) >= Capacity {
		return ErrFull
	}
	s.m[nonce] = keepUntil
	if err := s.persistLocked(); err != nil {
		delete(s.m, nonce)
		return errors.Join(ErrPersist, err)
	}
	return nil
}

// Len returns the number of remembered nonces (tests).
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}

func (s *Store) persistLocked() error {
	raw, err := json.Marshal(s.m)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
