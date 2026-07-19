// Package vectorfile loads the executable conformance vectors from
// proto/vectors/ (the wire truth for this repo). Used by the test suites
// and by controller-sim's demo modes. ALL KEYS IN THOSE FILES ARE PUBLIC
// TEST CONSTANTS — never use them outside conformance tests/demos.
package vectorfile

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// File is one vectors JSON document.
type File struct {
	Contract      string         `json:"contract"`
	Version       int            `json:"version"`
	SpecConstants map[string]int `json:"spec_constants"`
	Vectors       []Vector       `json:"vectors"`
}

// Vector is one conformance case (see proto/vectors/README.md).
type Vector struct {
	Name       string          `json:"name"`
	Desc       string          `json:"desc"`
	Expect     string          `json:"expect"` // "accept" | "reject" ("" for step-vectors)
	Reason     string          `json:"reason"`
	Check      Check           `json:"check"`
	Signer     string          `json:"signer"`
	Unsigned   bool            `json:"unsigned"`
	Object     json.RawMessage `json:"object"`
	Canonical  string          `json:"canonical"`
	Steps      []Step          `json:"steps"`
	Grant      *Signed         `json:"grant"`
	Transcript *Transcript     `json:"transcript"`
}

// Check is the verifier-side context.
type Check struct {
	Now             int64           `json:"now"`
	DeviceID        string          `json:"device_id"`
	AccessPoints    []string        `json:"access_points"`
	Lockdown        bool            `json:"lockdown"`
	LastGatewaySync int64           `json:"last_gateway_sync"`
	Challenge       json.RawMessage `json:"challenge"`
}

// Step is one step of a multi-message flow (replay / cnonce reuse).
type Step struct {
	Signer    string          `json:"signer"`
	Object    json.RawMessage `json:"object"`
	Canonical string          `json:"canonical"`
	Expect    string          `json:"expect"`
	Reason    string          `json:"reason"`
	Proof     *Signed         `json:"proof"`
}

// Signed is a signed object + its canonical bytes.
type Signed struct {
	Signer    string          `json:"signer"`
	Unsigned  bool            `json:"unsigned"`
	Object    json.RawMessage `json:"object"`
	Canonical string          `json:"canonical"`
}

// Transcript is a grants.json offline-redemption flow.
type Transcript struct {
	Open      *Signed         `json:"open"`
	Challenge json.RawMessage `json:"challenge"`
	Proof     *Signed         `json:"proof"`
}

// Keys is keys.json.
type Keys struct {
	Keys map[string]Key `json:"keys"`
}

// Key is one fixed test keypair.
type Key struct {
	PrivateSeedHex string `json:"private_seed_hex"`
	PublicKeyHex   string `json:"public_key_hex"`
	PublicKeyB64u  string `json:"public_key_b64u"`
}

// Seed decodes the raw 32-byte private seed.
func (k Key) Seed() ([]byte, error) { return hex.DecodeString(k.PrivateSeedHex) }

// FindDir walks up from start (or the CWD when empty) looking for
// proto/vectors.
func FindDir(start string) (string, error) {
	dir := start
	if dir == "" {
		var err error
		dir, err = os.Getwd()
		if err != nil {
			return "", err
		}
	}
	for {
		cand := filepath.Join(dir, "proto", "vectors")
		if st, err := os.Stat(cand); err == nil && st.IsDir() {
			return cand, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("vectorfile: proto/vectors not found above %s", start)
		}
		dir = parent
	}
}

// Load reads one vectors file (e.g. "commands.json") from dir.
func Load(dir, name string) (*File, error) {
	raw, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return nil, err
	}
	var f File
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("vectorfile: %s: %w", name, err)
	}
	return &f, nil
}

// LoadKeys reads keys.json from dir.
func LoadKeys(dir string) (*Keys, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "keys.json"))
	if err != nil {
		return nil, err
	}
	var k Keys
	if err := json.Unmarshal(raw, &k); err != nil {
		return nil, err
	}
	return &k, nil
}
