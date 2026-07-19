package channels

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeConn is an in-memory SocketConn for deterministic envelope tests.
type fakeConn struct {
	toClient   chan []byte
	fromClient chan []byte
	closeOnce  sync.Once
	closed     chan struct{}
}

func newFakeConn() *fakeConn {
	return &fakeConn{toClient: make(chan []byte, 8), fromClient: make(chan []byte, 8), closed: make(chan struct{})}
}

func (c *fakeConn) Read(ctx context.Context) ([]byte, error) {
	select {
	case b := <-c.toClient:
		return b, nil
	case <-c.closed:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *fakeConn) Write(ctx context.Context, data []byte) error {
	cp := append([]byte(nil), data...)
	select {
	case c.fromClient <- cp:
		return nil
	case <-c.closed:
		return io.ErrClosedPipe
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *fakeConn) Close() { c.closeOnce.Do(func() { close(c.closed) }) }

func TestSocketModeEnvelopeAckAndDispatch(t *testing.T) {
	conn := newFakeConn()
	var mu sync.Mutex
	var seen []string
	sm := &SocketMode{
		Handle: func(ctx context.Context, envType string, payload json.RawMessage) {
			mu.Lock()
			seen = append(seen, envType+":"+string(payload))
			mu.Unlock()
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- sm.Serve(ctx, conn) }()

	// hello is ignored (no ack), then an events_api envelope must be acked.
	conn.toClient <- []byte(`{"type":"hello"}`)
	conn.toClient <- []byte(`{"envelope_id":"env-1","type":"events_api","payload":{"type":"event_callback"}}`)

	select {
	case ack := <-conn.fromClient:
		var got map[string]string
		if err := json.Unmarshal(ack, &got); err != nil || got["envelope_id"] != "env-1" {
			t.Fatalf("bad ack: %s", ack)
		}
	case <-ctx.Done():
		t.Fatal("no ack received")
	}

	// interactive envelope too.
	conn.toClient <- []byte(`{"envelope_id":"env-2","type":"interactive","payload":{"type":"block_actions"}}`)
	select {
	case ack := <-conn.fromClient:
		var got map[string]string
		_ = json.Unmarshal(ack, &got)
		if got["envelope_id"] != "env-2" {
			t.Fatalf("bad ack 2: %s", ack)
		}
	case <-ctx.Done():
		t.Fatal("no ack 2")
	}

	// disconnect envelope makes Serve return (→ reconnect in Run).
	conn.toClient <- []byte(`{"type":"disconnect"}`)
	select {
	case err := <-done:
		if err != errReconnect {
			t.Fatalf("expected reconnect, got %v", err)
		}
	case <-ctx.Done():
		t.Fatal("Serve did not return on disconnect")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 || !strings.HasPrefix(seen[0], "events_api:") || !strings.HasPrefix(seen[1], "interactive:") {
		t.Fatalf("handler dispatch: %v", seen)
	}
}

// TestSocketModeRealWebSocket drives connectOnce against a fake Slack WS server
// (real coder/websocket transport), proving the zero-URL path end to end:
// apps.connections.open → dial → hello → events_api → ack.
func TestSocketModeRealWebSocket(t *testing.T) {
	gotAck := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")
		ctx := r.Context()
		_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"hello"}`))
		_ = c.Write(ctx, websocket.MessageText, []byte(`{"envelope_id":"e1","type":"events_api","payload":{"ok":true}}`))
		_, ack, err := c.Read(ctx)
		if err != nil {
			return
		}
		var m map[string]string
		_ = json.Unmarshal(ack, &m)
		gotAck <- m["envelope_id"]
	}))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	handled := make(chan string, 1)
	sm := &SocketMode{
		OpenConn: func(ctx context.Context) (string, error) { return wsURL, nil },
		Handle: func(ctx context.Context, envType string, payload json.RawMessage) {
			handled <- envType
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go sm.connectOnce(ctx)

	select {
	case env := <-handled:
		if env != "events_api" {
			t.Fatalf("handled %q", env)
		}
	case <-ctx.Done():
		t.Fatal("envelope not handled over real WS")
	}
	select {
	case id := <-gotAck:
		if id != "e1" {
			t.Fatalf("server saw ack %q", id)
		}
	case <-ctx.Done():
		t.Fatal("server never received ack")
	}
}

func TestSocketModeEnabled(t *testing.T) {
	if (&SocketMode{}).Enabled() {
		t.Error("empty app token must be disabled")
	}
	if !(&SocketMode{AppToken: "xapp-1"}).Enabled() {
		t.Error("app token should enable")
	}
}
