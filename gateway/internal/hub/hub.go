// Package hub is the gateway-side device hub: the live connection registry
// (device_id → WebSocket), the ws.challenge/ws.auth handshake state, a short
// offline queue for the HTTPS long-poll fallback, and cmd.ack correlation.
//
// Everything protocol-shaped follows proto/pairing.md + proto/commands.md and
// is verified against proto/vectors/pairing.json (the hub's VerifyAuth is the
// production twin of the vector suite's reference verifier).
package hub

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/vul-os/whatsacc/gateway/internal/keys"
)

// ChallengeTTL is pairing.md's 30 s cnonce validity.
const ChallengeTTL = 30

// Challenge is one issued ws.challenge.
type Challenge struct {
	Cnonce string `json:"cnonce"`
	IAT    int64  `json:"iat"`
	EXP    int64  `json:"exp"`
}

// Wire renders the challenge as the ws.challenge message.
func (c Challenge) Wire() map[string]any {
	return map[string]any{"v": 0, "typ": "ws.challenge", "cnonce": c.Cnonce, "iat": c.IAT, "exp": c.EXP}
}

// Auth is the ws.auth answer (pairing.md).
type Auth struct {
	V        int    `json:"v"`
	Typ      string `json:"typ"`
	DeviceID string `json:"device_id"`
	Cnonce   string `json:"cnonce"`
	TS       int64  `json:"ts"`
	Sig      string `json:"sig"`
}

// Ack is a signed cmd.ack from a controller (commands.md §Acknowledgement).
type Ack struct {
	V        int    `json:"v"`
	Typ      string `json:"typ"`
	DeviceID string `json:"device_id"`
	Nonce    string `json:"nonce"`
	Result   string `json:"result"`
	Detail   string `json:"detail,omitempty"`
	TS       int64  `json:"ts"`
	Sig      string `json:"sig"`
}

// DecodePubkey parses a raw 32-byte Ed25519 public key, base64url unpadded
// (the pairing wire format). ok=false fails closed.
func DecodePubkey(b64u string) (ed25519.PublicKey, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(b64u)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, false
	}
	return ed25519.PublicKey(raw), true
}

// NewChallenge mints a ws.challenge with a fresh 128-bit cnonce.
func NewChallenge(now int64) (Challenge, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return Challenge{}, err
	}
	return Challenge{
		Cnonce: base64.RawURLEncoding.EncodeToString(b[:]),
		IAT:    now,
		EXP:    now + ChallengeTTL,
	}, nil
}

// jcsMinusSig re-canonicalizes a raw signed message, dropping sig — the
// byte string every controller signature covers.
func jcsMinusSig(raw []byte) ([]byte, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, err
	}
	delete(m, "sig")
	return keys.Canonicalize(m)
}

// VerifyAuth is the gateway-side fail-closed ws.auth check, in the pairing.md
// normative order. `consumed` reports whether ch was already answered
// (single-use: cnonce_replay). Returns "" to accept, else the reject reason
// from the shared detail vocabulary. Exercised against
// proto/vectors/pairing.json.
func VerifyAuth(controllerPub ed25519.PublicKey, raw []byte, deviceID string, ch Challenge, consumed bool, now int64) string {
	var a Auth
	if err := json.Unmarshal(raw, &a); err != nil {
		return "badsig"
	}
	if a.Typ != "ws.auth" || a.V != 0 {
		return "badsig"
	}
	msg, err := jcsMinusSig(raw)
	if err != nil || !keys.Verify(controllerPub, msg, a.Sig) {
		return "badsig"
	}
	if a.DeviceID != deviceID {
		return "wrong_device"
	}
	if a.Cnonce != ch.Cnonce {
		return "cnonce_unknown"
	}
	if now > ch.EXP {
		return "cnonce_expired"
	}
	if consumed {
		return "cnonce_replay"
	}
	if a.TS < now-keys.ClockSkewSeconds {
		return "expired"
	}
	if a.TS > now+keys.ClockSkewSeconds {
		return "not_yet_valid"
	}
	return ""
}

// VerifyFromController is the shared gateway-side check for signed
// controller uplinks (cmd.ack, event): signature against the enrolled device
// key, addressed from the expected device.
func VerifyFromController(controllerPub ed25519.PublicKey, raw []byte, deviceID string) string {
	var m struct {
		DeviceID string `json:"device_id"`
		Sig      string `json:"sig"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return "badsig"
	}
	msg, err := jcsMinusSig(raw)
	if err != nil || !keys.Verify(controllerPub, msg, m.Sig) {
		return "badsig"
	}
	if m.DeviceID != deviceID {
		return "wrong_device"
	}
	return ""
}

// ---------------------------------------------------------------------------
// Registry + dispatch
// ---------------------------------------------------------------------------

// AckOutcome is the fate of one dispatched command.
type AckOutcome struct {
	// Delivery: "acked" (controller answered), "undelivered" (connected but
	// no ack before the deadline), "queued" (offline — waiting for a poll).
	Delivery string
	Result   string // cmd.ack result when Delivery == "acked"
	Detail   string // cmd.ack detail ("" on success)
}

type queuedCmd struct {
	payload []byte
	exp     int64 // envelope exp: polls never hand out dead commands
}

type liveConn struct {
	send chan []byte
	done chan struct{}
}

type pendingAck struct {
	ch chan Ack
}

// Hub is the registry. All methods are safe for concurrent use.
type Hub struct {
	mu         sync.Mutex
	conns      map[string]*liveConn      // device_id → live WS
	queues     map[string][]queuedCmd    // device_id → offline queue (poll fallback)
	pending    map[string]*pendingAck    // envelope nonce → ack waiter
	challenges map[string]challengeState // cnonce → issued poll challenge
}

type challengeState struct {
	ch       Challenge
	deviceID string // "" until bound; polls bind at issue time
	consumed bool
}

// New builds an empty hub.
func New() *Hub {
	return &Hub{
		conns:      map[string]*liveConn{},
		queues:     map[string][]queuedCmd{},
		pending:    map[string]*pendingAck{},
		challenges: map[string]challengeState{},
	}
}

// Register installs a live connection for the device, displacing (closing)
// any previous one. Returns the outbound payload channel and a done channel
// the writer must watch (closed when displaced).
func (h *Hub) Register(deviceID string) (send <-chan []byte, done <-chan struct{}, unregister func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if old, ok := h.conns[deviceID]; ok {
		close(old.done)
	}
	c := &liveConn{send: make(chan []byte, 16), done: make(chan struct{})}
	h.conns[deviceID] = c
	// Drain anything queued while offline into the fresh connection.
	nowUnix := time.Now().Unix()
	for _, q := range h.queues[deviceID] {
		if q.exp >= nowUnix {
			select {
			case c.send <- q.payload:
			default:
			}
		}
	}
	delete(h.queues, deviceID)
	return c.send, c.done, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.conns[deviceID] == c {
			delete(h.conns, deviceID)
		}
		select {
		case <-c.done:
		default:
			close(c.done)
		}
	}
}

// Connected reports whether the device has a live connection.
func (h *Hub) Connected(deviceID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.conns[deviceID]
	return ok
}

// Dispatch sends a signed envelope to the device and waits for its cmd.ack.
// Offline devices get the payload queued (TTL = envelope exp) and "queued"
// back immediately; connected-but-silent devices yield "undelivered" after
// ackTimeout (proto: unacked past exp → undelivered).
func (h *Hub) Dispatch(ctx context.Context, deviceID string, env *keys.Envelope, ackTimeout time.Duration) AckOutcome {
	payload, err := json.Marshal(env)
	if err != nil {
		return AckOutcome{Delivery: "undelivered"}
	}

	h.mu.Lock()
	c, connected := h.conns[deviceID]
	if !connected {
		h.pruneQueueLocked(deviceID)
		h.queues[deviceID] = append(h.queues[deviceID], queuedCmd{payload: payload, exp: env.EXP})
		h.mu.Unlock()
		return AckOutcome{Delivery: "queued"}
	}
	p := &pendingAck{ch: make(chan Ack, 1)}
	h.pending[env.Nonce] = p
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.pending, env.Nonce)
		h.mu.Unlock()
	}()

	select {
	case c.send <- payload:
	default:
		// Send buffer full: treat as undelivered rather than blocking the
		// open path behind a wedged connection.
		return AckOutcome{Delivery: "undelivered"}
	}

	timer := time.NewTimer(ackTimeout)
	defer timer.Stop()
	select {
	case ack := <-p.ch:
		return AckOutcome{Delivery: "acked", Result: ack.Result, Detail: ack.Detail}
	case <-timer.C:
		return AckOutcome{Delivery: "undelivered"}
	case <-ctx.Done():
		return AckOutcome{Delivery: "undelivered"}
	}
}

// ResolveAck routes a verified cmd.ack to its waiting dispatcher. Returns
// false when no dispatch was waiting (late ack — still fine to log).
func (h *Hub) ResolveAck(a Ack) bool {
	h.mu.Lock()
	p, ok := h.pending[a.Nonce]
	h.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case p.ch <- a:
	default:
	}
	return true
}

// pruneQueueLocked drops expired queued commands. Callers hold h.mu.
func (h *Hub) pruneQueueLocked(deviceID string) {
	nowUnix := time.Now().Unix()
	q := h.queues[deviceID][:0]
	for _, c := range h.queues[deviceID] {
		if c.exp >= nowUnix {
			q = append(q, c)
		}
	}
	if len(q) == 0 {
		delete(h.queues, deviceID)
	} else {
		h.queues[deviceID] = q
	}
}

// ---------------------------------------------------------------------------
// Poll-fallback challenges (single-use, TTL'd, bound to a device)
// ---------------------------------------------------------------------------

// IssuePollChallenge mints and records a challenge for the poll flow.
func (h *Hub) IssuePollChallenge(deviceID string, now int64) (Challenge, error) {
	ch, err := NewChallenge(now)
	if err != nil {
		return Challenge{}, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	// GC expired entries opportunistically.
	for c, st := range h.challenges {
		if st.ch.EXP < now {
			delete(h.challenges, c)
		}
	}
	h.challenges[ch.Cnonce] = challengeState{ch: ch, deviceID: deviceID}
	return ch, nil
}

// ConsumePollChallenge verifies a ws.auth answer against an issued poll
// challenge, single-use. Returns "" to accept.
func (h *Hub) ConsumePollChallenge(controllerPub ed25519.PublicKey, raw []byte, deviceID string, now int64) string {
	var a Auth
	if err := json.Unmarshal(raw, &a); err != nil {
		return "badsig"
	}
	h.mu.Lock()
	st, ok := h.challenges[a.Cnonce]
	h.mu.Unlock()
	if !ok || st.deviceID != deviceID {
		// Unknown cnonce: still run full verification against a zero
		// challenge so signature errors report first (vector order), then
		// report cnonce_unknown.
		if r := VerifyAuth(controllerPub, raw, deviceID, Challenge{Cnonce: a.Cnonce, EXP: now + 1}, false, now); r != "" && r != "cnonce_expired" {
			return r
		}
		return "cnonce_unknown"
	}
	reason := VerifyAuth(controllerPub, raw, deviceID, st.ch, st.consumed, now)
	if reason != "" {
		return reason
	}
	h.mu.Lock()
	st.consumed = true
	h.challenges[a.Cnonce] = st
	h.mu.Unlock()
	return ""
}

// DrainQueue hands out (and removes) the device's pending, unexpired
// commands — the long-poll response body.
func (h *Hub) DrainQueue(deviceID string) []json.RawMessage {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.pruneQueueLocked(deviceID)
	q := h.queues[deviceID]
	delete(h.queues, deviceID)
	out := make([]json.RawMessage, 0, len(q))
	for _, c := range q {
		out = append(out, json.RawMessage(c.payload))
	}
	return out
}
