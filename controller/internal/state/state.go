// Package state persists the controller's durable pairing + runtime state:
// {device_id, gateway_pubkey, ws_url, poll_interval}, the lockdown latch,
// actuation config, and the last gateway clock sync. The gateway public key
// is PINNED: once paired, Save refuses any key change; the only sanctioned
// paths are a verified `repair` command (ApplyRepair) or a physical
// factory reset (deleting the state dir).
package state

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/vul-os/lintel/controller/internal/wire"
)

const stateFile = "state.json"

// ErrKeyChangeRefused is returned when a save would alter the pinned
// gateway key outside the repair path.
var ErrKeyChangeRefused = errors.New("state: pinned gateway key change refused (only a signed 'repair' command or factory reset may rotate it)")

// Pairing is the durable result of pair.grant.
type Pairing struct {
	DeviceID      string `json:"device_id"`
	GatewayPubkey string `json:"gateway_pubkey"` // base64url raw 32-byte Ed25519, PINNED
	WSURL         string `json:"ws_url"`
	PollInterval  int    `json:"poll_interval"`
}

type persisted struct {
	Pairing         *Pairing         `json:"pairing,omitempty"`
	Lockdown        bool             `json:"lockdown"`
	Config          map[string]int64 `json:"config,omitempty"`
	LastGatewaySync int64            `json:"last_gateway_sync,omitempty"`
	AccessPoints    []string         `json:"access_points,omitempty"`
}

// Store is the mutex-guarded durable state, written atomically (tmp+rename,
// 0600) on every mutation — fail-closed: a mutation that cannot be
// persisted returns an error and the in-memory state is rolled back.
type Store struct {
	mu   sync.Mutex
	dir  string
	data persisted
}

// Open loads (or initializes) the state in dir.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir}
	raw, err := os.ReadFile(filepath.Join(dir, stateFile))
	switch {
	case err == nil:
		if err := json.Unmarshal(raw, &s.data); err != nil {
			return nil, fmt.Errorf("state: corrupt %s: %w", stateFile, err)
		}
	case os.IsNotExist(err):
		// first boot
	default:
		return nil, err
	}
	if s.data.Config == nil {
		s.data.Config = map[string]int64{}
	}
	return s, nil
}

func (s *Store) persistLocked() error {
	raw, err := json.MarshalIndent(&s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(s.dir, stateFile+".tmp")
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.dir, stateFile))
}

// mutate applies fn and persists; on persist failure the previous state is
// restored (fail-closed).
func (s *Store) mutate(fn func(*persisted)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev := s.data
	prevCfg := make(map[string]int64, len(s.data.Config))
	for k, v := range s.data.Config {
		prevCfg[k] = v
	}
	fn(&s.data)
	if err := s.persistLocked(); err != nil {
		s.data = prev
		s.data.Config = prevCfg
		return err
	}
	return nil
}

// Dir returns the state directory.
func (s *Store) Dir() string { return s.dir }

// Pairing returns a copy of the pairing state, or nil if unpaired.
func (s *Store) Pairing() *Pairing {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Pairing == nil {
		return nil
	}
	p := *s.data.Pairing
	return &p
}

// GatewayKey returns the pinned gateway public key, or nil if unpaired.
func (s *Store) GatewayKey() ed25519.PublicKey {
	p := s.Pairing()
	if p == nil {
		return nil
	}
	pub, err := wire.DecodePub(p.GatewayPubkey)
	if err != nil {
		return nil
	}
	return pub
}

// SavePairing persists the redeem response. If already paired, any change
// to the pinned gateway key is refused (ErrKeyChangeRefused); a byte-equal
// re-pair (same key) may update ws_url/poll_interval.
func (s *Store) SavePairing(p Pairing) error {
	if _, err := wire.DecodePub(p.GatewayPubkey); err != nil {
		return fmt.Errorf("state: pair.grant gateway_pubkey invalid: %w", err)
	}
	if p.DeviceID == "" {
		return errors.New("state: pair.grant missing device_id")
	}
	s.mu.Lock()
	cur := s.data.Pairing
	if cur != nil && cur.GatewayPubkey != p.GatewayPubkey {
		s.mu.Unlock()
		return ErrKeyChangeRefused
	}
	s.mu.Unlock()
	return s.mutate(func(d *persisted) { d.Pairing = &p })
}

// ApplyRepair rotates the pinned gateway key. The caller MUST have already
// verified the `repair` command envelope against the CURRENTLY pinned key —
// this method only performs the swap.
func (s *Store) ApplyRepair(nextPubB64 string) error {
	if _, err := wire.DecodePub(nextPubB64); err != nil {
		return fmt.Errorf("state: repair next_pubkey invalid: %w", err)
	}
	return s.mutate(func(d *persisted) {
		if d.Pairing != nil {
			d.Pairing.GatewayPubkey = nextPubB64
		}
	})
}

// Lockdown reports the latched lockdown state.
func (s *Store) Lockdown() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.Lockdown
}

// SetLockdown latches/unlatches lockdown durably.
func (s *Store) SetLockdown(v bool) error {
	return s.mutate(func(d *persisted) { d.Lockdown = v })
}

// Config returns a copy of the actuation config (pulse_ms, hold_max,
// sensor_debounce_ms, …).
func (s *Store) Config() map[string]int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]int64, len(s.data.Config))
	for k, v := range s.data.Config {
		out[k] = v
	}
	return out
}

// MergeConfig applies additive config keys (proto/commands.md `config`).
func (s *Store) MergeConfig(kv map[string]int64) error {
	return s.mutate(func(d *persisted) {
		for k, v := range kv {
			d.Config[k] = v
		}
	})
}

// LastGatewaySync returns the unix time of the last gateway clock sync
// (0 = never).
func (s *Store) LastGatewaySync() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.LastGatewaySync
}

// SetLastGatewaySync records a gateway clock sync.
func (s *Store) SetLastGatewaySync(ts int64) error {
	return s.mutate(func(d *persisted) { d.LastGatewaySync = ts })
}

// AccessPoints returns the access points this controller serves.
func (s *Store) AccessPoints() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.data.AccessPoints...)
}

// SetAccessPoints persists the served access points.
func (s *Store) SetAccessPoints(aps []string) error {
	return s.mutate(func(d *persisted) { d.AccessPoints = append([]string(nil), aps...) })
}
