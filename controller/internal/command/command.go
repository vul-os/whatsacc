// Package command implements the controller-side, fail-closed processing of
// signed command envelopes per proto/commands.md: verification in the
// normative order (sig → addressing → validity window → nonce replay →
// lockdown matrix), actuation through the relay seam, the signed cmd.ack,
// and denied/opened/closed events. Never "open on doubt".
package command

import (
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/vul-os/lintel/controller/internal/clock"
	"github.com/vul-os/lintel/controller/internal/relay"
	"github.com/vul-os/lintel/controller/internal/state"
	"github.com/vul-os/lintel/controller/internal/wire"
)

// Defaults for actuation config (overridable via the `config` command).
const (
	DefaultPulseMs  = 700
	DefaultHoldMax  = 1800
	DefaultDebounce = 50
	ResultOK        = "ok" // success result for non-actuation commands, see README
	ResultOpened    = "opened"
	ResultHeld      = "held"
	ResultClosed    = "closed"
	ResultDenied    = "denied"
	ResultError     = "error"
	DetailRepairBad = "repair_invalid" // additive detail: malformed repair payload
	DetailConfigBad = "config_invalid" // additive detail: malformed config payload
)

// NonceStore is the persistent replay store seam (internal/noncestore in
// production; a temp-dir store in tests).
type NonceStore interface {
	Seen(nonce string) bool
	// Mark durably records an accepted nonce; any error must cause
	// rejection (fail-closed).
	Mark(nonce string, keepUntil, now int64) error
}

// EventRecorder queues signed audit events (internal/events.Recorder).
type EventRecorder interface {
	Record(kind string, data map[string]any)
}

// Context is everything the fail-closed envelope decision needs beyond the
// envelope itself.
type Context struct {
	Now          int64
	DeviceID     string
	AccessPoints []string
	Lockdown     bool
	Nonces       NonceStore // nil fails closed
}

// Verify runs the complete verification of a raw command envelope in the
// normative order (first failure wins). On acceptance the nonce is durably
// recorded. Returns the parsed command, or *wire.Reject with the reported
// reason.
func Verify(pub ed25519.PublicKey, raw []byte, ctx Context) (*wire.Command, error) {
	// 1. Signature against the pinned gateway key (parse failures = badsig).
	if err := wire.VerifyRaw(pub, raw); err != nil {
		return nil, &wire.Reject{Reason: wire.ReasonBadSig}
	}
	var e wire.Command
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, &wire.Reject{Reason: wire.ReasonBadSig}
	}
	// 2. Addressed to this controller, at an access point it serves.
	if e.DeviceID != ctx.DeviceID {
		return nil, &wire.Reject{Reason: wire.ReasonWrongDevice}
	}
	if wire.NeedsAccessPoint[e.Cmd] {
		served := false
		for _, ap := range ctx.AccessPoints {
			if ap == e.AccessPoint && ap != "" {
				served = true
				break
			}
		}
		if !served {
			return nil, &wire.Reject{Reason: wire.ReasonWrongAccessPoint}
		}
	}
	// 3. Validity window: iat ≤ exp, exp − iat ≤ 60, ±90 s skew on BOTH bounds.
	if e.IAT > e.EXP || e.EXP-e.IAT > wire.MaxCommandWindowSeconds {
		return nil, &wire.Reject{Reason: wire.ReasonWindowTooLong}
	}
	if ctx.Now < e.IAT-wire.ClockSkewSeconds {
		return nil, &wire.Reject{Reason: wire.ReasonNotYetValid}
	}
	if ctx.Now > e.EXP+wire.ClockSkewSeconds {
		return nil, &wire.Reject{Reason: wire.ReasonExpired}
	}
	// 4. Nonce never seen before (nil/empty/full store fails closed).
	if ctx.Nonces == nil || e.Nonce == "" || ctx.Nonces.Seen(e.Nonce) {
		return nil, &wire.Reject{Reason: wire.ReasonReplay}
	}
	// 5. Lockdown matrix.
	if ctx.Lockdown && !wire.LockdownAllowed[e.Cmd] {
		return nil, &wire.Reject{Reason: wire.ReasonLockdown}
	}
	// Record the nonce durably; if that fails, reject fail-closed.
	if err := ctx.Nonces.Mark(e.Nonce, e.EXP+wire.ClockSkewSeconds, ctx.Now); err != nil {
		return nil, &wire.Reject{Reason: wire.ReasonReplay}
	}
	return &e, nil
}

// Processor wires verification to actuation, acks and events.
type Processor struct {
	Priv   ed25519.PrivateKey // controller signing key (acks)
	State  *state.Store
	Nonces NonceStore
	Clock  clock.Clock
	Relay  relay.Relay
	Events EventRecorder // may be nil (sim dry runs)
	Log    *slog.Logger
	// SyncClock, when non-nil, is called with the gateway's iat on every
	// accepted ping (drift correction; proto/commands.md `ping`).
	SyncClock func(ts int64)

	holdTimer *time.Timer
}

// Process verifies and executes one raw command envelope, returning the
// signed cmd.ack wire JSON. It never actuates on a failed check and always
// returns an ack (denied/error) when the envelope could be parsed at all.
func (p *Processor) Process(raw []byte) ([]byte, error) {
	log := p.Log
	if log == nil {
		log = slog.Default()
	}
	pairing := p.State.Pairing()
	if pairing == nil {
		return nil, fmt.Errorf("command: not paired")
	}
	pub := p.State.GatewayKey()
	now := p.Clock.Now()
	ctx := Context{
		Now:          now,
		DeviceID:     pairing.DeviceID,
		AccessPoints: p.State.AccessPoints(),
		Lockdown:     p.State.Lockdown(),
		Nonces:       p.Nonces,
	}
	cmd, err := Verify(pub, raw, ctx)
	if err != nil {
		reason := wire.ReasonBadSig
		if rej, ok := err.(*wire.Reject); ok {
			reason = rej.Reason
		}
		// Best-effort nonce for the ack/event ref (unverified envelope).
		var probe struct {
			Nonce string `json:"nonce"`
		}
		_ = json.Unmarshal(raw, &probe)
		log.Warn("command denied", "reason", reason, "nonce", probe.Nonce)
		p.record("denied", map[string]any{"reason": reason, "ref": probe.Nonce})
		return p.ack(pairing.DeviceID, probe.Nonce, ResultDenied, reason, now)
	}

	result, detail := p.execute(cmd, now)
	if result == ResultDenied || result == ResultError {
		p.record("denied", map[string]any{"reason": detail, "ref": cmd.Nonce})
	}
	log.Info("command", "cmd", cmd.Cmd, "result", result, "detail", detail)
	return p.ack(pairing.DeviceID, cmd.Nonce, result, detail, p.Clock.Now())
}

func (p *Processor) execute(cmd *wire.Command, now int64) (result, detail string) {
	cfg := p.State.Config()
	cfgInt := func(k string, def int64) int64 {
		if v, ok := cfg[k]; ok && v > 0 {
			return v
		}
		return def
	}
	switch cmd.Cmd {
	case "open":
		d := time.Duration(cfgInt("pulse_ms", DefaultPulseMs)) * time.Millisecond
		if err := p.Relay.Pulse(d); err != nil {
			return ResultError, "hw:" + err.Error()
		}
		p.record("opened", map[string]any{"cause": "cmd", "ref": cmd.Nonce})
		return ResultOpened, ""
	case "hold":
		if err := p.Relay.Hold(); err != nil {
			return ResultError, "hw:" + err.Error()
		}
		holdMax := cfgInt("hold_max", DefaultHoldMax)
		secs := holdMax
		if v, ok := numField(cmd.Payload, "seconds"); ok && v > 0 && v < holdMax {
			secs = v
		}
		p.scheduleRelease(time.Duration(secs) * time.Second)
		p.record("opened", map[string]any{"cause": "cmd", "ref": cmd.Nonce})
		return ResultHeld, ""
	case "close":
		p.cancelRelease()
		if err := p.Relay.Release(); err != nil {
			return ResultError, "hw:" + err.Error()
		}
		p.record("closed", map[string]any{"cause": "cmd", "ref": cmd.Nonce})
		return ResultClosed, ""
	case "lockdown":
		if err := p.State.SetLockdown(true); err != nil {
			return ResultError, "hw:persist"
		}
		return ResultOK, ""
	case "lift":
		if err := p.State.SetLockdown(false); err != nil {
			return ResultError, "hw:persist"
		}
		return ResultOK, ""
	case "ping":
		if p.SyncClock != nil {
			p.SyncClock(cmd.IAT)
		}
		return ResultOK, ""
	case "config":
		kv := map[string]int64{}
		for k, v := range cmd.Payload {
			n, ok := numField(cmd.Payload, k)
			if !ok || n < 0 {
				return ResultError, DetailConfigBad
			}
			kv[k] = n
			_ = v
		}
		if err := p.State.MergeConfig(kv); err != nil {
			return ResultError, "hw:persist"
		}
		return ResultOK, ""
	case "repair":
		next, _ := cmd.Payload["next_pubkey"].(string)
		if next == "" {
			return ResultError, DetailRepairBad
		}
		if err := p.State.ApplyRepair(next); err != nil {
			return ResultError, DetailRepairBad
		}
		return ResultOK, ""
	default:
		// Unknown commands are additive: acknowledge without actuating.
		return ResultError, "unknown_cmd"
	}
}

func (p *Processor) scheduleRelease(d time.Duration) {
	p.cancelRelease()
	p.holdTimer = time.AfterFunc(d, func() {
		if err := p.Relay.Release(); err == nil {
			p.record("closed", map[string]any{"cause": "cmd", "ref": "hold_max"})
		}
	})
}

func (p *Processor) cancelRelease() {
	if p.holdTimer != nil {
		p.holdTimer.Stop()
		p.holdTimer = nil
	}
}

func (p *Processor) record(kind string, data map[string]any) {
	if p.Events != nil {
		p.Events.Record(kind, data)
	}
}

func (p *Processor) ack(deviceID, nonce, result, detail string, ts int64) ([]byte, error) {
	return wire.SignAck(p.Priv, &wire.Ack{
		V: wire.Version, Typ: "cmd.ack",
		DeviceID: deviceID, Nonce: nonce,
		Result: result, Detail: detail, TS: ts,
	})
}

// numField extracts an integral number from a decoded JSON payload map.
func numField(m map[string]any, k string) (int64, bool) {
	switch v := m[k].(type) {
	case float64:
		return int64(v), true
	case json.Number:
		n, err := v.Int64()
		return n, err == nil
	case int64:
		return v, true
	default:
		return 0, false
	}
}
