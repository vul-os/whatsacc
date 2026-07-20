// Package e2e is the lintel cross-module integration suite. Each test boots
// a REAL gateway binary and (mostly) a REAL controller binary and drives them
// over the real wire (HTTP + WebSocket + LAN grant HTTP), asserting the two
// independent implementations agree on the proto/ contracts.
//
// See README.md for the wiring rationale and the interop findings this suite
// surfaced.
package e2e

import (
	"net/http"
	"testing"
	"time"
)

// TestMoneyPath is THE assertion: a member opens an access point; the gateway
// runs its verdict, signs an `open` envelope, pushes it over the WebSocket; the
// real controller verifies it against the pinned gateway key, pulses its relay,
// and returns a signed cmd.ack; the gateway correlates the ack by nonce and
// records `acked` on the audit row.
func TestMoneyPath(t *testing.T) {
	gw := startGateway(t)
	ten := gw.register(t)
	dev, claim := gw.createDevice(t, ten, "gate-controller")
	ap := gw.createAP(t, ten, "Main Gate", dev)
	c := startController(t, gw, ten, dev, claim, ap)

	start := time.Now()
	st, delivery, body := gw.open(t, ten, ap)
	elapsed := time.Since(start)

	if st != http.StatusOK {
		t.Fatalf("open: status %d, body %v", st, body)
	}
	// The money assertion. delivery=="acked" can ONLY happen if the gateway's
	// hub matched the returned cmd.ack to the pending dispatch BY NONCE
	// (hub.ResolveAck keys on env.Nonce) — so "acked" intrinsically proves the
	// signed nonce round-tripped intact and the ack verified against the
	// enrolled controller key.
	if delivery != "acked" {
		t.Fatalf("delivery = %q, want \"acked\" (nonce round-trip / ack correlation failed)", delivery)
	}
	// Timing: the whole sign→push→verify→pulse→ack→correlate cycle completed
	// well within the gateway's 5s ack deadline (AckTimeout).
	if elapsed >= 5*time.Second {
		t.Fatalf("open round-trip took %s, want < 5s ack window", elapsed)
	}
	t.Logf("open→acked round-trip: %s", elapsed)

	// The relay physically pulsed (mock relay state transition, no HTTP surface
	// — observed via the controller's own log).
	if !c.logs.waitLines(1, 5*time.Second, "relay", "state=pulsing") {
		t.Fatalf("controller relay never pulsed; log:\n%s", c.logs.String())
	}
	// And the controller reported the actuation result as opened.
	if !c.logs.waitLines(1, 3*time.Second, "msg=command", "cmd=open", "result=opened") {
		t.Fatalf("controller did not record cmd=open result=opened; log:\n%s", c.logs.String())
	}

	// The audit row shows success with NO error tag: an undelivered/denied ack
	// would have stamped error='undelivered' / 'ack:denied:…' (open.go
	// dispatchCommand). A clean nil error == the controller acked success.
	row := gw.auditRowForAP(t, ten, ap)
	if row == nil {
		t.Fatalf("no audit row for AP %s", ap)
	}
	if row["success"] != true {
		t.Fatalf("audit row success = %v, want true; row=%v", row["success"], row)
	}
	if row["error"] != nil {
		t.Fatalf("audit row error = %v, want nil (nil == acked-success)", row["error"])
	}
	if row["command"] != "open" {
		t.Fatalf("audit row command = %v, want open", row["command"])
	}
}

// TestClose_Acked proves the second actuation direction round-trips too.
func TestClose_Acked(t *testing.T) {
	gw := startGateway(t)
	ten := gw.register(t)
	dev, claim := gw.createDevice(t, ten, "gate-controller")
	ap := gw.createAP(t, ten, "Main Gate", dev)
	c := startController(t, gw, ten, dev, claim, ap)

	st, body, raw := httpJSON(t, http.MethodPost, gw.url+"/v1/access-points/"+ap+"/close", ten.token, map[string]any{"source": "api"})
	if st != http.StatusOK {
		t.Fatalf("close: %d %s", st, raw)
	}
	if body["delivery"] != "acked" || body["command"] != "close" {
		t.Fatalf("close body = %v, want delivery=acked command=close", body)
	}
	if !c.logs.waitLines(1, 3*time.Second, "msg=command", "cmd=close", "result=closed") {
		t.Fatalf("controller did not record cmd=close result=closed; log:\n%s", c.logs.String())
	}
}

// TestOpen_NoDevice: an access point with no controller attached still logs the
// open (backend parity) but reports delivery "no_device" — nothing dispatched.
func TestOpen_NoDevice(t *testing.T) {
	gw := startGateway(t)
	ten := gw.register(t)
	ap := gw.createAP(t, ten, "Unwired Gate", "") // no device bound

	st, delivery, body := gw.open(t, ten, ap)
	if st != http.StatusOK {
		t.Fatalf("open: %d %v", st, body)
	}
	if delivery != "no_device" {
		t.Fatalf("delivery = %q, want no_device", delivery)
	}
}

// TestOpen_Queued: an access point bound to a device whose controller is not
// connected queues the signed command for the poll fallback → delivery "queued".
func TestOpen_Queued(t *testing.T) {
	gw := startGateway(t)
	ten := gw.register(t)
	dev, _ := gw.createDevice(t, ten, "offline-controller") // created, never paired/connected
	ap := gw.createAP(t, ten, "Offline Gate", dev)

	st, delivery, body := gw.open(t, ten, ap)
	if st != http.StatusOK {
		t.Fatalf("open: %d %v", st, body)
	}
	if delivery != "queued" {
		t.Fatalf("delivery = %q, want queued", delivery)
	}
}

// TestRateLimit_NeverReachesController: a denied open (open_cooldown, default
// 10s) is rejected at the gateway BEFORE dispatch, so the controller sees no
// second command and the relay does not pulse again.
func TestRateLimit_NeverReachesController(t *testing.T) {
	gw := startGateway(t)
	ten := gw.register(t)
	dev, claim := gw.createDevice(t, ten, "gate-controller")
	ap := gw.createAP(t, ten, "Main Gate", dev)
	c := startController(t, gw, ten, dev, claim, ap)

	// First open succeeds and pulses once.
	if st, delivery, body := gw.open(t, ten, ap); st != 200 || delivery != "acked" {
		t.Fatalf("first open: st=%d delivery=%q body=%v", st, delivery, body)
	}
	if !c.logs.waitLines(1, 5*time.Second, "relay", "state=pulsing") {
		t.Fatalf("first open did not pulse; log:\n%s", c.logs.String())
	}
	pulseBefore := c.logs.countLines("relay", "state=pulsing")
	cmdBefore := c.logs.countLines("msg=command")

	// Second open, immediately: denied by the cooldown → 429, not dispatched.
	st, body, raw := httpJSON(t, http.MethodPost, gw.url+"/v1/access-points/"+ap+"/open", ten.token, map[string]any{"source": "api"})
	if st != http.StatusTooManyRequests {
		t.Fatalf("second open: status %d (want 429); body %s", st, raw)
	}
	if body["error"] != "rate_limited" {
		t.Fatalf("second open error = %v, want rate_limited", body["error"])
	}

	// The controller must not have seen the denied open. Dispatch is
	// synchronous in the gateway handler, which returned 429 without
	// dispatching; verify no new pulse/command appears (bounded settle).
	deadline := time.Now().Add(400 * time.Millisecond)
	for time.Now().Before(deadline) {
		if got := c.logs.countLines("relay", "state=pulsing"); got != pulseBefore {
			t.Fatalf("relay pulsed on a rate-limited open (%d → %d)", pulseBefore, got)
		}
		if got := c.logs.countLines("msg=command"); got != cmdBefore {
			t.Fatalf("controller processed a command on a rate-limited open (%d → %d)", cmdBefore, got)
		}
		time.Sleep(40 * time.Millisecond)
	}
}

// TestControllerEvent_FlowsToGateway: after an open, the controller records an
// `opened` event, signs it, and drains it over the SAME WebSocket; the gateway
// verifies it against the enrolled key and accepts it.
//
// FINDING (reported): the gateway does NOT persist controller events — it logs
// "controller event" and drops them. There is no event store and no API to
// read them back, so the strongest cross-module observable is the gateway log.
func TestControllerEvent_FlowsToGateway(t *testing.T) {
	gw := startGateway(t)
	ten := gw.register(t)
	dev, claim := gw.createDevice(t, ten, "gate-controller")
	ap := gw.createAP(t, ten, "Main Gate", dev)
	c := startController(t, gw, ten, dev, claim, ap)

	before := gw.logs.countLines("controller event", dev)
	if st, delivery, body := gw.open(t, ten, ap); st != 200 || delivery != "acked" {
		t.Fatalf("open: st=%d delivery=%q body=%v", st, delivery, body)
	}
	// A NEW controller event (the `opened` event from the command) reached and
	// was accepted by the gateway.
	if !gw.logs.waitLines(before+1, 8*time.Second, "controller event", dev) {
		t.Fatalf("opened event never reached gateway for device %s; gateway log:\n%s", dev, gw.logs.String())
	}
	_ = c
}

// TestOfflineGrant_Redeem: the "app" (this harness) presents a gateway-signed
// grant (proto/grants.md) to the controller's LAN listener with the gateway
// absent from the transaction; the controller verifies grant + proof offline
// against its pinned key, pulses the relay, and queues grant_redeemed + opened
// events which drain to the gateway over the live WS.
func TestOfflineGrant_Redeem(t *testing.T) {
	gw := startGateway(t)
	ten := gw.register(t)
	dev, claim := gw.createDevice(t, ten, "gate-controller")
	ap := gw.createAP(t, ten, "Main Gate", dev)
	c := startController(t, gw, ten, dev, claim, ap)
	c.waitLAN(t)

	appPriv, appPub := newAppKey(t)
	now := time.Now().Unix()
	g := grantWire(t, gw, appPub, []string{dev}, []string{ap}, now)
	gid := grantIDOf(t, g)

	pulseBefore := c.logs.countLines("relay", "state=pulsing")
	evBefore := gw.logs.countLines("controller event", dev)

	cn := grantOpen(t, c, g, ap)
	result, detail := grantProof(t, c, appPriv, gid, cn, ap, now)
	if result != "opened" {
		t.Fatalf("grant.result = %q (detail %q), want opened", result, detail)
	}
	// Relay pulsed for the offline grant.
	if !c.logs.waitLines(pulseBefore+1, 5*time.Second, "relay", "state=pulsing") {
		t.Fatalf("relay did not pulse for offline grant; log:\n%s", c.logs.String())
	}
	// grant_redeemed + opened events drained to the gateway.
	if !gw.logs.waitLines(evBefore+1, 8*time.Second, "controller event", dev) {
		t.Fatalf("grant_redeemed event never drained to gateway; gateway log:\n%s", gw.logs.String())
	}
}

// TestOfflineGrant_Rejects drives adversarial inputs at the REAL controller's
// grants.Exchange over the real LAN wire — the one controller-side verification
// surface reachable from an external harness (the WS command path only accepts
// input from the pinned gateway, which the harness cannot impersonate).
// Every rejection must fail-closed with no relay pulse.
func TestOfflineGrant_Rejects(t *testing.T) {
	gw := startGateway(t)
	ten := gw.register(t)
	dev, claim := gw.createDevice(t, ten, "gate-controller")
	ap := gw.createAP(t, ten, "Main Gate", dev)
	c := startController(t, gw, ten, dev, claim, ap)
	c.waitLAN(t)

	appPriv, appPub := newAppKey(t)
	now := time.Now().Unix()

	// (a) tampered grant → badsig.
	valid := grantWire(t, gw, appPub, []string{dev}, []string{ap}, now)
	gid := grantIDOf(t, valid)
	tampered := tamperGrant(t, valid)
	cn := grantOpen(t, c, tampered, ap)
	if res, det := grantProof(t, c, appPriv, gid, cn, ap, now); res != "denied" || det != "badsig" {
		t.Fatalf("tampered grant: result=%q detail=%q, want denied/badsig", res, det)
	}

	// (b) grant for a different device → wrong_device.
	wrongDev := grantWire(t, gw, appPub, []string{"device-not-this-one"}, []string{ap}, now)
	gidWD := grantIDOf(t, wrongDev)
	cn = grantOpen(t, c, wrongDev, ap)
	if res, det := grantProof(t, c, appPriv, gidWD, cn, ap, now); res != "denied" || det != "wrong_device" {
		t.Fatalf("wrong-device grant: result=%q detail=%q, want denied/wrong_device", res, det)
	}

	// So far: no pulse should have happened.
	if got := c.logs.countLines("relay", "state=pulsing"); got != 0 {
		t.Fatalf("relay pulsed on a denied grant (count=%d)", got)
	}

	// (c) replay: a valid redemption opens once; re-presenting the SAME proof
	// (same cnonce) is rejected cnonce_replay and does NOT pulse again.
	okGrant := grantWire(t, gw, appPub, []string{dev}, []string{ap}, now)
	gidOK := grantIDOf(t, okGrant)
	cn = grantOpen(t, c, okGrant, ap)
	proof := signedProof(t, appPriv, gidOK, cn, ap, now)
	if res, det := postProof(t, c, proof); res != "opened" {
		t.Fatalf("valid grant: result=%q detail=%q, want opened", res, det)
	}
	if !c.logs.waitLines(1, 5*time.Second, "relay", "state=pulsing") {
		t.Fatalf("valid grant did not pulse; log:\n%s", c.logs.String())
	}
	if res, det := postProof(t, c, proof); res != "denied" || det != "cnonce_replay" {
		t.Fatalf("replayed proof: result=%q detail=%q, want denied/cnonce_replay", res, det)
	}
	// Exactly one pulse total (the single valid redemption).
	if got := c.logs.countLines("relay", "state=pulsing"); got != 1 {
		t.Fatalf("relay pulse count = %d, want exactly 1 (replay must not pulse)", got)
	}
}

// TestLockdown_DeniesOfflineRedeem exercises the lockdown matrix end-to-end.
// No gateway API can push a `lockdown` command (dispatch is open/close only —
// reported gap), so the latch is set through the controller-sim's stdin
// override, then a valid offline grant is denied `lockdown` by the REAL
// grants.Exchange over the wire, with no relay pulse.
func TestLockdown_DeniesOfflineRedeem(t *testing.T) {
	gw := startGateway(t)
	ten := gw.register(t)
	dev, claim := gw.createDevice(t, ten, "sim-controller")

	s := startSim(t, gw, dev, claim)
	s.send(t, "lockdown")
	s.send(t, "status")
	if !s.logs.waitLines(1, 5*time.Second, "lockdown=true") {
		t.Fatalf("sim did not latch lockdown; log:\n%s", s.logs.String())
	}

	appPriv, appPub := newAppKey(t)
	now := time.Now().Unix()
	// The sim serves "main"/"pedestrian"; grants are keyed on device + the
	// grant's own access_points, so use "main".
	g := grantWire(t, gw, appPub, []string{dev}, []string{"main"}, now)
	gid := grantIDOf(t, g)

	cn := grantOpen(t, s.controller, g, "main")
	res, det := grantProof(t, s.controller, appPriv, gid, cn, "main", now)
	if res != "denied" || det != "lockdown" {
		t.Fatalf("locked-down redeem: result=%q detail=%q, want denied/lockdown", res, det)
	}
	if got := s.logs.countLines("relay", "state=pulsing"); got != 0 {
		t.Fatalf("relay pulsed while locked down (count=%d)", got)
	}
}

// TestPairing_PathContract locks in the fix for interop finding #1: the
// controller constructs its redeem request at <gateway>/pair/redeem
// (proto/pairing.md's own flow diagram), and the gateway now serves the redeem
// handler there (spec form) as well as the /api alias. Both paths must return
// pair.grant and burn the single-use claim.
func TestPairing_PathContract(t *testing.T) {
	gw := startGateway(t)
	ten := gw.register(t)

	_, fakePub := newAppKey(t) // any valid ed25519 pubkey is a legal controller_pubkey
	redeemBody := func(claim string) map[string]any {
		return map[string]any{
			"v": 0, "typ": "pair.redeem", "claim_token": claim,
			"controller_pubkey": fakePub,
			"hw":                map[string]any{"model": "lintel-ref", "fw": "0.1.0", "ifaces": []string{"wifi"}},
		}
	}

	// Each path gets its own device+claim (claims are single-use).
	for _, path := range []string{"/pair/redeem", "/api/pair/redeem"} {
		_, claim := gw.createDevice(t, ten, "gate-controller")
		st, body, raw := httpJSON(t, http.MethodPost, gw.url+path, "", redeemBody(claim))
		if st != http.StatusOK || body["typ"] != "pair.grant" {
			t.Fatalf("%s should return pair.grant, got %d %s", path, st, raw)
		}
		if body["gateway_pubkey"] == nil || body["ws_url"] == nil {
			t.Fatalf("%s pair.grant missing gateway_pubkey/ws_url: %s", path, raw)
		}
		// Single-use: replaying the burned claim is rejected.
		stReplay, _, _ := httpJSON(t, http.MethodPost, gw.url+path, "", redeemBody(claim))
		if stReplay == http.StatusOK {
			t.Fatalf("%s replayed a burned claim (status %d)", path, stReplay)
		}
	}
}

// TestPairing_DocumentedInvocationWorks proves the fix with the REAL controller
// binary: invoked the way its README documents (bare --gateway, no /api), it
// pairs successfully and establishes its authenticated WS session.
func TestPairing_DocumentedInvocationWorks(t *testing.T) {
	gw := startGateway(t)
	ten := gw.register(t)
	dev, claim := gw.createDevice(t, ten, "gate-controller")

	logs := &logBuf{}
	lan := freePort(t)
	cmd := execController(gw.url /* bare, NO /api */, claim, dev, lan, logs)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start controller: %v", err)
	}
	t.Cleanup(func() { killProc(cmd); t.Logf("controller log:\n%s", logs.String()) })

	// The controller should pair over the documented bare path and connect its WS.
	if !logs.waitLines(1, 20*time.Second, "gateway connected") {
		t.Fatalf("controller (documented bare --gateway) did not pair + connect; log:\n%s", logs.String())
	}
}
