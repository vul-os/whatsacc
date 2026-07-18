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
//
// access_point is present only for open/hold/close (lockdown/lift/ping/
// config/repair carry none); optional fields are omitted entirely when
// absent — never null, never empty-string — because they are covered by the
// signature only when present (proto/vectors/README.md).
type Envelope struct {
	V           int            `json:"v"`
	Typ         string         `json:"typ"`
	Cmd         string         `json:"cmd"`
	DeviceID    string         `json:"device_id"`
	AccessPoint string         `json:"access_point,omitempty"`
	Nonce       string         `json:"nonce"`
	IAT         int64          `json:"iat"`
	EXP         int64          `json:"exp"`
	Payload     map[string]any `json:"payload,omitempty"`
	Cause       map[string]any `json:"cause,omitempty"`
	Sig         string         `json:"sig,omitempty"`
}

// MaxCommandTTL is proto/commands.md's `exp - iat ≤ 60`.
const MaxCommandTTL = 60 * time.Second

// ClockSkewSeconds is the ±90 s allowance applied to BOTH validity bounds:
// iat − skew ≤ now ≤ exp + skew (proto/commands.md §Verification step 3).
const ClockSkewSeconds = 90

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
		"v":         e.V,
		"typ":       e.Typ,
		"cmd":       e.Cmd,
		"device_id": e.DeviceID,
		"nonce":     e.Nonce,
		"iat":       e.IAT,
		"exp":       e.EXP,
	}
	if e.AccessPoint != "" {
		m["access_point"] = e.AccessPoint
	}
	if e.Payload != nil {
		m["payload"] = e.Payload
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

// VerifyEnvelope checks the signature (and only the signature — the full
// fail-closed decision is VerifyCommand) of an envelope against a gateway
// public key.
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

// Reject reasons — the shared cmd.ack `detail` vocabulary
// (proto/commands.md §Acknowledgement).
const (
	ReasonBadSig           = "badsig"
	ReasonWrongDevice      = "wrong_device"
	ReasonWrongAccessPoint = "wrong_access_point"
	ReasonWindowTooLong    = "window_too_long"
	ReasonNotYetValid      = "not_yet_valid"
	ReasonExpired          = "expired"
	ReasonReplay           = "replay"
	ReasonLockdown         = "lockdown"
)

// Reject is the fail-closed verification verdict: Reason is the
// machine-readable detail reported in the cmd.ack / denied event.
type Reject struct{ Reason string }

func (r *Reject) Error() string { return "envelope rejected: " + r.Reason }

// NonceSet is a seen-nonce store for replay protection. The zero value is
// unusable on purpose: a nil set fails closed (every command is a replay).
type NonceSet map[string]struct{}

// Seen reports whether nonce was already accepted.
func (s NonceSet) Seen(nonce string) bool {
	_, ok := s[nonce]
	return ok
}

// Mark records nonce as accepted.
func (s NonceSet) Mark(nonce string) { s[nonce] = struct{}{} }

// VerifyContext is everything the fail-closed envelope decision needs beyond
// the envelope itself (proto/commands.md §Verification).
type VerifyContext struct {
	Now          int64    // verification-time clock, unix seconds
	DeviceID     string   // the verifying controller's own device_id
	AccessPoints []string // access points this controller serves
	Lockdown     bool     // lockdown latched?
	Seen         NonceSet // accepted nonces; nil fails closed
}

// lockdownAllowed is the lockdown matrix: while latched, only these commands
// are accepted (proto/commands.md §Verification step 5).
var lockdownAllowed = map[string]bool{
	"lift": true, "ping": true, "config": true, "repair": true,
}

// needsAccessPoint lists the commands that actuate a specific access point.
var needsAccessPoint = map[string]bool{
	"open": true, "hold": true, "close": true,
}

// VerifyCommand runs the complete fail-closed controller-side verification of
// a command envelope, in the normative order (first failure wins): sig,
// device_id/access_point, window + iat/exp with ±ClockSkewSeconds on both
// bounds, nonce replay, lockdown matrix. On acceptance the nonce is recorded
// in ctx.Seen. Returns nil to actuate, or *Reject with the reported reason.
func VerifyCommand(pub ed25519.PublicKey, e *Envelope, ctx VerifyContext) error {
	// 1. Signature against the pinned gateway key.
	if err := VerifyEnvelope(pub, e); err != nil {
		return &Reject{ReasonBadSig}
	}
	// 2. Addressed to this controller, at an access point it serves.
	if e.DeviceID != ctx.DeviceID {
		return &Reject{ReasonWrongDevice}
	}
	if needsAccessPoint[e.Cmd] {
		served := false
		for _, ap := range ctx.AccessPoints {
			if ap == e.AccessPoint && ap != "" {
				served = true
				break
			}
		}
		if !served {
			return &Reject{ReasonWrongAccessPoint}
		}
	}
	// 3. Validity window: iat ≤ exp, exp − iat ≤ 60, skew on both bounds.
	if e.IAT > e.EXP || e.EXP-e.IAT > int64(MaxCommandTTL/time.Second) {
		return &Reject{ReasonWindowTooLong}
	}
	if ctx.Now < e.IAT-ClockSkewSeconds {
		return &Reject{ReasonNotYetValid}
	}
	if ctx.Now > e.EXP+ClockSkewSeconds {
		return &Reject{ReasonExpired}
	}
	// 4. Nonce never seen (nil store or empty nonce fails closed).
	if ctx.Seen == nil || e.Nonce == "" || ctx.Seen.Seen(e.Nonce) {
		return &Reject{ReasonReplay}
	}
	// 5. Lockdown matrix.
	if ctx.Lockdown && !lockdownAllowed[e.Cmd] {
		return &Reject{ReasonLockdown}
	}
	ctx.Seen.Mark(e.Nonce)
	return nil
}
