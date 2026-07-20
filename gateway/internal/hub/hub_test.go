package hub_test

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/vul-os/lintel/gateway/internal/hub"
	"github.com/vul-os/lintel/gateway/internal/keys"
)

// ---------------------------------------------------------------------------
// proto/vectors/pairing.json conformance for the PRODUCTION verifier
// (internal/keys' vector suite proves a reference twin; this proves the one
// the WS endpoint actually calls).
// ---------------------------------------------------------------------------

func vectorsDir(t *testing.T) string {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(self)
	for i := 0; i < 8; i++ {
		cand := filepath.Join(dir, "proto", "vectors")
		if st, err := os.Stat(filepath.Join(cand, "pairing.json")); err == nil && !st.IsDir() {
			return cand
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatal("proto/vectors/ not found")
	return ""
}

func controllerPub(t *testing.T, dir string) ed25519.PublicKey {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "keys.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Keys map[string]struct {
			PrivateSeedHex string `json:"private_seed_hex"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	seed, err := hex.DecodeString(doc.Keys["controller"].PrivateSeedHex)
	if err != nil || len(seed) != ed25519.SeedSize {
		t.Fatal("bad controller seed")
	}
	return ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
}

func TestVerifyAuthAgainstPairingVectors(t *testing.T) {
	dir := vectorsDir(t)
	pub := controllerPub(t, dir)
	raw, err := os.ReadFile(filepath.Join(dir, "pairing.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Vectors []struct {
			Name     string          `json:"name"`
			Expect   string          `json:"expect"`
			Reason   string          `json:"reason"`
			Unsigned bool            `json:"unsigned"`
			Object   json.RawMessage `json:"object"`
			Check    struct {
				Now       int64  `json:"now"`
				DeviceID  string `json:"device_id"`
				Challenge *struct {
					Cnonce string `json:"cnonce"`
					IAT    int64  `json:"iat"`
					EXP    int64  `json:"exp"`
				} `json:"challenge"`
			} `json:"check"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	ran := 0
	for _, v := range doc.Vectors {
		if v.Unsigned || v.Check.Challenge == nil {
			continue // pair.redeem / pair.grant / ws.challenge canonical-form vectors
		}
		t.Run(v.Name, func(t *testing.T) {
			ch := hub.Challenge{Cnonce: v.Check.Challenge.Cnonce, IAT: v.Check.Challenge.IAT, EXP: v.Check.Challenge.EXP}
			got := hub.VerifyAuth(pub, v.Object, v.Check.DeviceID, ch, false, v.Check.Now)
			switch v.Expect {
			case "accept":
				if got != "" {
					t.Errorf("want accept, got reject(%s)", got)
				}
			case "reject":
				if got != v.Reason {
					t.Errorf("want reject(%s), got %q", v.Reason, got)
				}
			}
		})
		ran++
	}
	if ran < 4 {
		t.Errorf("only %d ws.auth vectors exercised", ran)
	}
}

// ---------------------------------------------------------------------------
// Registry + dispatch semantics
// ---------------------------------------------------------------------------

func signedEnvelope(t *testing.T, dir, cmd, deviceID, ap string) *keys.Envelope {
	t.Helper()
	// A locally generated gateway key is fine — dispatch doesn't verify.
	ks, err := keys.Load(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	env, err := ks.SignCommand(cmd, deviceID, ap, 30*time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = dir
	return env
}

func TestDispatchAckedRoundTrip(t *testing.T) {
	h := hub.New()
	send, _, unregister := h.Register("dev-1")
	defer unregister()

	env := signedEnvelope(t, "", "open", "dev-1", "ap-1")
	done := make(chan hub.AckOutcome, 1)
	go func() {
		done <- h.Dispatch(context.Background(), "dev-1", env, 2*time.Second, "log-1")
	}()

	payload := <-send
	var got keys.Envelope
	if err := json.Unmarshal(payload, &got); err != nil || got.Cmd != "open" || got.Nonce != env.Nonce {
		t.Fatalf("delivered payload wrong: %v %+v", err, got)
	}
	h.ResolveAck(hub.Ack{Typ: "cmd.ack", DeviceID: "dev-1", Nonce: env.Nonce, Result: "opened"})
	out := <-done
	if out.Delivery != "acked" || out.Result != "opened" {
		t.Errorf("outcome: %+v", out)
	}
}

func TestDispatchUndeliveredOnSilence(t *testing.T) {
	h := hub.New()
	_, _, unregister := h.Register("dev-2")
	defer unregister()
	env := signedEnvelope(t, "", "open", "dev-2", "ap-1")
	out := h.Dispatch(context.Background(), "dev-2", env, 50*time.Millisecond, "log-2")
	if out.Delivery != "undelivered" {
		t.Errorf("silent device: %+v", out)
	}
}

// TestLateAckReconciles proves the defect fix: a cmd.ack that arrives AFTER
// the ack-wait deadline (so ResolveAck reports no waiter, exactly like the
// pre-fix "late ack — log only" path) can still be routed back to the
// dispatch's access_logs row via LateAckReconcile, instead of being
// dropped. Before the fix this method did not exist and every late ack was
// unrecoverable.
func TestLateAckReconciles(t *testing.T) {
	h := hub.New()
	_, _, unregister := h.Register("dev-late")
	defer unregister()
	env := signedEnvelope(t, "", "open", "dev-late", "ap-1")

	// Ack-wait deadline elapses with no ack: outcome is undelivered, exactly
	// the case that used to make late acks unrecoverable (the pendingAck
	// waiter is gone by the time the real ack shows up).
	out := h.Dispatch(context.Background(), "dev-late", env, 20*time.Millisecond, "log-late-1")
	if out.Delivery != "undelivered" {
		t.Fatalf("expected undelivered, got %+v", out)
	}

	// The on-time path (ResolveAck) correctly reports nothing was waiting.
	ack := hub.Ack{Typ: "cmd.ack", DeviceID: "dev-late", Nonce: env.Nonce, Result: "opened", TS: time.Now().Unix()}
	if h.ResolveAck(ack) {
		t.Fatal("ResolveAck should report no waiter for an already-timed-out dispatch")
	}

	// But the late ack still reconciles against the original log id.
	logID, ok := h.LateAckReconcile(ack, time.Now().Unix())
	if !ok || logID != "log-late-1" {
		t.Fatalf("LateAckReconcile: ok=%v logID=%q, want ok=true logID=log-late-1", ok, logID)
	}

	// One-shot: reconciling twice for the same nonce must not succeed again.
	if _, ok := h.LateAckReconcile(ack, time.Now().Unix()); ok {
		t.Fatal("LateAckReconcile must be one-shot")
	}
}

// TestLateAckReconcileWrongDeviceRejected: a nonce match alone is not
// enough — the ack must also be addressed from the same device the
// dispatch was sent to (defense in depth; VerifyFromController already
// enforces this against the signing key upstream, but LateAckReconcile
// must not trust a nonce collision/mismatch on its own).
func TestLateAckReconcileWrongDeviceRejected(t *testing.T) {
	h := hub.New()
	_, _, unregister := h.Register("dev-a")
	defer unregister()
	env := signedEnvelope(t, "", "open", "dev-a", "ap-1")
	h.Dispatch(context.Background(), "dev-a", env, 20*time.Millisecond, "log-a")

	ack := hub.Ack{Typ: "cmd.ack", DeviceID: "dev-b", Nonce: env.Nonce, Result: "opened"}
	if _, ok := h.LateAckReconcile(ack, time.Now().Unix()); ok {
		t.Fatal("LateAckReconcile must not match a different device_id")
	}
}

// TestLateAckReconcileWindowExpires: a "late" ack arriving after
// hub.LateAckWindow has elapsed must NOT reconcile — bounded, not
// arbitrarily long.
func TestLateAckReconcileWindowExpires(t *testing.T) {
	h := hub.New()
	_, _, unregister := h.Register("dev-c")
	defer unregister()
	env := signedEnvelope(t, "", "open", "dev-c", "ap-1")
	h.Dispatch(context.Background(), "dev-c", env, 20*time.Millisecond, "log-c")

	ack := hub.Ack{Typ: "cmd.ack", DeviceID: "dev-c", Nonce: env.Nonce, Result: "opened"}
	future := time.Now().Add(hub.LateAckWindow + time.Second).Unix()
	if _, ok := h.LateAckReconcile(ack, future); ok {
		t.Fatal("LateAckReconcile must not fire once LateAckWindow has elapsed")
	}
}

func TestDispatchQueuedWhenOfflineAndDrained(t *testing.T) {
	h := hub.New()
	env := signedEnvelope(t, "", "open", "dev-3", "ap-1")
	out := h.Dispatch(context.Background(), "dev-3", env, time.Second, "log-3")
	if out.Delivery != "queued" {
		t.Fatalf("offline device: %+v", out)
	}
	cmds := h.DrainQueue("dev-3")
	if len(cmds) != 1 {
		t.Fatalf("queue drain: %d", len(cmds))
	}
	// drained means gone
	if got := h.DrainQueue("dev-3"); len(got) != 0 {
		t.Errorf("second drain not empty: %d", len(got))
	}
}

func TestRegisterDisplacesPrevious(t *testing.T) {
	h := hub.New()
	_, done1, unreg1 := h.Register("dev-4")
	defer unreg1()
	_, _, unreg2 := h.Register("dev-4")
	defer unreg2()
	select {
	case <-done1:
	case <-time.After(time.Second):
		t.Error("previous connection not displaced")
	}
	if !h.Connected("dev-4") {
		t.Error("new connection should be live")
	}
}

// base64url sanity for DecodePubkey fail-closed behavior.
func TestDecodePubkey(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := hub.DecodePubkey(base64.RawURLEncoding.EncodeToString(pub)); !ok {
		t.Error("valid key rejected")
	}
	for _, bad := range []string{"", "AA", "!!!!", base64.RawURLEncoding.EncodeToString(pub[:16])} {
		if _, ok := hub.DecodePubkey(bad); ok {
			t.Errorf("bad key accepted: %q", bad)
		}
	}
}
