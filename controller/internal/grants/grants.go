// Package grants implements offline grant redemption per proto/grants.md:
// the gateway pre-issues a signed statement of a member's rights; this
// controller verifies it offline against its pinned gateway key, fail-closed,
// in the normative 11-step order. The verification core is transport-agnostic
// — the LAN HTTP listener, the BLE session layer and the simulator all drive
// the same Exchange (no duplicated verification logic).
package grants

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/vul-os/lintel/controller/internal/clock"
	"github.com/vul-os/lintel/controller/internal/wire"
)

// Grant is the gateway-signed statement of a member's rights.
type Grant struct {
	V            int      `json:"v"`
	Typ          string   `json:"typ"` // "grant"
	GrantID      string   `json:"grant_id"`
	Member       string   `json:"member"`
	AppPubkey    string   `json:"app_pubkey"`
	Devices      []string `json:"devices"`
	AccessPoints []string `json:"access_points"`
	Windows      []Window `json:"windows"`
	IAT          int64    `json:"iat"`
	EXP          int64    `json:"exp"`
	Sig          string   `json:"sig"`
}

// Window is a weekly access window: days is an inclusive range of
// mon|tue|wed|thu|fri|sat|sun in week order, no wrap-around; from/to are
// "HH:MM" with to exclusive and "24:00" meaning end of day.
type Window struct {
	Days string `json:"days"`
	From string `json:"from"`
	To   string `json:"to"`
}

// Open is the app's grant.open request. The grant is kept raw so its
// signature is verified over the exact presented bytes.
type Open struct {
	V           int             `json:"v"`
	Typ         string          `json:"typ"` // "grant.open"
	Grant       json.RawMessage `json:"grant"`
	AccessPoint string          `json:"access_point"`
}

// Challenge is the controller's grant.challenge (cnonce, 30 s validity).
type Challenge struct {
	V      int    `json:"v"`
	Typ    string `json:"typ"` // "grant.challenge"
	Cnonce string `json:"cnonce"`
	IAT    int64  `json:"iat"`
	EXP    int64  `json:"exp"`
}

// Proof is the app-signed grant.proof.
type Proof struct {
	V           int    `json:"v"`
	Typ         string `json:"typ"` // "grant.proof"
	GrantID     string `json:"grant_id"`
	Cnonce      string `json:"cnonce"`
	AccessPoint string `json:"access_point"`
	TS          int64  `json:"ts"`
	Sig         string `json:"sig"`
}

// Result is the controller's grant.result reply. detail carries the reject
// reason (cmd.ack vocabulary) and is omitted on success.
type Result struct {
	V      int    `json:"v"`
	Typ    string `json:"typ"`    // "grant.result"
	Result string `json:"result"` // "opened" | "denied"
	Detail string `json:"detail,omitempty"`
}

// Env is the controller-side context for a redemption decision.
type Env struct {
	Now             int64
	LastGatewaySync int64
	DeviceID        string
	Lockdown        bool
	GatewayKey      ed25519.PublicKey
	// TZ is the controller's configured timezone for window evaluation
	// (nil = UTC, the v0 default).
	TZ *time.Location
}

// pending is one issued challenge awaiting its proof.
type pending struct {
	openRaw     json.RawMessage // grant as presented
	accessPoint string
	challenge   Challenge
}

// Exchange tracks issued cnonces (single-use, 30 s) and runs the
// fail-closed verification. One Exchange serves all transports.
type Exchange struct {
	mu      sync.Mutex
	pending map[string]*pending
	used    map[string]int64 // cnonce → challenge exp (kept until expiry for cnonce_replay)
	// NewCnonce is overridable in tests; defaults to 128-bit random.
	NewCnonce func() (string, error)
}

// NewExchange builds an empty exchange table.
func NewExchange() *Exchange {
	return &Exchange{
		pending: map[string]*pending{},
		used:    map[string]int64{},
		NewCnonce: func() (string, error) {
			var b [16]byte
			if _, err := rand.Read(b[:]); err != nil {
				return "", err
			}
			return wire.B64u(b[:]), nil
		},
	}
}

// HandleOpen accepts a raw grant.open and issues a grant.challenge. Deep
// verification happens at proof time (single-fault reasons per the vectors);
// only structural validity is required here.
func (x *Exchange) HandleOpen(raw []byte, env Env) (*Challenge, error) {
	var o Open
	if err := json.Unmarshal(raw, &o); err != nil || o.Typ != "grant.open" || len(o.Grant) == 0 {
		return nil, fmt.Errorf("grants: malformed grant.open")
	}
	cn, err := x.NewCnonce()
	if err != nil {
		return nil, err
	}
	ch := Challenge{V: wire.Version, Typ: "grant.challenge", Cnonce: cn,
		IAT: env.Now, EXP: env.Now + wire.CnonceTTLSeconds}
	x.mu.Lock()
	x.gcLocked(env.Now)
	x.pending[cn] = &pending{openRaw: o.Grant, accessPoint: o.AccessPoint, challenge: ch}
	x.mu.Unlock()
	return &ch, nil
}

// InjectChallenge registers an externally fixed challenge for a presented
// open (conformance-vector replays and the sim's offline demo).
func (x *Exchange) InjectChallenge(o *Open, ch Challenge) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.pending[ch.Cnonce] = &pending{openRaw: o.Grant, accessPoint: o.AccessPoint, challenge: ch}
}

// HandleProof runs the fail-closed verification of a raw grant.proof against
// the pending exchange and returns the grant.result. On success the pending
// entry is consumed (single-use) and the verified grant is returned for
// actuation/audit.
func (x *Exchange) HandleProof(raw []byte, env Env) (*Result, *Grant, *Proof) {
	deny := func(reason string) (*Result, *Grant, *Proof) {
		return &Result{V: wire.Version, Typ: "grant.result", Result: "denied", Detail: reason}, nil, nil
	}
	var p Proof
	if err := json.Unmarshal(raw, &p); err != nil || p.Typ != "grant.proof" {
		return deny(wire.ReasonBadSig)
	}
	x.mu.Lock()
	pe := x.pending[p.Cnonce]
	_, wasUsed := x.used[p.Cnonce]
	x.mu.Unlock()

	// 1. Stale-clock rule (fixed 14 d constant, not derived from the grant).
	// clock.Stale also catches a wall clock reset BACKWARD past
	// LastGatewaySync (RTC-less reboot) — a plain "elapsed > limit" check
	// misses that case (negative elapsed never trips ">"), and this path
	// used to rely on luck: the grant's own iat/exp window happened to
	// reject the same bad "now" independently (proto/events.md "Clock
	// after a power cut").
	if clock.Stale(env.Now, env.LastGatewaySync, wire.StaleClockLimitSeconds) {
		return deny(wire.ReasonStaleClock)
	}
	// 2. Not in lockdown.
	if env.Lockdown {
		return deny(wire.ReasonLockdown)
	}
	// Steps 3-9 need the presented grant; an unknown/used cnonce means we
	// have no exchange context — but the normative order still checks the
	// grant first, so we resolve the pending entry for it and fall through
	// to the cnonce checks (step 10) when absent only after grant checks
	// cannot proceed. A replayed cnonce keeps its grant context for
	// single-fault reporting.
	var g Grant
	var grantRaw json.RawMessage
	var requestedAP string
	var ch Challenge
	switch {
	case pe != nil:
		grantRaw, requestedAP, ch = pe.openRaw, pe.accessPoint, pe.challenge
	case wasUsed:
		return deny(wire.ReasonCnonceReplay)
	default:
		return deny(wire.ReasonCnonceUnknown)
	}
	if err := json.Unmarshal(grantRaw, &g); err != nil {
		return deny(wire.ReasonBadSig)
	}
	// 3. grant.sig against the pinned gateway key.
	if err := wire.VerifyRaw(env.GatewayKey, grantRaw); err != nil {
		return deny(wire.ReasonBadSig)
	}
	// 4. grant.iat − 90 ≤ now ≤ grant.exp + 90.
	if env.Now < g.IAT-wire.ClockSkewSeconds {
		return deny(wire.ReasonNotYetValid)
	}
	if env.Now > g.EXP+wire.ClockSkewSeconds {
		return deny(wire.ReasonExpired)
	}
	// 5. Own device_id ∈ grant.devices.
	if !contains(g.Devices, env.DeviceID) {
		return deny(wire.ReasonWrongDevice)
	}
	// 6. Requested access_point ∈ grant.access_points and equals proof's.
	if !contains(g.AccessPoints, requestedAP) || p.AccessPoint != requestedAP {
		return deny(wire.ReasonWrongAccessPoint)
	}
	// 7. now falls inside one of grant.windows.
	if !InAnyWindow(g.Windows, env.Now, env.TZ) {
		return deny(wire.ReasonWindow)
	}
	// 8. proof.grant_id equals grant.grant_id.
	if p.GrantID != g.GrantID {
		return deny(wire.ReasonWrongGrant)
	}
	// 9. proof.sig against grant.app_pubkey.
	appPub, err := wire.DecodePub(g.AppPubkey)
	if err != nil {
		return deny(wire.ReasonBadSig)
	}
	if err := wire.VerifyRaw(appPub, raw); err != nil {
		return deny(wire.ReasonBadSig)
	}
	// 10. cnonce issued (checked above), unexpired, single-use.
	if env.Now > ch.EXP {
		return deny(wire.ReasonCnonceExpired)
	}
	// 11. |proof.ts − now| ≤ 90.
	if p.TS < env.Now-wire.ClockSkewSeconds {
		return deny(wire.ReasonExpired)
	}
	if p.TS > env.Now+wire.ClockSkewSeconds {
		return deny(wire.ReasonNotYetValid)
	}
	// Consume the cnonce (single-use), remembered until expiry + skew.
	x.mu.Lock()
	delete(x.pending, p.Cnonce)
	x.used[p.Cnonce] = ch.EXP + wire.ClockSkewSeconds
	x.mu.Unlock()
	return &Result{V: wire.Version, Typ: "grant.result", Result: "opened"}, &g, &p
}

// gcLocked drops expired pending/used entries (bounded tables).
func (x *Exchange) gcLocked(now int64) {
	for cn, pe := range x.pending {
		if now > pe.challenge.EXP+wire.ClockSkewSeconds {
			delete(x.pending, cn)
		}
	}
	for cn, exp := range x.used {
		if now > exp {
			delete(x.used, cn)
		}
	}
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s && s != "" {
			return true
		}
	}
	return false
}

// InAnyWindow evaluates the grant windows against the controller's
// gateway-synced clock in tz (nil = UTC).
func InAnyWindow(ws []Window, now int64, tz *time.Location) bool {
	if tz == nil {
		tz = time.UTC
	}
	t := time.Unix(now, 0).In(tz)
	day := weekdayIndex(t.Weekday())
	minute := t.Hour()*60 + t.Minute()
	for _, w := range ws {
		lo, hi, ok := parseDays(w.Days)
		if !ok || day < lo || day > hi {
			continue
		}
		from, ok1 := parseHM(w.From)
		to, ok2 := parseHM(w.To)
		if !ok1 || !ok2 {
			continue
		}
		if minute >= from && minute < to { // `to` exclusive; 24:00 = 1440
			return true
		}
	}
	return false
}

var dayNames = []string{"mon", "tue", "wed", "thu", "fri", "sat", "sun"}

// weekdayIndex maps Go's Sunday-first weekday to the contract's mon..sun 0..6.
func weekdayIndex(d time.Weekday) int { return (int(d) + 6) % 7 }

// parseDays parses "mon-fri" / "sat" style inclusive ranges in week order,
// no wrap-around.
func parseDays(s string) (lo, hi int, ok bool) {
	idx := func(name string) int {
		for i, d := range dayNames {
			if d == name {
				return i
			}
		}
		return -1
	}
	if a, b, found := strings.Cut(s, "-"); found {
		lo, hi = idx(a), idx(b)
	} else {
		lo = idx(s)
		hi = lo
	}
	return lo, hi, lo >= 0 && hi >= lo
}

// parseHM parses "HH:MM" into minutes since midnight; "24:00" = 1440.
func parseHM(s string) (int, bool) {
	if len(s) != 5 || s[2] != ':' {
		return 0, false
	}
	h := int(s[0]-'0')*10 + int(s[1]-'0')
	m := int(s[3]-'0')*10 + int(s[4]-'0')
	if s[0] < '0' || s[0] > '9' || s[1] < '0' || s[1] > '9' || s[3] < '0' || s[3] > '9' || s[4] < '0' || s[4] > '9' {
		return 0, false
	}
	if h == 24 && m == 0 {
		return 1440, true
	}
	if h > 23 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}
