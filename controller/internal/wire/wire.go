// Package wire holds the lintel v0 wire types the controller speaks and
// the shared signing rule: remove `sig`, JCS-serialize (RFC 8785), sign the
// UTF-8 bytes with Ed25519; sig and all binary values are base64url without
// padding. Optional members are omitted entirely when absent (never null)
// and are covered by the signature when present. See proto/README.md.
//
// DUPLICATION NOTE: the small Sign/Verify/b64u helpers and the command
// envelope semantics are copied/adapted from gateway/internal/keys
// (keys.go + envelope.go). The controller module is standalone on purpose
// (vendored onto devices); keep both sides honest via proto/vectors/.
package wire

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/vul-os/lintel/controller/internal/jcs"
)

// Version is the contract major version this implementation speaks.
const Version = 0

// Spec constants (proto/vectors/*.json spec_constants — fixed for v0).
const (
	// ClockSkewSeconds is the ±90 s allowance applied to BOTH validity
	// bounds of commands, grants, and proof/auth timestamps.
	ClockSkewSeconds = 90
	// MaxCommandWindowSeconds is `exp − iat ≤ 60` for command envelopes.
	MaxCommandWindowSeconds = 60
	// CnonceTTLSeconds is grant.challenge / ws.challenge validity.
	CnonceTTLSeconds = 30
	// StaleClockLimitSeconds: offline (no gateway clock sync) longer than
	// 14 d = 2 × default grant TTL refuses offline redemption entirely.
	StaleClockLimitSeconds = 1209600
)

// Reject reasons — the shared cmd.ack `detail` vocabulary
// (proto/commands.md §Acknowledgement), also used by events.md `denied`
// and grants.md.
const (
	ReasonBadSig           = "badsig"
	ReasonExpired          = "expired"
	ReasonNotYetValid      = "not_yet_valid"
	ReasonWindowTooLong    = "window_too_long"
	ReasonReplay           = "replay"
	ReasonLockdown         = "lockdown"
	ReasonWrongDevice      = "wrong_device"
	ReasonWrongAccessPoint = "wrong_access_point"
	ReasonWrongGrant       = "wrong_grant"
	ReasonWindow           = "window"
	ReasonStaleClock       = "stale_clock"
	ReasonCnonceUnknown    = "cnonce_unknown"
	ReasonCnonceExpired    = "cnonce_expired"
	ReasonCnonceReplay     = "cnonce_replay"
)

// Reject is a fail-closed verification verdict carrying the machine-readable
// reason reported in the cmd.ack / denied event.
type Reject struct{ Reason string }

func (r *Reject) Error() string { return "rejected: " + r.Reason }

// B64u encodes raw bytes as base64url without padding (the wire format for
// every binary value in these contracts).
func B64u(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// UnB64u decodes unpadded base64url.
func UnB64u(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(s) }

// DecodePub decodes a raw 32-byte Ed25519 public key from its wire form.
func DecodePub(s string) (ed25519.PublicKey, error) {
	b, err := UnB64u(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("wire: bad ed25519 public key")
	}
	return ed25519.PublicKey(b), nil
}

// Sign signs msg, returning base64url (unpadded).
func Sign(priv ed25519.PrivateKey, msg []byte) string {
	return B64u(ed25519.Sign(priv, msg))
}

// Verify checks a base64url signature over msg against pub.
func Verify(pub ed25519.PublicKey, msg []byte, sigB64 string) bool {
	sig, err := UnB64u(sigB64)
	if err != nil {
		return false
	}
	return ed25519.Verify(pub, msg, sig)
}

// CanonicalMinusSig parses a raw JSON object, removes the top-level `sig`
// member, and returns the JCS canonical bytes the signature covers. Parsing
// from the raw bytes (rather than a typed struct round-trip) keeps unknown
// additive fields covered by the signature, as the contracts require.
func CanonicalMinusSig(raw []byte) (canonical []byte, sig string, err error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, "", err
	}
	sig, _ = m["sig"].(string)
	delete(m, "sig")
	canonical, err = jcs.Canonicalize(m)
	return canonical, sig, err
}

// VerifyRaw verifies the `sig` member of a raw JSON envelope against pub
// over JCS(envelope minus sig). Any parse/decode/signature failure is badsig.
func VerifyRaw(pub ed25519.PublicKey, raw []byte) error {
	canonical, sig, err := CanonicalMinusSig(raw)
	if err != nil || sig == "" || !Verify(pub, canonical, sig) {
		return &Reject{ReasonBadSig}
	}
	return nil
}

// SignMap canonicalizes the signable map, signs it, adds "sig", and returns
// the wire JSON. The signable map must not already contain "sig".
func SignMap(priv ed25519.PrivateKey, signable map[string]any) ([]byte, error) {
	canonical, err := jcs.Canonicalize(signable)
	if err != nil {
		return nil, err
	}
	signable["sig"] = Sign(priv, canonical)
	defer delete(signable, "sig")
	return json.Marshal(signable)
}

// ---- Command envelope (proto/commands.md) ----

// Command is a signed command envelope from the paired gateway. access_point
// is present only for open/hold/close; optional fields are omitted entirely
// when absent.
type Command struct {
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

// NeedsAccessPoint lists the commands that actuate a specific access point.
var NeedsAccessPoint = map[string]bool{"open": true, "hold": true, "close": true}

// LockdownAllowed is the lockdown matrix: while latched, only these commands
// are accepted (proto/commands.md §Verification step 5).
var LockdownAllowed = map[string]bool{"lift": true, "ping": true, "config": true, "repair": true}

// ---- cmd.ack (proto/commands.md §Acknowledgement) ----

// Ack is the controller-signed acknowledgement of a command.
type Ack struct {
	V        int    `json:"v"`
	Typ      string `json:"typ"` // "cmd.ack"
	DeviceID string `json:"device_id"`
	Nonce    string `json:"nonce"`
	Result   string `json:"result"` // opened|held|closed|denied|error (|ok, see README)
	Detail   string `json:"detail,omitempty"`
	TS       int64  `json:"ts"`
	Sig      string `json:"sig,omitempty"`
}

// Signable renders the ack minus sig as the map the signature covers.
func (a *Ack) Signable() map[string]any {
	m := map[string]any{
		"v":         a.V,
		"typ":       a.Typ,
		"device_id": a.DeviceID,
		"nonce":     a.Nonce,
		"result":    a.Result,
		"ts":        a.TS,
	}
	if a.Detail != "" {
		m["detail"] = a.Detail
	}
	return m
}

// SignAck signs the ack and returns its wire JSON.
func SignAck(priv ed25519.PrivateKey, a *Ack) ([]byte, error) {
	return SignMap(priv, a.Signable())
}

// ---- Event envelope (proto/events.md) ----

// Event is a controller-signed upstream event.
type Event struct {
	V        int            `json:"v"`
	Typ      string         `json:"typ"` // "event"
	EventID  string         `json:"event_id"`
	DeviceID string         `json:"device_id"`
	Kind     string         `json:"kind"`
	TS       int64          `json:"ts"`
	Data     map[string]any `json:"data"`
	Sig      string         `json:"sig,omitempty"`
}

// Signable renders the event minus sig as the map the signature covers.
func (e *Event) Signable() map[string]any {
	data := e.Data
	if data == nil {
		data = map[string]any{}
	}
	return map[string]any{
		"v":         e.V,
		"typ":       e.Typ,
		"event_id":  e.EventID,
		"device_id": e.DeviceID,
		"kind":      e.Kind,
		"ts":        e.TS,
		"data":      data,
	}
}

// SignEvent signs the event and returns its wire JSON.
func SignEvent(priv ed25519.PrivateKey, e *Event) ([]byte, error) {
	return SignMap(priv, e.Signable())
}

// ---- ws.challenge / ws.auth (proto/pairing.md) ----

// WSChallenge is the gateway's unsigned WebSocket auth challenge.
type WSChallenge struct {
	V      int    `json:"v"`
	Typ    string `json:"typ"` // "ws.challenge"
	Cnonce string `json:"cnonce"`
	IAT    int64  `json:"iat"`
	EXP    int64  `json:"exp"`
}

// WSAuthSignable renders the ws.auth message minus sig.
func WSAuthSignable(deviceID, cnonce string, ts int64) map[string]any {
	return map[string]any{
		"v":         Version,
		"typ":       "ws.auth",
		"device_id": deviceID,
		"cnonce":    cnonce,
		"ts":        ts,
	}
}

// SignWSAuth answers a ws.challenge, returning the signed ws.auth wire JSON.
func SignWSAuth(priv ed25519.PrivateKey, deviceID, cnonce string, ts int64) ([]byte, error) {
	return SignMap(priv, WSAuthSignable(deviceID, cnonce, ts))
}

// WSAuth is the parsed ws.auth message (used by the fake/sim gateway side).
type WSAuth struct {
	V        int    `json:"v"`
	Typ      string `json:"typ"`
	DeviceID string `json:"device_id"`
	Cnonce   string `json:"cnonce"`
	TS       int64  `json:"ts"`
	Sig      string `json:"sig"`
}

// VerifyWSAuth runs the gateway-side fail-closed verification of a ws.auth
// answer (proto/pairing.md §WebSocket auth): sig against the enrolled
// controller key, cnonce issued/unexpired/single-use, |ts − now| ≤ 90 s.
// The controller ships this so its simulator (and tests) can play the
// gateway role against the conformance vectors; `used` may be nil when
// single-use tracking is handled by the caller.
func VerifyWSAuth(pub ed25519.PublicKey, raw []byte, ch *WSChallenge, now int64, used map[string]bool) error {
	if err := VerifyRaw(pub, raw); err != nil {
		return err
	}
	var a WSAuth
	if err := json.Unmarshal(raw, &a); err != nil {
		return &Reject{ReasonBadSig}
	}
	if ch == nil || a.Cnonce != ch.Cnonce {
		return &Reject{ReasonCnonceUnknown}
	}
	if now > ch.EXP {
		return &Reject{ReasonCnonceExpired}
	}
	if used != nil && used[a.Cnonce] {
		return &Reject{ReasonCnonceReplay}
	}
	if a.TS < now-ClockSkewSeconds {
		return &Reject{ReasonExpired}
	}
	if a.TS > now+ClockSkewSeconds {
		return &Reject{ReasonNotYetValid}
	}
	if used != nil {
		used[a.Cnonce] = true
	}
	return nil
}
