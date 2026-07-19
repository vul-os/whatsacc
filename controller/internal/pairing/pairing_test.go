package pairing_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/vul-os/whatsacc/controller/internal/pairing"
	"github.com/vul-os/whatsacc/controller/internal/state"
	"github.com/vul-os/whatsacc/controller/internal/vectorfile"
)

// fakeGateway implements /pair/redeem with single-use token burn.
type fakeGateway struct {
	mu       sync.Mutex
	token    string
	burned   bool
	pubB64   string
	deviceID string
	wsURL    string
	lastHW   pairing.HW
	lastPub  string
}

func (g *fakeGateway) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /pair/redeem", func(w http.ResponseWriter, r *http.Request) {
		var req pairing.Redeem
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Typ != "pair.redeem" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		g.mu.Lock()
		defer g.mu.Unlock()
		if req.ClaimToken != g.token || g.burned {
			http.Error(w, "claim invalid or burned", http.StatusGone)
			return
		}
		g.burned = true // single-use
		g.lastHW = req.HW
		g.lastPub = req.ControllerPub
		json.NewEncoder(w).Encode(&pairing.Grant{
			V: 0, Typ: "pair.grant",
			DeviceID: g.deviceID, GatewayPubkey: g.pubB64,
			WSURL: g.wsURL, PollInterval: 30,
		})
	})
	return mux
}

func keys(t *testing.T) *vectorfile.Keys {
	t.Helper()
	dir, err := vectorfile.FindDir("")
	if err != nil {
		t.Fatal(err)
	}
	k, err := vectorfile.LoadKeys(dir)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestRedeemHappyPathAndTokenBurn(t *testing.T) {
	k := keys(t)
	gw := &fakeGateway{
		token: "claim-123", pubB64: k.Keys["gateway"].PublicKeyB64u,
		deviceID: "de71ce00-0000-4000-8000-000000000001",
		wsURL:    "wss://gate.example.com/api/controller/ws",
	}
	ts := httptest.NewServer(gw.handler())
	defer ts.Close()

	st, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c := &pairing.Client{}
	hw := pairing.HW{Model: "wacc-c1", FW: "0.1.0", Ifaces: []string{"wifi"}}
	g, err := c.RedeemClaim(context.Background(), st, ts.URL, "claim-123", k.Keys["controller"].PublicKeyB64u, hw)
	if err != nil {
		t.Fatal(err)
	}
	if g.DeviceID != gw.deviceID {
		t.Fatalf("device_id: %s", g.DeviceID)
	}
	p := st.Pairing()
	if p == nil || p.GatewayPubkey != gw.pubB64 || p.WSURL != gw.wsURL || p.DeviceID != gw.deviceID {
		t.Fatalf("pairing not persisted: %+v", p)
	}
	if gw.lastPub != k.Keys["controller"].PublicKeyB64u {
		t.Fatal("controller pubkey not sent")
	}
	// Pinned key survives a reopen.
	st2, err := state.Open(st.Dir())
	if err != nil {
		t.Fatal(err)
	}
	if st2.Pairing().GatewayPubkey != gw.pubB64 {
		t.Fatal("pinned key not durable")
	}
	// Token is burned: second redeem fails.
	if _, err := c.RedeemClaim(context.Background(), st, ts.URL, "claim-123", k.Keys["controller"].PublicKeyB64u, hw); err == nil {
		t.Fatal("burned token accepted")
	}
}

// TestGatewayKeyChangeRejected: once paired, a redeem response carrying a
// DIFFERENT gateway key must be refused — a tampered/replaced gateway
// cannot rotate the pinned key outside the signed `repair` path.
func TestGatewayKeyChangeRejected(t *testing.T) {
	k := keys(t)
	gw := &fakeGateway{
		token: "claim-1", pubB64: k.Keys["gateway"].PublicKeyB64u,
		deviceID: "dev-1", wsURL: "wss://gate.example.com/ws",
	}
	ts := httptest.NewServer(gw.handler())
	defer ts.Close()

	st, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c := &pairing.Client{}
	hw := pairing.HW{Model: "wacc-c1", FW: "0.1.0"}
	if _, err := c.RedeemClaim(context.Background(), st, ts.URL, "claim-1", k.Keys["controller"].PublicKeyB64u, hw); err != nil {
		t.Fatal(err)
	}
	// The gateway is replaced/hostile: new token, ATTACKER key.
	gw.mu.Lock()
	gw.token, gw.burned = "claim-2", false
	gw.pubB64 = k.Keys["attacker"].PublicKeyB64u
	gw.mu.Unlock()
	_, err = c.RedeemClaim(context.Background(), st, ts.URL, "claim-2", k.Keys["controller"].PublicKeyB64u, hw)
	if !errors.Is(err, state.ErrKeyChangeRefused) {
		t.Fatalf("expected ErrKeyChangeRefused, got %v", err)
	}
	if st.Pairing().GatewayPubkey != k.Keys["gateway"].PublicKeyB64u {
		t.Fatal("pinned key was overwritten")
	}
}

func TestInsecureWSURLRefused(t *testing.T) {
	k := keys(t)
	gw := &fakeGateway{
		token: "claim-1", pubB64: k.Keys["gateway"].PublicKeyB64u,
		deviceID: "dev-1", wsURL: "ws://gate.example.com/ws",
	}
	ts := httptest.NewServer(gw.handler())
	defer ts.Close()
	st, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c := &pairing.Client{} // AllowInsecureWS = false
	if _, err := c.RedeemClaim(context.Background(), st, ts.URL, "claim-1", "pub", pairing.HW{}); err == nil {
		t.Fatal("ws:// ws_url accepted without AllowInsecureWS")
	}
	if st.Pairing() != nil {
		t.Fatal("state persisted despite refusal")
	}
}

func TestMalformedGrantRejected(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"v":0,"typ":"pair.grant","device_id":"d","gateway_pubkey":"not-a-key","ws_url":"wss://x/ws"}`))
	}))
	defer ts.Close()
	st, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c := &pairing.Client{}
	if _, err := c.RedeemClaim(context.Background(), st, ts.URL, "tok", "pub", pairing.HW{}); err == nil {
		t.Fatal("malformed gateway_pubkey accepted")
	}
}
