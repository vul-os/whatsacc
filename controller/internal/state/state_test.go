package state_test

import (
	"errors"
	"testing"

	"github.com/vul-os/lintel/controller/internal/state"
	"github.com/vul-os/lintel/controller/internal/vectorfile"
)

func testPub(t *testing.T, name string) string {
	t.Helper()
	dir, err := vectorfile.FindDir("")
	if err != nil {
		t.Fatal(err)
	}
	k, err := vectorfile.LoadKeys(dir)
	if err != nil {
		t.Fatal(err)
	}
	return k.Keys[name].PublicKeyB64u
}

func TestPinnedKeyRules(t *testing.T) {
	gw := testPub(t, "gateway")
	next := testPub(t, "gateway_next")
	attacker := testPub(t, "attacker")

	st, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := state.Pairing{DeviceID: "d1", GatewayPubkey: gw, WSURL: "wss://x/ws", PollInterval: 30}
	if err := st.SavePairing(p); err != nil {
		t.Fatal(err)
	}
	// Same-key re-pair may update ws_url.
	p.WSURL = "wss://y/ws"
	if err := st.SavePairing(p); err != nil {
		t.Fatal(err)
	}
	// Different key refused.
	p.GatewayPubkey = attacker
	if err := st.SavePairing(p); !errors.Is(err, state.ErrKeyChangeRefused) {
		t.Fatalf("expected ErrKeyChangeRefused, got %v", err)
	}
	// Repair path rotates; garbage keys refused.
	if err := st.ApplyRepair("not-a-key"); err == nil {
		t.Fatal("garbage repair key accepted")
	}
	if err := st.ApplyRepair(next); err != nil {
		t.Fatal(err)
	}
	st2, err := state.Open(st.Dir())
	if err != nil {
		t.Fatal(err)
	}
	if st2.Pairing().GatewayPubkey != next {
		t.Fatal("repair rotation not durable")
	}
}

func TestInvalidPairingRejected(t *testing.T) {
	st, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SavePairing(state.Pairing{DeviceID: "d", GatewayPubkey: "bogus", WSURL: "wss://x"}); err == nil {
		t.Fatal("bogus gateway key accepted")
	}
	if err := st.SavePairing(state.Pairing{DeviceID: "", GatewayPubkey: testPub(t, "gateway"), WSURL: "wss://x"}); err == nil {
		t.Fatal("empty device_id accepted")
	}
}

func TestConfigAndSyncPersist(t *testing.T) {
	st, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.MergeConfig(map[string]int64{"pulse_ms": 900}); err != nil {
		t.Fatal(err)
	}
	if err := st.MergeConfig(map[string]int64{"hold_max": 600}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLastGatewaySync(12345); err != nil {
		t.Fatal(err)
	}
	st2, err := state.Open(st.Dir())
	if err != nil {
		t.Fatal(err)
	}
	cfg := st2.Config()
	if cfg["pulse_ms"] != 900 || cfg["hold_max"] != 600 {
		t.Fatalf("config not durable: %v", cfg)
	}
	if st2.LastGatewaySync() != 12345 {
		t.Fatal("last sync not durable")
	}
}
