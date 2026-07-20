package httpapi

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/vul-os/lintel/gateway/internal/hub"
	"github.com/vul-os/lintel/gateway/internal/keys"
	"github.com/vul-os/lintel/gateway/internal/store"
)

// newLiveServer boots the router on a real listener (WS dialing needs one)
// and returns the *Server too for hub access.
func newLiveServer(t *testing.T) (*httptest.Server, *Server, *store.Store) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ks, err := keys.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	srv := New(Config{
		Version:    "test",
		JWTSecret:  []byte("0123456789abcdef0123456789abcdef"),
		AckTimeout: 500 * time.Millisecond,
	}, st, ks, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	ts := httptest.NewServer(srv.Router())
	t.Cleanup(ts.Close)
	return ts, srv, st
}

func liveJSON(t *testing.T, ts *httptest.Server, method, path, bearer string, body any) (int, map[string]any) {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, ts.URL+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out := map[string]any{}
	json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

// pairDevice registers an admin, creates a device claim and redeems it with
// a fresh controller key, returning ids + the controller's private key.
func pairDevice(t *testing.T, ts *httptest.Server) (access, accountID, locationID, deviceID string, priv ed25519.PrivateKey) {
	t.Helper()
	code, out := liveJSON(t, ts, "POST", "/v1/auth/register", "", map[string]any{
		"email": "pair@x.com", "password": "hunter2hunter2", "location_name": "Pair House",
	})
	if code != 201 {
		t.Fatalf("register: %d %v", code, out)
	}
	access = out["tokens"].(map[string]any)["access_token"].(string)
	accountID = out["account"].(map[string]any)["id"].(string)
	locationID = out["location"].(map[string]any)["id"].(string)

	code, out = liveJSON(t, ts, "POST", "/v1/devices", access, map[string]any{
		"location_id": locationID, "label": "front-controller",
	})
	if code != 201 {
		t.Fatalf("device create: %d %v", code, out)
	}
	claimToken := out["claim_token"].(string)
	if claimToken == "" {
		t.Fatal("claim token missing from create response")
	}

	pub, privKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	code, out = liveJSON(t, ts, "POST", "/api/pair/redeem", "", map[string]any{
		"v": 0, "typ": "pair.redeem", "claim_token": claimToken,
		"controller_pubkey": base64.RawURLEncoding.EncodeToString(pub),
		"hw":                map[string]any{"model": "lintel-c1", "fw": "0.1.0", "ifaces": []string{"wifi"}},
	})
	if code != 200 {
		t.Fatalf("redeem: %d %v", code, out)
	}
	// pair.grant shape per proto/pairing.md
	if out["typ"] != "pair.grant" || out["v"] != float64(0) {
		t.Errorf("grant typ/v: %v", out)
	}
	if out["gateway_pubkey"] == "" || out["poll_interval"] != float64(30) {
		t.Errorf("grant fields: %v", out)
	}
	wsURL := out["ws_url"].(string)
	if !strings.HasPrefix(wsURL, "ws://") || !strings.HasSuffix(wsURL, "/api/controller/ws") {
		t.Errorf("ws_url: %s", wsURL)
	}
	deviceID = out["device_id"].(string)
	return access, accountID, locationID, deviceID, privKey
}

func signAuth(t *testing.T, priv ed25519.PrivateKey, deviceID, cnonce string, ts int64) []byte {
	t.Helper()
	m := map[string]any{"v": 0, "typ": "ws.auth", "device_id": deviceID, "cnonce": cnonce, "ts": ts}
	canonical, err := keys.Canonicalize(m)
	if err != nil {
		t.Fatal(err)
	}
	m["sig"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, canonical))
	raw, _ := json.Marshal(m)
	return raw
}

func TestPairingClaimSingleUseAndExpiry(t *testing.T) {
	ts, _, st := newLiveServer(t)
	access, _, locationID, _, _ := pairDevice(t, ts)

	// Reusing a burned token → 404 (indistinguishable from unknown).
	code, out := liveJSON(t, ts, "POST", "/v1/devices", access, map[string]any{"location_id": locationID})
	if code != 201 {
		t.Fatal(code)
	}
	tok := out["claim_token"].(string)
	pub, _, _ := ed25519.GenerateKey(nil)
	pubB64 := base64.RawURLEncoding.EncodeToString(pub)
	redeem := func(token string) (int, map[string]any) {
		return liveJSON(t, ts, "POST", "/api/pair/redeem", "", map[string]any{
			"v": 0, "typ": "pair.redeem", "claim_token": token, "controller_pubkey": pubB64,
		})
	}
	if code, _ := redeem(tok); code != 200 {
		t.Fatalf("first redeem: %d", code)
	}
	if code, out := redeem(tok); code != http.StatusNotFound || out["error"] != "device_not_found" {
		t.Errorf("second redeem must fail closed: %d %v", code, out)
	}

	// Expired claim → 400 claim_expired. Force expiry via the store handle.
	code, out = liveJSON(t, ts, "POST", "/v1/devices", access, map[string]any{
		"location_id": locationID, "claim_ttl_seconds": 60,
	})
	if code != 201 {
		t.Fatal(code)
	}
	expTok := out["claim_token"].(string)
	if err := st.ExpireDeviceClaim(context.Background(), out["id"].(string)); err != nil {
		t.Fatal(err)
	}
	if code, out := redeem(expTok); code != http.StatusBadRequest || out["error"] != "claim_expired" {
		t.Errorf("expired claim: %d %v", code, out)
	}

	// TTL bounds: > 7 d rejected
	code, _ = liveJSON(t, ts, "POST", "/v1/devices", access, map[string]any{
		"location_id": locationID, "claim_ttl_seconds": 8 * 24 * 3600,
	})
	if code != http.StatusBadRequest {
		t.Errorf("over-max TTL: %d", code)
	}

	// invalid pubkey rejected before touching the token
	code, out = liveJSON(t, ts, "POST", "/api/pair/redeem", "", map[string]any{
		"v": 0, "typ": "pair.redeem", "claim_token": "whatever", "controller_pubkey": "not-a-key",
	})
	if code != http.StatusBadRequest || out["error"] != "invalid_controller_pubkey" {
		t.Errorf("bad pubkey: %d %v", code, out)
	}
}

func TestDeviceCreateRoleGates(t *testing.T) {
	ts, _, _ := newLiveServer(t)
	_, _, locationID, _, _ := pairDevice(t, ts)

	// Another user (non-member) cannot mint claims for A's location — 404.
	code, out := liveJSON(t, ts, "POST", "/v1/auth/register", "", map[string]any{
		"email": "other@x.com", "password": "hunter2hunter2", "location_name": "Other House",
	})
	if code != 201 {
		t.Fatal(code)
	}
	accessB := out["tokens"].(map[string]any)["access_token"].(string)
	code, _ = liveJSON(t, ts, "POST", "/v1/devices", accessB, map[string]any{"location_id": locationID})
	if code != http.StatusNotFound {
		t.Errorf("cross-tenant device create: %d", code)
	}
	// and B's device listing scoped to A's account 404s
	code, _ = liveJSON(t, ts, "GET", "/v1/devices?location_id="+locationID, accessB, nil)
	if code != 200 {
		t.Fatalf("device list: %d", code)
	}
}

func dialWS(t *testing.T, ts *httptest.Server) *websocket.Conn {
	t.Helper()
	url := strings.Replace(ts.URL, "http://", "ws://", 1) + "/api/controller/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return conn
}

func TestControllerWSHandshakeAndAck(t *testing.T) {
	ts, srv, _ := newLiveServer(t)
	_, _, _, deviceID, priv := pairDevice(t, ts)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn := dialWS(t, ts)
	defer conn.Close(websocket.StatusNormalClosure, "done")

	// 1. challenge arrives
	_, raw, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var ch struct {
		Typ    string `json:"typ"`
		Cnonce string `json:"cnonce"`
		EXP    int64  `json:"exp"`
	}
	if err := json.Unmarshal(raw, &ch); err != nil || ch.Typ != "ws.challenge" || ch.Cnonce == "" {
		t.Fatalf("challenge: %v %s", err, raw)
	}

	// 2. answer with a signed ws.auth
	if err := conn.Write(ctx, websocket.MessageText,
		signAuth(t, priv, deviceID, ch.Cnonce, time.Now().Unix())); err != nil {
		t.Fatal(err)
	}
	// Wait for registration to land.
	deadline := time.Now().Add(3 * time.Second)
	for !srv.Hub().Connected(deviceID) {
		if time.Now().After(deadline) {
			t.Fatal("device never registered in hub")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// 3. dispatch a command; controller acks; outcome = acked
	env, err := srv.keys.SignCommand("open", deviceID, "ap-1", 30*time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	outcome := make(chan hub.AckOutcome, 1)
	go func() {
		outcome <- srv.Hub().Dispatch(ctx, deviceID, env, 3*time.Second, "test-log-id")
	}()
	_, cmdRaw, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var cmd keys.Envelope
	if err := json.Unmarshal(cmdRaw, &cmd); err != nil || cmd.Cmd != "open" {
		t.Fatalf("command: %v %s", err, cmdRaw)
	}
	// sign a cmd.ack
	ackMap := map[string]any{
		"v": 0, "typ": "cmd.ack", "device_id": deviceID, "nonce": cmd.Nonce,
		"result": "opened", "ts": time.Now().Unix(),
	}
	canonical, _ := keys.Canonicalize(ackMap)
	ackMap["sig"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, canonical))
	ackRaw, _ := json.Marshal(ackMap)
	if err := conn.Write(ctx, websocket.MessageText, ackRaw); err != nil {
		t.Fatal(err)
	}
	got := <-outcome
	if got.Delivery != "acked" || got.Result != "opened" {
		t.Errorf("ack outcome: %+v", got)
	}
}

// TestLateAckReconcilesAccessLog is the end-to-end regression test for the
// defect: an "open" is dispatched to a connected-but-silent controller, the
// ack-wait deadline elapses (access_logs tagged 'undelivered' — the caller
// and the resident are told "couldn't reach the gate"), and only THEN does
// the controller's genuine, correctly-signed cmd.ack arrive. Before the
// fix, ResolveAck's false was only logged and the audit row stayed wrong
// forever. After the fix, a NEW row appears referencing the original —
// which itself must stay untouched (append-only: "we didn't hear back by
// the deadline" remains true forever, exactly as recorded).
func TestLateAckReconcilesAccessLog(t *testing.T) {
	ts, srv, st := newLiveServer(t)
	access, accountID, locationID, deviceID, priv := pairDevice(t, ts)

	code, out := liveJSON(t, ts, "POST", "/v1/access-points", access, map[string]any{
		"location_id": locationID, "name": "Gate", "kind": "gate", "device_id": deviceID,
	})
	if code != http.StatusCreated {
		t.Fatalf("ap create: %d %v", code, out)
	}
	apID := out["id"].(string)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	conn := dialWS(t, ts)
	defer conn.Close(websocket.StatusNormalClosure, "done")

	_, raw, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var ch struct {
		Cnonce string `json:"cnonce"`
	}
	if err := json.Unmarshal(raw, &ch); err != nil {
		t.Fatal(err)
	}
	if err := conn.Write(ctx, websocket.MessageText,
		signAuth(t, priv, deviceID, ch.Cnonce, time.Now().Unix())); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for !srv.Hub().Connected(deviceID) {
		if time.Now().After(deadline) {
			t.Fatal("device never registered in hub")
		}
		time.Sleep(10 * time.Millisecond)
	}

	type openResult struct {
		code     int
		delivery string
	}
	openCh := make(chan openResult, 1)
	go func() {
		code, out := liveJSON(t, ts, "POST", "/v1/access-points/"+apID+"/open", access, map[string]any{})
		d, _ := out["delivery"].(string)
		openCh <- openResult{code, d}
	}()

	// The controller receives the command but — in this test — never acks
	// on time, exactly reproducing the "connected but silent past the
	// deadline" case.
	_, cmdRaw, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var cmd keys.Envelope
	if err := json.Unmarshal(cmdRaw, &cmd); err != nil || cmd.Cmd != "open" {
		t.Fatalf("command: %v %s", err, cmdRaw)
	}

	res := <-openCh
	if res.code != http.StatusOK || res.delivery != "undelivered" {
		t.Fatalf("expected undelivered open, got %+v", res)
	}

	logs, err := st.AccessLogsByAccount(context.Background(), accountID, 10)
	if err != nil {
		t.Fatal(err)
	}
	// The "undelivered" dispatch outcome is now a SEPARATE append-only
	// follow-up row (store.RecordDispatchOutcome, which replaced the old
	// mutate-in-place store.UpdateAccessLogError so the hash chain in
	// store/audithash.go stays meaningful — see that file's doc comment)
	// rather than a mutation of the original "open allowed" row. The
	// follow-up row's own ReconcilesLogID names the true original.
	origID := ""
	for _, l := range logs {
		if l.AccessPointID == apID && l.Command == "open" && l.Error == "undelivered" && l.ReconcilesLogID != "" {
			origID = l.ReconcilesLogID
		}
	}
	if origID == "" {
		t.Fatalf("undelivered dispatch-outcome row not found: %+v", logs)
	}

	// The controller's genuine ack finally lands, well after the ack-wait
	// deadline (500ms in this test server) but well inside hub.LateAckWindow.
	ackMap := map[string]any{
		"v": 0, "typ": "cmd.ack", "device_id": deviceID, "nonce": cmd.Nonce,
		"result": "opened", "ts": time.Now().Unix(),
	}
	canonical, _ := keys.Canonicalize(ackMap)
	ackMap["sig"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, canonical))
	ackRaw, _ := json.Marshal(ackMap)
	if err := conn.Write(ctx, websocket.MessageText, ackRaw); err != nil {
		t.Fatal(err)
	}

	// There are now TWO rows referencing origID: the earlier synchronous
	// "undelivered" dispatch-outcome row (store.RecordDispatchOutcome) and
	// this late-ack reconciliation row (store.ReconcileLateAck) — both are
	// legitimate append-only follow-ups of the same original, and their ts
	// can tie at whole-second resolution, so pick the late-ack one
	// specifically rather than "whichever matches first".
	var reconciled *store.AccessLog
	deadline = time.Now().Add(3 * time.Second)
	for reconciled == nil && time.Now().Before(deadline) {
		logs, err := st.AccessLogsByAccount(context.Background(), accountID, 10)
		if err != nil {
			t.Fatal(err)
		}
		for i := range logs {
			if logs[i].ReconcilesLogID == origID && strings.HasPrefix(logs[i].Error, "late_ack:") {
				reconciled = &logs[i]
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if reconciled == nil {
		t.Fatal("late ack did not reconcile the access_logs row")
	}
	if !reconciled.Success || reconciled.Error != "late_ack:opened" {
		t.Errorf("reconciliation row: success=%v error=%q, want success=true error=late_ack:opened",
			reconciled.Success, reconciled.Error)
	}

	// Append-only discipline: the ORIGINAL "open allowed" row must remain
	// exactly as it was recorded at insert time forever — under the hash
	// chain (store/audithash.go) this is no longer just a convention, it
	// is DB-enforced (access_logs_immutable would abort any attempt to
	// mutate it, and doing so anyway would invalidate every hash after
	// it). "We couldn't reach the controller in time", "we heard back
	// late, it did open", and the original "the request was allowed" are
	// three distinct, equally durable facts, never collapsed into one row.
	logs, err = st.AccessLogsByAccount(context.Background(), accountID, 10)
	if err != nil {
		t.Fatal(err)
	}
	var origFound bool
	for _, l := range logs {
		if l.ID == origID {
			origFound = true
			if l.Error != "" || !l.Success || l.ReconcilesLogID != "" {
				t.Errorf("original row was mutated: %+v", l)
			}
		}
	}
	if !origFound {
		t.Fatal("original row disappeared")
	}
}

func TestControllerWSRejectsBadAuth(t *testing.T) {
	ts, srv, _ := newLiveServer(t)
	_, _, _, deviceID, _ := pairDevice(t, ts)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// attacker key signs the auth → connection refused, never registered
	_, attackerPriv, _ := ed25519.GenerateKey(nil)
	conn := dialWS(t, ts)
	defer conn.Close(websocket.StatusNormalClosure, "done")
	_, raw, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var ch struct {
		Cnonce string `json:"cnonce"`
	}
	json.Unmarshal(raw, &ch)
	conn.Write(ctx, websocket.MessageText, signAuth(t, attackerPriv, deviceID, ch.Cnonce, time.Now().Unix()))
	// server closes on us
	if _, _, err := conn.Read(ctx); err == nil {
		t.Error("expected close after bad auth")
	}
	if srv.Hub().Connected(deviceID) {
		t.Error("bad auth must not register the device")
	}
}

func TestControllerPollFallback(t *testing.T) {
	ts, srv, _ := newLiveServer(t)
	_, _, _, deviceID, priv := pairDevice(t, ts)

	// queue a command while offline
	env, err := srv.keys.SignCommand("open", deviceID, "ap-9", 30*time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out := srv.Hub().Dispatch(context.Background(), deviceID, env, time.Second, "test-log-id"); out.Delivery != "queued" {
		t.Fatalf("expected queued: %+v", out)
	}

	// challenge → signed ws.auth → poll drains the queue
	code, out := liveJSON(t, ts, "POST", "/api/controller/challenge", "", map[string]any{"device_id": deviceID})
	if code != 200 {
		t.Fatalf("challenge: %d %v", code, out)
	}
	cnonce := out["cnonce"].(string)
	authRaw := signAuth(t, priv, deviceID, cnonce, time.Now().Unix())
	res, err := http.Post(ts.URL+"/api/controller/poll", "application/json", bytes.NewReader(authRaw))
	if err != nil {
		t.Fatal(err)
	}
	var pollOut struct {
		Commands     []json.RawMessage `json:"commands"`
		PollInterval int               `json:"poll_interval"`
	}
	json.NewDecoder(res.Body).Decode(&pollOut)
	res.Body.Close()
	if res.StatusCode != 200 || len(pollOut.Commands) != 1 || pollOut.PollInterval != 30 {
		t.Fatalf("poll: %d %+v", res.StatusCode, pollOut)
	}

	// challenge is single-use: same auth replayed → cnonce_replay
	res2, _ := http.Post(ts.URL+"/api/controller/poll", "application/json", bytes.NewReader(authRaw))
	out2 := map[string]any{}
	json.NewDecoder(res2.Body).Decode(&out2)
	res2.Body.Close()
	if res2.StatusCode != http.StatusForbidden || out2["error"] != "cnonce_replay" {
		t.Errorf("poll replay: %d %v", res2.StatusCode, out2)
	}

	// unknown cnonce → cnonce_unknown
	badAuth := signAuth(t, priv, deviceID, "bm90LWEtcmVhbC1jbm9uY2U", time.Now().Unix())
	res3, _ := http.Post(ts.URL+"/api/controller/poll", "application/json", bytes.NewReader(badAuth))
	out3 := map[string]any{}
	json.NewDecoder(res3.Body).Decode(&out3)
	res3.Body.Close()
	if res3.StatusCode != http.StatusForbidden || out3["error"] != "cnonce_unknown" {
		t.Errorf("poll unknown cnonce: %d %v", res3.StatusCode, out3)
	}

	// signed ack over HTTPS resolves nothing (late) but returns ok
	ackMap := map[string]any{
		"v": 0, "typ": "cmd.ack", "device_id": deviceID, "nonce": env.Nonce,
		"result": "opened", "ts": time.Now().Unix(),
	}
	canonical, _ := keys.Canonicalize(ackMap)
	ackMap["sig"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, canonical))
	ackRaw, _ := json.Marshal(ackMap)
	res4, _ := http.Post(ts.URL+"/api/controller/ack", "application/json", bytes.NewReader(ackRaw))
	res4.Body.Close()
	if res4.StatusCode != 200 {
		t.Errorf("http ack: %d", res4.StatusCode)
	}
}
