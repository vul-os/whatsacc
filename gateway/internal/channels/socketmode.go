package channels

// Slack Socket Mode — THE zero-URL story (ARCHITECTURE §4). When an app-level
// token (xapp-…) is configured, the gateway DIALS OUT to Slack over a single
// outbound WebSocket instead of receiving webhooks, so a gateway on a LAN with
// NO public URL still runs Slack fully. This is what makes "a Pi on the estate
// LAN is a complete installation" real.
//
// Flow (per Slack's Socket Mode protocol): POST apps.connections.open with the
// app token → a wss URL → dial it → receive `hello`, then `events_api` /
// `interactive` / `slash_commands` envelopes → ACK each by echoing its
// envelope_id → feed the payload through the SAME handler the Events API
// webhook uses. `disconnect` (or any read error) triggers a reconnect.
//
// coder/websocket is the transport (already the hub's dependency). The connection
// is abstracted behind SocketConn so tests drive a fake Slack WS server.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// SocketConn is the minimal WebSocket surface Socket Mode needs (abstracted so
// tests inject a fake).
type SocketConn interface {
	Read(ctx context.Context) ([]byte, error)
	Write(ctx context.Context, data []byte) error
	Close()
}

// socketEnvelope is one Socket Mode frame.
type socketEnvelope struct {
	EnvelopeID string          `json:"envelope_id"`
	Type       string          `json:"type"` // hello | disconnect | events_api | interactive | slash_commands
	Payload    json.RawMessage `json:"payload"`
}

// SocketMode runs the outbound Slack connection. Configure Handle (payload
// dispatch, reusing the webhook code path) and either AppToken (production
// apps.connections.open) or OpenConn + Dial (tests).
type SocketMode struct {
	AppToken string

	// Handle processes one accepted envelope's payload. envType is
	// "events_api" | "interactive" | "slash_commands". Called after the ack.
	Handle func(ctx context.Context, envType string, payload json.RawMessage)

	// OpenConn obtains a wss URL (default: apps.connections.open with AppToken).
	OpenConn func(ctx context.Context) (string, error)
	// Dial opens the WebSocket (default: coder/websocket).
	Dial func(ctx context.Context, url string) (SocketConn, error)

	Client       *http.Client
	Logger       *slog.Logger
	ReconnectMin time.Duration // backoff floor (default 1s)
}

// Enabled reports whether Socket Mode is configured (an xapp- app token).
func (s *SocketMode) Enabled() bool { return s.AppToken != "" }

func (s *SocketMode) log() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

// Run maintains the connection until ctx is cancelled, reconnecting with a
// simple capped backoff. Intended to be launched in its own goroutine.
func (s *SocketMode) Run(ctx context.Context) {
	backoff := s.reconnectMin()
	for {
		if ctx.Err() != nil {
			return
		}
		if err := s.connectOnce(ctx); err != nil && ctx.Err() == nil {
			s.log().Warn("slack socket mode disconnected", "err", err, "retry_in", backoff)
			if !sleepCtx(ctx, backoff) {
				return
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = s.reconnectMin()
		if !sleepCtx(ctx, s.reconnectMin()) {
			return
		}
	}
}

func (s *SocketMode) reconnectMin() time.Duration {
	if s.ReconnectMin > 0 {
		return s.ReconnectMin
	}
	return time.Second
}

// connectOnce opens one connection and serves it until it closes/errors.
func (s *SocketMode) connectOnce(ctx context.Context) error {
	openConn := s.OpenConn
	if openConn == nil {
		openConn = s.openViaSlack
	}
	url, err := openConn(ctx)
	if err != nil {
		return err
	}
	dial := s.Dial
	if dial == nil {
		dial = dialWebsocket
	}
	conn, err := dial(ctx, url)
	if err != nil {
		return err
	}
	defer conn.Close()
	return s.Serve(ctx, conn)
}

// Serve reads envelopes on an established connection until it returns (a
// `disconnect` envelope, a read error, or ctx cancel). Each actionable
// envelope is ACKed then handed to Handle. Single goroutine: acks and reads
// share it, so there is no write/read race.
func (s *SocketMode) Serve(ctx context.Context, conn SocketConn) error {
	for {
		raw, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var env socketEnvelope
		if err := json.Unmarshal(raw, &env); err != nil {
			s.log().Warn("slack socket: bad envelope", "err", err)
			continue
		}
		switch env.Type {
		case "hello":
			s.log().Info("slack socket mode connected")
			continue
		case "disconnect":
			s.log().Info("slack socket mode: server asked to reconnect")
			return errReconnect
		case "events_api", "interactive", "slash_commands":
			// Ack first (Slack redelivers unacked envelopes), then process.
			if env.EnvelopeID != "" {
				ackBytes, _ := json.Marshal(map[string]string{"envelope_id": env.EnvelopeID})
				if err := conn.Write(ctx, ackBytes); err != nil {
					return err
				}
			}
			if s.Handle != nil {
				s.Handle(ctx, env.Type, env.Payload)
			}
		default:
			// Unknown types are ignored (forward-compatible).
		}
	}
}

var errReconnect = errors.New("slack socket disconnect")

// openViaSlack calls apps.connections.open to obtain a wss URL.
func (s *SocketMode) openViaSlack(ctx context.Context) (string, error) {
	client := orDefaultClient(s.Client)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://slack.com/api/apps.connections.open", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+s.AppToken)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var out struct {
		OK    bool   `json:"ok"`
		URL   string `json:"url"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", err
	}
	if !out.OK || out.URL == "" {
		if out.Error != "" {
			return "", errors.New("apps.connections.open: " + out.Error)
		}
		return "", errors.New("apps.connections.open failed")
	}
	return out.URL, nil
}

// ---------------------------------------------------------------------------
// coder/websocket adapter
// ---------------------------------------------------------------------------

type coderConn struct{ c *websocket.Conn }

func (a *coderConn) Read(ctx context.Context) ([]byte, error) {
	_, data, err := a.c.Read(ctx)
	return data, err
}

func (a *coderConn) Write(ctx context.Context, data []byte) error {
	return a.c.Write(ctx, websocket.MessageText, data)
}

func (a *coderConn) Close() { _ = a.c.Close(websocket.StatusNormalClosure, "") }

func dialWebsocket(ctx context.Context, url string) (SocketConn, error) {
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(1 << 20)
	return &coderConn{c: c}, nil
}

// sleepCtx sleeps for d unless ctx is cancelled; returns false if cancelled.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
