package channels

// DMTAP — a dial-out DialChannel scaffold for the founder's own decentralized
// messaging protocol (spec: /Users/pc/code/vulos/dmtap, reference
// implementation: /Users/pc/code/vulos/envoir). Attractive here because a
// DMTAP MOTE is MLS-authenticated end to end: an "open" command signed by the
// member's own identity key, no third party in the path, no per-message cost
// or template/window restriction (unlike WhatsApp outbound).
//
// HONEST STATUS (investigated 2026-07-20, github.com/vul-os/envoir/bindings/go
// as of that date): there is NO working DMTAP transport behind this channel.
// This file is structurally complete against the DialChannel seam — Kind /
// Enabled / Run, backoff-and-reconnect, the same Handle-callback shape
// socketmode.go uses — but DMTAPTransport, the interface a real
// implementation plugs into, has exactly one implementation in this
// codebase: NotImplementedTransport, which always fails closed. Nothing here
// pretends otherwise: Enabled() is false unless a real Transport is injected,
// and main.go never constructs one, so the DMTAP channel does not run in the
// shipped binary today.
//
// Why not: the Go binding at github.com/vul-os/envoir/bindings/go (wazero,
// pure Go, no cgo) wraps ONLY the dmtap-sync crate — the CRDT sync algebra
// (HLC clocks, the six-kind op algebra, COSE_Sign1 signing/verification,
// observable-state snapshots, version vectors, range-Merkle reconciliation).
// Its own README says so explicitly, and its dispatch table (bindings/go/api.go)
// confirms it: every exported method is Value/Op/Clock/Engine/Snapshot/
// FastJoin/Reconcile-shaped. There is no MOTE, no MLS, no identity resolution,
// no network I/O of any kind — the wasm module itself imports NOTHING (no
// WASI, no clock, no filesystem, no randomness; that is a deliberate,
// tested security property of that package, not an oversight). It cannot
// send or receive a message because it was never asked to.
//
// The messaging primitives DO exist, but only in Rust with no Go binding:
//   - dmtap-core (envoir/crates/dmtap-core): MOTE construction + HPKE sealing.
//   - dmtap-mls (envoir/crates/dmtap-mls): the actual MLS group sessions —
//     this is where "signed by the member's own identity key" would come from.
//   - the envoir-node reference daemon (envoir/node/src/{send_api,jmap_api}.rs):
//     a running node exposes an HTTP Send API (POST /v1/send) and a JMAP
//     surface, but send_api.rs is a Resend-style outbound MAIL send (subject +
//     body to a resolved recipient address) built on dmtap-send, not a group
//     chat/command protocol, and it has no Go client here either.
//
// Two honest paths forward, neither started:
//   (a) a second wazero binding, alongside bindings/go, exposing MOTE
//       construction/sealing and MLS group operations the same in-process way
//       dmtap-sync is exposed now; or
//   (b) an HTTP client dialing a locally-run `envoir-node` daemon's Send API /
//       JMAP surface — the same shape HTTPWhatsAppSender/HTTPSlackSender/
//       HTTPTelegramSender already use for their providers — plus a poller or
//       push subscription for inbound, and a real mapping from "MOTE in an
//       access-control group" to "signed open command" that does not exist in
//       the protocol today (DMTAP is generic messaging, not gate commands).
//
// TODO(dmtap): when either lands, write the real DMTAPTransport here (or in a
// new file) and wire it into httpapi.Config.DMTAPTransport (server.go) —
// nothing else in this file or in httpapi/channels_dmtap.go should need to
// change; that is the point of the seam.

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/vul-os/lintel/gateway/internal/store"
)

// DMTAPIntent is one inbound, already-authenticated request from a DMTAP
// group member — the transport's job is to hand this over only once it has
// verified the MLS signature; this package trusts it as the webhook Channel
// implementations trust a passed Verify check.
type DMTAPIntent struct {
	// MemberKeyName identifies the sender in DMTAP's own identity space (the
	// 8-word key-name, or the raw identity-key material a real transport
	// resolves it from). This is the channel_identities.external_id value for
	// KindDMTAP, exactly as a Slack/Telegram user id is for their channels.
	MemberKeyName string
	// GroupID identifies which DMTAP group/conversation the MOTE arrived on —
	// the channel_chats.external_key value for KindDMTAP.
	GroupID string
	// Body is the plaintext command text, already MLS-decrypted by the
	// transport. This package never sees ciphertext.
	Body string
	// IntentID, if non-empty, is a stable dedupe key (e.g. the MOTE's
	// content-address) — mirrors WAMessage.ID / TGMessage.MessageID. Empty
	// means the transport gives no redelivery guard; the httpapi handler
	// then does not dedupe (a real transport should set this).
	IntentID string
	// TimestampMs is the intent's own clock, milliseconds since epoch.
	TimestampMs int64
}

// DMTAPReply is one outbound reply to send back into a DMTAP group. DMTAP has
// no interactive-UI concept in the spec today (unlike WhatsApp lists / Slack
// blocks / Telegram inline keyboards) — plaintext only.
type DMTAPReply struct {
	Text string
}

// DMTAPTransport is the seam a real DMTAP binding plugs into. It owns
// EVERYTHING protocol-specific: the MLS group session, MOTE sealing /
// unsealing, mesh delivery — exactly the separation SocketConn draws for the
// Slack WebSocket. This package (and the httpapi handler that drives it)
// knows nothing about DMTAP wire format, key-names, or MOTE encoding.
//
// See the TODO(dmtap) at the top of this file: no implementation of this
// interface exists yet other than NotImplementedTransport.
type DMTAPTransport interface {
	// Subscribe opens (or maintains) the live, MLS-authenticated session and
	// delivers inbound intents on the returned channel until ctx is
	// cancelled or an unrecoverable error occurs (signalled by closing the
	// channel and/or returning an error from a subsequent read — see DMTAP.Run).
	// Called again with backoff after the previous session ends, exactly like
	// SocketMode reconnecting to Slack.
	Subscribe(ctx context.Context) (<-chan DMTAPIntent, error)
	// Reply seals and sends a plaintext reply back into the named group.
	// Errors are reported via SendResult, never as a panic or fatal error —
	// matches every other channel's sender contract (send.go).
	Reply(ctx context.Context, groupID string, reply DMTAPReply) SendResult
}

// errDMTAPNotImplemented is the fixed error/reason NotImplementedTransport
// returns — never "success", never silent.
var errDMTAPNotImplemented = errors.New("dmtap: no transport implementation wired (see the TODO(dmtap) note in gateway/internal/channels/dmtap.go)")

// NotImplementedTransport is the only DMTAPTransport this codebase ships. It
// fails closed on every call: Subscribe always errors (so DMTAP.Run backs off
// and never claims a live session), Reply always reports failure. It exists
// so wiring a DMTAP channel in has somewhere honest to point before a real
// transport exists — never a silent no-op that could be mistaken for "it
// works, just quietly does nothing."
type NotImplementedTransport struct{}

func (NotImplementedTransport) Subscribe(context.Context) (<-chan DMTAPIntent, error) {
	return nil, errDMTAPNotImplemented
}

func (NotImplementedTransport) Reply(context.Context, string, DMTAPReply) SendResult {
	return SendResult{Error: "dmtap_transport_not_implemented"}
}

// DMTAP is the dial-out channel value (channels.DialChannel). Transport is
// the only thing that makes it real; a nil Transport means Enabled() is
// false, fail-closed — Run must not be, and StartChannels will not, launch it.
type DMTAP struct {
	Transport DMTAPTransport

	// Handle processes one inbound intent, reused across reconnects. Set by
	// the httpapi layer exactly as SocketMode.Handle is (see server.go /
	// httpapi/channels_dmtap.go). Handle must fail closed: it may only ever
	// deliver an intent into the shared open-path choke point
	// (store.LogAccess → sign → hub dispatch) — never decide a verdict itself.
	Handle func(ctx context.Context, intent DMTAPIntent)

	Logger       *slog.Logger
	ReconnectMin time.Duration // backoff floor (default 1s, matches SocketMode)
}

var _ DialChannel = (*DMTAP)(nil)

// Kind identifies this as the DMTAP dial-out channel.
func (*DMTAP) Kind() string { return KindDMTAP }

// Enabled reports whether a real transport is configured. Fail-closed: a nil
// Transport (the zero value, and NotImplementedTransport's caller must set it
// explicitly) is disabled.
func (d *DMTAP) Enabled() bool { return d.Transport != nil }

func (d *DMTAP) log() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

func (d *DMTAP) reconnectMin() time.Duration {
	if d.ReconnectMin > 0 {
		return d.ReconnectMin
	}
	return time.Second
}

// Run maintains the DMTAP subscription until ctx is cancelled, reconnecting
// with the same capped backoff SocketMode.Run uses. Intended to be launched
// in its own goroutine by StartChannels. A no-op (returns immediately) when
// Transport is nil — callers should gate on Enabled() first, exactly as
// StartChannels does for every DialChannel.
func (d *DMTAP) Run(ctx context.Context) {
	if d.Transport == nil {
		return
	}
	backoff := d.reconnectMin()
	for {
		if ctx.Err() != nil {
			return
		}
		if err := d.serveOnce(ctx); err != nil && ctx.Err() == nil {
			d.log().Warn("dmtap subscription ended", "err", err, "retry_in", backoff)
			if !sleepCtx(ctx, backoff) {
				return
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = d.reconnectMin()
		if !sleepCtx(ctx, d.reconnectMin()) {
			return
		}
	}
}

// serveOnce opens one subscription and drains it until the channel closes or
// ctx is cancelled.
func (d *DMTAP) serveOnce(ctx context.Context) error {
	intents, err := d.Transport.Subscribe(ctx)
	if err != nil {
		return err
	}
	for {
		select {
		case intent, ok := <-intents:
			if !ok {
				return errors.New("dmtap: subscription channel closed")
			}
			if d.Handle != nil {
				d.Handle(ctx, intent)
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// ---------------------------------------------------------------------------
// Reply rendering (plaintext only — DMTAP has no interactive-UI concept)
// ---------------------------------------------------------------------------

// DMTAPMenu is the help/greeting text.
func DMTAPMenu(profileName string) string {
	hello := "Welcome to lintel."
	if profileName != "" {
		hello = "Hi " + profileName + "."
	}
	return hello + "\n\nSend \"open\" to open your linked gates, or name one directly (e.g. \"open the side gate\")."
}

// DMTAPGateList renders the gate picker as a plain numbered list — backend
// equivalent of PushGateMenu/TelegramGateKeyboard, but text-only.
func DMTAPGateList(gates []store.AvailableAP) string {
	var b strings.Builder
	for i, g := range gates {
		if i == 10 {
			break
		}
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(itoa(int64(i + 1)))
		b.WriteString(". ")
		b.WriteString(g.APName)
		if g.LocName != "" {
			b.WriteString(" (")
			b.WriteString(g.LocName)
			b.WriteString(")")
		}
	}
	return b.String()
}
