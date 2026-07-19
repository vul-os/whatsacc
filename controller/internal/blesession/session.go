// Package blesession is the transport-agnostic BLE redemption session:
// framing.Reassembler on the rx side, framing.Chunk on the tx side, and the
// shared grants.Exchange verification core in the middle (the SAME core the
// LAN listener uses — no duplicated verification logic). The radio layer
// (build tag `ble`) and the simulator's in-memory transport both drive this.
//
// Sequence (proto/grants.md §BLE GATT): app writes grant.open → controller
// notifies grant.challenge → app writes grant.proof → controller notifies
// grant.result → controller drops the connection (after result or timeout).
// BLE pairing/bonding is NOT used or trusted; the Ed25519 message layer
// carries all authority.
package blesession

import (
	"encoding/json"
	"log/slog"

	"github.com/vul-os/whatsacc/controller/internal/framing"
	"github.com/vul-os/whatsacc/controller/internal/grants"
	"github.com/vul-os/whatsacc/controller/internal/wire"
)

// Conn is the minimal link the session needs: notify frames to the app
// (implementations chunk to their MTU) and drop the connection.
type Conn interface {
	// SendMessage transmits one logical message (the impl frames+chunks it).
	SendMessage(msg []byte) error
	// Close drops the connection.
	Close() error
}

// Redeemed is invoked on a successful offline redemption: actuate the
// relay and queue the grant_redeemed audit event.
type Redeemed func(g *grants.Grant, p *grants.Proof)

// Session is one BLE central's redemption exchange.
type Session struct {
	X          *grants.Exchange
	Env        func() grants.Env // controller context at message time
	Conn       Conn
	OnRedeemed Redeemed
	Log        *slog.Logger

	reasm   *framing.Reassembler
	sawOpen bool
	done    bool
}

// New builds a session for one connection.
func New(x *grants.Exchange, env func() grants.Env, conn Conn, onRedeemed Redeemed, log *slog.Logger) *Session {
	if log == nil {
		log = slog.Default()
	}
	return &Session{X: x, Env: env, Conn: conn, OnRedeemed: onRedeemed, Log: log, reasm: framing.NewReassembler()}
}

// AbortPartial drops any partial rx frame (new exchange / reconnect).
func (s *Session) AbortPartial() { s.reasm.Abort() }

// HandleChunk consumes one rx write. It returns true when the session is
// finished and the connection should be dropped (result sent, frame error,
// or protocol violation) — fail-closed: any error path ends the session.
func (s *Session) HandleChunk(chunk []byte) bool {
	if s.done {
		return true
	}
	msgs, err := s.reasm.Push(chunk)
	if err != nil {
		// frame_too_large: deny with reason, then drop.
		s.sendResult(&grants.Result{V: wire.Version, Typ: "grant.result", Result: "denied", Detail: "frame_too_large"})
		return s.finish()
	}
	for _, msg := range msgs {
		if s.handleMessage(msg) {
			return true
		}
	}
	return s.done
}

func (s *Session) handleMessage(msg []byte) bool {
	var probe struct {
		Typ string `json:"typ"`
	}
	if err := json.Unmarshal(msg, &probe); err != nil {
		s.sendResult(&grants.Result{V: wire.Version, Typ: "grant.result", Result: "denied", Detail: wire.ReasonBadSig})
		return s.finish()
	}
	switch probe.Typ {
	case "grant.open":
		// A fresh open (even mid-exchange) starts a new challenge.
		ch, err := s.X.HandleOpen(msg, s.Env())
		if err != nil {
			s.sendResult(&grants.Result{V: wire.Version, Typ: "grant.result", Result: "denied", Detail: wire.ReasonBadSig})
			return s.finish()
		}
		s.sawOpen = true
		raw, _ := json.Marshal(ch)
		if err := s.Conn.SendMessage(raw); err != nil {
			return s.finish()
		}
		return false
	case "grant.proof":
		if !s.sawOpen {
			s.sendResult(&grants.Result{V: wire.Version, Typ: "grant.result", Result: "denied", Detail: wire.ReasonCnonceUnknown})
			return s.finish()
		}
		res, g, p := s.X.HandleProof(msg, s.Env())
		if res.Result == "opened" && s.OnRedeemed != nil {
			s.OnRedeemed(g, p)
		}
		s.sendResult(res)
		return s.finish()
	default:
		s.sendResult(&grants.Result{V: wire.Version, Typ: "grant.result", Result: "denied", Detail: wire.ReasonBadSig})
		return s.finish()
	}
}

func (s *Session) sendResult(r *grants.Result) {
	raw, err := json.Marshal(r)
	if err != nil {
		return
	}
	if err := s.Conn.SendMessage(raw); err != nil {
		s.Log.Debug("ble result send failed", "err", err)
	}
}

func (s *Session) finish() bool {
	s.done = true
	_ = s.Conn.Close()
	return true
}
