// Package identity holds the controller's Ed25519 device identity. The
// keypair is generated on device at first boot; the private seed never
// leaves the device (proto/pairing.md rule 2).
package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

const seedFile = "controller_ed25519.seed"

// Identity is the controller signing identity.
type Identity struct {
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
}

// Load reads the Ed25519 seed from dir, generating one at first boot
// (0600, seed-only on disk — the public key is derived).
func Load(dir string) (*Identity, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, seedFile)
	seedHex, err := os.ReadFile(path)
	switch {
	case err == nil:
		seed, err := hex.DecodeString(string(seedHex))
		if err != nil || len(seed) != ed25519.SeedSize {
			return nil, fmt.Errorf("identity: corrupt seed file %s", path)
		}
		return FromSeed(seed), nil
	case os.IsNotExist(err):
		seed := make([]byte, ed25519.SeedSize)
		if _, err := rand.Read(seed); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, []byte(hex.EncodeToString(seed)), 0o600); err != nil {
			return nil, fmt.Errorf("identity: persist seed: %w", err)
		}
		return FromSeed(seed), nil
	default:
		return nil, err
	}
}

// FromSeed builds an Identity from a raw 32-byte Ed25519 seed (test keys).
func FromSeed(seed []byte) *Identity {
	priv := ed25519.NewKeyFromSeed(seed)
	return &Identity{priv: priv, pub: priv.Public().(ed25519.PublicKey)}
}

// Private returns the signing key.
func (id *Identity) Private() ed25519.PrivateKey { return id.priv }

// Public returns the raw public key.
func (id *Identity) Public() ed25519.PublicKey { return id.pub }

// PublicKeyB64 returns the raw public key, base64url unpadded — the wire
// format pair.redeem carries.
func (id *Identity) PublicKeyB64() string {
	return base64.RawURLEncoding.EncodeToString(id.pub)
}
