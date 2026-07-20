package transport

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"net/url"
	"time"

	"github.com/vul-os/lintel/controller/internal/clock"
	"github.com/vul-os/lintel/controller/internal/command"
	"github.com/vul-os/lintel/controller/internal/events"
	"github.com/vul-os/lintel/controller/internal/state"
	"github.com/vul-os/lintel/controller/internal/wire"
)

// Runner keeps the controller connected to its gateway: outbound WSS with
// challenge/response auth and jittered backoff, HTTPS long-poll fallback
// after repeated WS failures, command dispatch, and event-queue draining on
// (re)connect.
type Runner struct {
	Priv          ed25519.PrivateKey
	St            *state.Store
	Proc          *command.Processor
	Queue         *events.Queue
	Clock         *clock.Synced
	Log           *slog.Logger
	AllowInsecure bool // permit ws:// + http:// endpoints (tests/dev)

	// wsFailures counts consecutive WS dial/auth failures before falling
	// back to long-poll for one cycle.
	wsFailures int
}

const wsFailuresBeforePoll = 3

// Run loops until ctx is done.
func (r *Runner) Run(ctx context.Context) error {
	log := r.Log
	if log == nil {
		log = slog.Default()
	}
	attempt := 0
	for ctx.Err() == nil {
		p := r.St.Pairing()
		if p == nil {
			return fmt.Errorf("transport: not paired")
		}
		err := r.runWS(ctx, p, log)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			r.wsFailures++
			log.Warn("ws session ended", "err", err, "consecutive_failures", r.wsFailures)
		} else {
			r.wsFailures = 0
			attempt = 0
		}
		if r.wsFailures >= wsFailuresBeforePoll {
			r.longPollCycle(ctx, p, log)
		}
		attempt++
		sleepCtx(ctx, backoff(attempt))
	}
	return nil
}

// backoff is jittered exponential: min(1s·2^attempt, 5m) × [0.5, 1.5).
func backoff(attempt int) time.Duration {
	if attempt > 9 {
		attempt = 9
	}
	base := time.Second << uint(attempt)
	if base > 5*time.Minute {
		base = 5 * time.Minute
	}
	return time.Duration(float64(base) * (0.5 + rand.Float64()))
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// runWS performs one full WS session: dial, challenge/auth, drain, serve.
func (r *Runner) runWS(ctx context.Context, p *state.Pairing, log *slog.Logger) error {
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	conn, err := DialWS(dialCtx, p.WSURL, r.AllowInsecure)
	cancel()
	if err != nil {
		return err
	}
	defer conn.Close()

	// 1. ws.challenge → ws.auth (proto/pairing.md rule 5). The challenge
	// iat is gateway-authoritative time: sync the clock on every connect.
	conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	raw, err := conn.ReadMessage()
	if err != nil {
		return fmt.Errorf("read challenge: %w", err)
	}
	var ch wire.WSChallenge
	if err := json.Unmarshal(raw, &ch); err != nil || ch.Typ != "ws.challenge" {
		return fmt.Errorf("malformed ws.challenge")
	}
	r.Clock.SyncFromGateway(ch.IAT)
	auth, err := wire.SignWSAuth(r.Priv, p.DeviceID, ch.Cnonce, r.Clock.Now())
	if err != nil {
		return err
	}
	if err := conn.WriteMessage(auth); err != nil {
		return err
	}
	conn.SetReadDeadline(time.Time{})
	log.Info("gateway connected", "ws", p.WSURL)
	r.wsFailures = 0

	// 2. Drain queued events (grants partition first). The v0 contract has
	// no event-level ack, so an event is marked delivered after a
	// successful frame write; the gateway dedupes on event_id, so the
	// crash-resend window is safe.
	r.drainEvents(conn, log)

	// 3. Serve commands until the connection drops; keep draining new
	// events as they appear.
	done := make(chan struct{})
	defer close(done)
	go func() {
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				conn.Close()
				return
			case <-t.C:
				r.drainEvents(conn, log)
			}
		}
	}()
	for {
		raw, err := conn.ReadMessage()
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		r.dispatch(conn, raw, log)
	}
}

func (r *Runner) dispatch(conn *WSConn, raw []byte, log *slog.Logger) {
	var probe struct {
		Typ string `json:"typ"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		log.Warn("unparseable message from gateway")
		return
	}
	switch probe.Typ {
	case "cmd":
		ack, err := r.Proc.Process(raw)
		if err != nil {
			log.Error("command processing", "err", err)
			return
		}
		if err := conn.WriteMessage(ack); err != nil {
			log.Warn("ack send failed", "err", err)
		}
	default:
		// Additive contracts: ignore unknown message types.
		log.Debug("ignoring message", "typ", probe.Typ)
	}
}

func (r *Runner) drainEvents(conn *WSConn, log *slog.Logger) {
	for _, pe := range r.Queue.Drain(256) {
		if err := conn.WriteMessage(pe.Raw); err != nil {
			log.Warn("event send failed", "err", err)
			return
		}
		if err := r.Queue.Ack(pe); err != nil {
			log.Error("event cursor persist failed", "err", err)
			return
		}
	}
}

// longPollCycle is the HTTPS fallback when the WebSocket cannot be
// established (proto/pairing.md rule 5: "fall back to HTTPS long-poll at
// poll_interval").
//
// NOTE: pair.grant only fixes the interval; the poll endpoints are not yet
// specced. This client uses the convention:
//
//	GET  <ws_url with http(s) scheme>/../poll?device_id=… → {"commands":[…]}
//	POST same URL with {"acks":[…],"events":[…]}
//
// documented here and in the README until the gateway freezes the shape.
func (r *Runner) longPollCycle(ctx context.Context, p *state.Pairing, log *slog.Logger) {
	base, err := pollURL(p.WSURL)
	if err != nil {
		log.Warn("long-poll url", "err", err)
		return
	}
	if base.Scheme == "http" && !r.AllowInsecure {
		log.Warn("long-poll refused: https required")
		return
	}
	interval := time.Duration(p.PollInterval) * time.Second
	if interval <= 0 {
		interval = 30 * time.Second
	}
	hc := &http.Client{Timeout: interval + 15*time.Second}
	q := base.Query()
	q.Set("device_id", p.DeviceID)
	base.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String(), nil)
	if err != nil {
		return
	}
	resp, err := hc.Do(req)
	if err != nil {
		log.Warn("long-poll", "err", err)
		return
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil || resp.StatusCode != http.StatusOK {
		log.Warn("long-poll response", "status", resp.Status, "err", err)
		return
	}
	var payload struct {
		Commands []json.RawMessage `json:"commands"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		log.Warn("long-poll body", "err", err)
		return
	}
	var acks []json.RawMessage
	for _, c := range payload.Commands {
		ack, err := r.Proc.Process(c)
		if err != nil {
			continue
		}
		acks = append(acks, ack)
	}
	var evs []json.RawMessage
	pending := r.Queue.Drain(256)
	for _, pe := range pending {
		evs = append(evs, pe.Raw)
	}
	if len(acks) == 0 && len(evs) == 0 {
		return
	}
	out, _ := json.Marshal(map[string]any{"acks": acks, "events": evs})
	postReq, err := http.NewRequestWithContext(ctx, http.MethodPost, base.String(), bytes.NewReader(out))
	if err != nil {
		return
	}
	postReq.Header.Set("Content-Type", "application/json")
	postResp, err := hc.Do(postReq)
	if err != nil {
		log.Warn("long-poll post", "err", err)
		return
	}
	postResp.Body.Close()
	if postResp.StatusCode == http.StatusOK {
		for _, pe := range pending {
			_ = r.Queue.Ack(pe)
		}
	}
}

// pollURL converts wss://host/path → https://host/path/poll (ws → http).
func pollURL(wsURL string) (*url.URL, error) {
	u, err := url.Parse(wsURL)
	if err != nil {
		return nil, err
	}
	switch u.Scheme {
	case "wss":
		u.Scheme = "https"
	case "ws":
		u.Scheme = "http"
	default:
		return nil, fmt.Errorf("transport: bad ws_url scheme %q", u.Scheme)
	}
	u.Path = u.Path + "/poll"
	return u, nil
}
