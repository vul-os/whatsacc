package transport_test

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vul-os/lintel/controller/internal/clock"
	"github.com/vul-os/lintel/controller/internal/command"
	"github.com/vul-os/lintel/controller/internal/events"
	"github.com/vul-os/lintel/controller/internal/jcs"
	"github.com/vul-os/lintel/controller/internal/noncestore"
	"github.com/vul-os/lintel/controller/internal/relay"
	"github.com/vul-os/lintel/controller/internal/state"
	"github.com/vul-os/lintel/controller/internal/transport"
	"github.com/vul-os/lintel/controller/internal/vectorfile"
	"github.com/vul-os/lintel/controller/internal/wire"
)

func vectorKeys(t *testing.T) (gwPriv, ctrlPriv ed25519.PrivateKey, gwPubB64 string, ctrlPub ed25519.PublicKey) {
	t.Helper()
	dir, err := vectorfile.FindDir("")
	if err != nil {
		t.Fatal(err)
	}
	k, err := vectorfile.LoadKeys(dir)
	if err != nil {
		t.Fatal(err)
	}
	gseed, _ := k.Keys["gateway"].Seed()
	cseed, _ := k.Keys["controller"].Seed()
	gwPriv = ed25519.NewKeyFromSeed(gseed)
	ctrlPriv = ed25519.NewKeyFromSeed(cseed)
	return gwPriv, ctrlPriv, k.Keys["gateway"].PublicKeyB64u, ctrlPriv.Public().(ed25519.PublicKey)
}

// wsUpgrade performs the server half of the RFC 6455 handshake in a
// hijacked httptest handler and returns the framed connection.
func wsUpgrade(t *testing.T, w http.ResponseWriter, r *http.Request) *transport.WSConn {
	t.Helper()
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		t.Error("missing Upgrade header")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	hj, ok := w.(http.Hijacker)
	if !ok {
		t.Fatal("no hijacker")
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(brw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", transport.WSAccept(key))
	if err := brw.Flush(); err != nil {
		t.Fatal(err)
	}
	return transport.NewWSConn(conn)
}

// TestRunnerFullSession runs the real Runner against a fake WS gateway:
// challenge → signed ws.auth (verified against the enrolled controller
// key) → queued-event drain → signed command → signed ack.
func TestRunnerFullSession(t *testing.T) {
	gwPriv, ctrlPriv, gwPubB64, ctrlPub := vectorKeys(t)
	tmp := t.TempDir()
	st, err := state.Open(tmp)
	if err != nil {
		t.Fatal(err)
	}
	deviceID := "de71ce00-0000-4000-8000-000000000001"

	nonces, err := noncestore.Open(tmp)
	if err != nil {
		t.Fatal(err)
	}
	queue, err := events.Open(tmp)
	if err != nil {
		t.Fatal(err)
	}
	clk := clock.NewSynced(0, nil)
	rec := &events.Recorder{Priv: ctrlPriv, DeviceID: deviceID, Clock: clk, Queue: queue}
	rec.Record("boot", map[string]any{"fw": "0.1.0-test", "reason": "test"})

	proc := &command.Processor{
		Priv: ctrlPriv, State: st, Nonces: nonces, Clock: clk,
		Relay: relay.NewMock(nil), Events: rec, SyncClock: clk.SyncFromGateway,
	}

	type seen struct {
		event bool
		ack   wire.Ack
	}
	done := make(chan seen, 1)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws := wsUpgrade(t, w, r)
		defer ws.Close()
		now := time.Now().Unix()

		// 1. Challenge.
		ch := wire.WSChallenge{V: 0, Typ: "ws.challenge", Cnonce: "dGVzdC1jbm9uY2UtMDAwMQ", IAT: now, EXP: now + 30}
		raw, _ := json.Marshal(&ch)
		if err := ws.WriteMessage(raw); err != nil {
			t.Error(err)
			return
		}
		// 2. ws.auth must verify against the enrolled controller key.
		authRaw, err := ws.ReadMessage()
		if err != nil {
			t.Error(err)
			return
		}
		if err := wire.VerifyWSAuth(ctrlPub, authRaw, &ch, time.Now().Unix(), map[string]bool{}); err != nil {
			t.Errorf("ws.auth rejected: %v", err)
			return
		}
		// 3. Send a signed open; collect the drained event + the ack.
		m := map[string]any{
			"v": 0, "typ": "cmd", "cmd": "open", "device_id": deviceID,
			"access_point": "main", "nonce": "dHJhbnNwb3J0LXRlc3Qh",
			"iat": now, "exp": now + 30,
		}
		canonical, _ := jcs.Canonicalize(m)
		m["sig"] = wire.Sign(gwPriv, canonical)
		cmdRaw, _ := json.Marshal(m)
		if err := ws.WriteMessage(cmdRaw); err != nil {
			t.Error(err)
			return
		}
		var got seen
		deadline := time.After(5 * time.Second)
		for {
			select {
			case <-deadline:
				t.Error("timeout waiting for event+ack")
				done <- got
				return
			default:
			}
			msg, err := ws.ReadMessage()
			if err != nil {
				done <- got
				return
			}
			var probe struct {
				Typ string `json:"typ"`
			}
			_ = json.Unmarshal(msg, &probe)
			switch probe.Typ {
			case "event":
				if err := wire.VerifyRaw(ctrlPub, msg); err != nil {
					t.Errorf("event signature: %v", err)
				}
				got.event = true
			case "cmd.ack":
				if err := wire.VerifyRaw(ctrlPub, msg); err != nil {
					t.Errorf("ack signature: %v", err)
				}
				_ = json.Unmarshal(msg, &got.ack)
				done <- got
				return
			}
		}
	}))
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	if err := st.SavePairing(state.Pairing{DeviceID: deviceID, GatewayPubkey: gwPubB64, WSURL: wsURL, PollInterval: 1}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetAccessPoints([]string{"main"}); err != nil {
		t.Fatal(err)
	}

	runner := &transport.Runner{
		Priv: ctrlPriv, St: st, Proc: proc, Queue: queue, Clock: clk, AllowInsecure: true,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go runner.Run(ctx)

	// The full session is deterministic: the boot event must arrive on the
	// wire (drain-on-connect) AND the command must yield a signed opened
	// ack for the exact nonce we sent — both observed server-side before we
	// tear down. (Cursor durability across reopen is covered exhaustively
	// by internal/events queue tests; we don't reopen the live queue here
	// to avoid racing the still-running runner goroutine.)
	select {
	case got := <-done:
		if !got.event {
			t.Error("queued boot event was not drained on connect")
		}
		if got.ack.Result != "opened" || got.ack.Nonce != "dHJhbnNwb3J0LXRlc3Qh" {
			t.Errorf("ack: %+v", got.ack)
		}
	case <-ctx.Done():
		t.Fatal("timeout waiting for full WS session (challenge→auth→drain→cmd→ack)")
	}
	cancel()
}

// TestDialRefusesInsecureByDefault: ws:// must be rejected without the
// explicit dev flag.
func TestDialRefusesInsecureByDefault(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := transport.DialWS(ctx, "ws://127.0.0.1:1/ws", false); err == nil {
		t.Fatal("ws:// accepted without AllowInsecure")
	}
}
