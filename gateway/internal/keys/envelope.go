package keys

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"
)

// Envelope is a signed command per proto/commands.md v0. sig is
// base64url(ed25519(gateway_key, JCS(envelope minus sig))).
type Envelope struct {
	V           int            `json:"v"`
	Typ         string         `json:"typ"`
	Cmd         string         `json:"cmd"`
	DeviceID    string         `json:"device_id"`
	AccessPoint string         `json:"access_point"`
	Nonce       string         `json:"nonce"`
	IAT         int64          `json:"iat"`
	EXP         int64          `json:"exp"`
	Cause       map[string]any `json:"cause,omitempty"`
	Sig         string         `json:"sig,omitempty"`
}

// MaxCommandTTL is proto/commands.md's `exp - iat ≤ 60`.
const MaxCommandTTL = 60 * time.Second

// NewNonce returns base64url(128-bit random) per the envelope spec.
func NewNonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

// signable renders the envelope minus sig as the JCS map the signature covers.
func (e *Envelope) signable() map[string]any {
	m := map[string]any{
		"v":            e.V,
		"typ":          e.Typ,
		"cmd":          e.Cmd,
		"device_id":    e.DeviceID,
		"access_point": e.AccessPoint,
		"nonce":        e.Nonce,
		"iat":          e.IAT,
		"exp":          e.EXP,
	}
	if e.Cause != nil {
		m["cause"] = e.Cause
	}
	return m
}

// SignCommand builds and signs a command envelope. ttl is clamped to
// MaxCommandTTL, fail-closed at the controller anyway.
func (k *Keys) SignCommand(cmd, deviceID, accessPoint string, ttl time.Duration, cause map[string]any) (*Envelope, error) {
	if ttl <= 0 || ttl > MaxCommandTTL {
		ttl = MaxCommandTTL
	}
	nonce, err := NewNonce()
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	e := &Envelope{
		V: 0, Typ: "cmd", Cmd: cmd,
		DeviceID: deviceID, AccessPoint: accessPoint,
		Nonce: nonce, IAT: now, EXP: now + int64(ttl/time.Second),
		Cause: cause,
	}
	msg, err := Canonicalize(e.signable())
	if err != nil {
		return nil, err
	}
	e.Sig = k.Sign(msg)
	return e, nil
}

// VerifyEnvelope checks the signature (and only the signature — expiry/nonce
// replay is the controller's fail-closed job, mirrored here for tests) of an
// envelope against a gateway public key.
func VerifyEnvelope(pub ed25519.PublicKey, e *Envelope) error {
	if e.Sig == "" {
		return fmt.Errorf("envelope: missing sig")
	}
	msg, err := Canonicalize(e.signable())
	if err != nil {
		return err
	}
	if !Verify(pub, msg, e.Sig) {
		return fmt.Errorf("envelope: bad signature")
	}
	return nil
}
