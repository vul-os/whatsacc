// Package agent wires the controller together: identity, durable state,
// pairing, clock, nonce store, event queue, command processor, gateway
// transport, LAN grant listener and (optionally, build-tag `ble` on Linux)
// the BLE peripheral — the same assembly for the real binary and the sim.
package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/vul-os/whatsacc/controller/internal/bleperiph"
	"github.com/vul-os/whatsacc/controller/internal/blesession"
	"github.com/vul-os/whatsacc/controller/internal/clock"
	"github.com/vul-os/whatsacc/controller/internal/command"
	"github.com/vul-os/whatsacc/controller/internal/events"
	"github.com/vul-os/whatsacc/controller/internal/grants"
	"github.com/vul-os/whatsacc/controller/internal/identity"
	"github.com/vul-os/whatsacc/controller/internal/lanserver"
	"github.com/vul-os/whatsacc/controller/internal/noncestore"
	"github.com/vul-os/whatsacc/controller/internal/pairing"
	"github.com/vul-os/whatsacc/controller/internal/relay"
	"github.com/vul-os/whatsacc/controller/internal/state"
	"github.com/vul-os/whatsacc/controller/internal/transport"
)

// Options configures an agent instance.
type Options struct {
	StateDir      string
	GatewayURL    string // needed only for first-run pairing
	ClaimToken    string // needed only for first-run pairing
	LANAddr       string // e.g. ":8737"; empty disables the LAN listener
	AccessPoints  []string
	Relay         relay.Relay // nil = mock
	Log           *slog.Logger
	AllowInsecure bool   // ws://+http:// endpoints (tests/dev)
	Firmware      string // reported in hw + boot events
	EnableBLE     bool   // requires `-tags ble` build on Linux
}

// Agent is an assembled controller.
type Agent struct {
	Opts     Options
	ID       *identity.Identity
	St       *state.Store
	Clock    *clock.Synced
	Nonces   *noncestore.Store
	Queue    *events.Queue
	Recorder *events.Recorder
	Proc     *command.Processor
	Exchange *grants.Exchange
	Relay    relay.Relay
	Log      *slog.Logger
}

// New loads/creates all durable state and assembles the agent (no I/O to
// the gateway yet).
func New(opts Options) (*Agent, error) {
	log := opts.Log
	if log == nil {
		log = slog.Default()
	}
	id, err := identity.Load(opts.StateDir)
	if err != nil {
		return nil, err
	}
	st, err := state.Open(opts.StateDir)
	if err != nil {
		return nil, err
	}
	if len(opts.AccessPoints) > 0 {
		if err := st.SetAccessPoints(opts.AccessPoints); err != nil {
			return nil, err
		}
	}
	nonces, err := noncestore.Open(opts.StateDir)
	if err != nil {
		return nil, err
	}
	queue, err := events.Open(opts.StateDir)
	if err != nil {
		return nil, err
	}
	clk := clock.NewSynced(st.LastGatewaySync(), func(ts int64) {
		if err := st.SetLastGatewaySync(ts); err != nil {
			log.Error("persist gateway sync", "err", err)
		}
	})
	rel := opts.Relay
	if rel == nil {
		rel = relay.NewMock(log)
	}
	a := &Agent{
		Opts: opts, ID: id, St: st, Clock: clk, Nonces: nonces,
		Queue: queue, Relay: rel, Log: log, Exchange: grants.NewExchange(),
	}
	deviceID := ""
	if p := st.Pairing(); p != nil {
		deviceID = p.DeviceID
	}
	a.Recorder = &events.Recorder{Priv: id.Private(), DeviceID: deviceID, Clock: clk, Queue: queue, Log: log}
	a.Proc = &command.Processor{
		Priv: id.Private(), State: st, Nonces: nonces, Clock: clk,
		Relay: rel, Events: a.Recorder, Log: log,
		SyncClock: clk.SyncFromGateway,
	}
	return a, nil
}

// EnsurePaired redeems the claim token when unpaired (first run).
func (a *Agent) EnsurePaired(ctx context.Context) error {
	if a.St.Pairing() != nil {
		return nil
	}
	if a.Opts.GatewayURL == "" || a.Opts.ClaimToken == "" {
		return errors.New("agent: unpaired — provide --gateway and --claim-token for first run")
	}
	fw := a.Opts.Firmware
	if fw == "" {
		fw = "0.1.0"
	}
	pc := &pairing.Client{AllowInsecureWS: a.Opts.AllowInsecure}
	g, err := pc.RedeemClaim(ctx, a.St, a.Opts.GatewayURL, a.Opts.ClaimToken,
		a.ID.PublicKeyB64(), pairing.HW{Model: "wacc-ref", FW: fw, Ifaces: []string{"wifi"}})
	if err != nil {
		return err
	}
	a.Recorder.DeviceID = g.DeviceID
	a.Log.Info("paired", "device_id", g.DeviceID, "ws_url", g.WSURL)
	return nil
}

// GrantEnv snapshots the controller context for a redemption decision.
func (a *Agent) GrantEnv() grants.Env {
	deviceID := ""
	if p := a.St.Pairing(); p != nil {
		deviceID = p.DeviceID
	}
	return grants.Env{
		Now:             a.Clock.Now(),
		LastGatewaySync: a.Clock.LastGatewaySync(),
		DeviceID:        deviceID,
		Lockdown:        a.St.Lockdown(),
		GatewayKey:      a.St.GatewayKey(),
		TZ:              nil, // v0 default UTC
	}
}

// OnRedeemed actuates the relay and queues the grant_redeemed +opened audit
// events for a successful offline redemption (never dropped before
// delivery — reserved queue partition).
func (a *Agent) OnRedeemed(g *grants.Grant, p *grants.Proof) {
	cfg := a.St.Config()
	pulse := int64(command.DefaultPulseMs)
	if v, ok := cfg["pulse_ms"]; ok && v > 0 {
		pulse = v
	}
	if err := a.Relay.Pulse(time.Duration(pulse) * time.Millisecond); err != nil {
		a.Log.Error("grant actuation failed", "err", err)
		a.Recorder.Record("denied", map[string]any{"reason": "hw:" + err.Error(), "ref": g.GrantID})
		return
	}
	a.Recorder.Record("grant_redeemed", map[string]any{
		"grant_id":     g.GrantID,
		"cnonce":       p.Cnonce,
		"access_point": p.AccessPoint,
		"proof_sig":    p.Sig,
	})
	a.Recorder.Record("opened", map[string]any{"cause": "grant", "ref": g.GrantID})
}

// Run pairs if needed, then runs the gateway transport, the LAN grant
// listener and (if enabled and available) the BLE peripheral until ctx ends.
func (a *Agent) Run(ctx context.Context) error {
	if err := a.EnsurePaired(ctx); err != nil {
		return err
	}
	fw := a.Opts.Firmware
	if fw == "" {
		fw = "0.1.0"
	}
	a.Recorder.Record("boot", map[string]any{"fw": fw, "reason": "start"})

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	errc := make(chan error, 3)

	if a.Opts.LANAddr != "" {
		lan := &lanserver.Server{
			DeviceID: a.Recorder.DeviceID, Exchange: a.Exchange,
			Env: a.GrantEnv, OnRedeemed: a.OnRedeemed, Log: a.Log,
		}
		go func() { errc <- lan.Serve(ctx, a.Opts.LANAddr) }()
	}
	bleEnabled := true // default on; `config` {"ble_enabled": 0} disables
	if v, ok := a.St.Config()["ble_enabled"]; ok && v == 0 {
		bleEnabled = false
	}
	if a.Opts.EnableBLE && bleEnabled {
		go func() {
			err := bleperiph.Start(ctx, bleperiph.Config{
				DeviceID: a.Recorder.DeviceID, Exchange: a.Exchange,
				Env: a.GrantEnv, OnRedeemed: blesession.Redeemed(a.OnRedeemed),
			})
			if errors.Is(err, bleperiph.ErrUnsupported) {
				a.Log.Warn("ble peripheral unavailable", "err", err)
				return
			}
			errc <- err
		}()
	}
	runner := &transport.Runner{
		Priv: a.ID.Private(), St: a.St, Proc: a.Proc, Queue: a.Queue,
		Clock: a.Clock, Log: a.Log, AllowInsecure: a.Opts.AllowInsecure,
	}
	go func() { errc <- runner.Run(ctx) }()

	select {
	case <-ctx.Done():
		return nil
	case err := <-errc:
		if err != nil && ctx.Err() == nil {
			return fmt.Errorf("agent: %w", err)
		}
		return nil
	}
}
