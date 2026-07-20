// Conformance against proto/vectors/ — the executable spec. Three layers per
// vector (proto/vectors/README.md): (1) our JCS output byte-equals
// "canonical"; (2) Ed25519 over canonical with the stated signer's seed
// byte-equals "sig" (deterministic), and verifies; (3) the full verifier run
// with the "check" context reproduces expect/reason. Verifiers that live
// outside internal/keys in production (ws.auth, acks, events, offline grant
// redemption) are composed here from the package's primitives so every
// vector is exercised.
package keys_test

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/vul-os/lintel/gateway/internal/keys"
)

// ---------------------------------------------------------------- fixtures

// vectorsDir finds proto/vectors/ from this source file's location, so
// `go test ./...` works from any cwd.
func vectorsDir(t *testing.T) string {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(self)
	for i := 0; i < 8; i++ {
		cand := filepath.Join(dir, "proto", "vectors")
		if st, err := os.Stat(filepath.Join(cand, "keys.json")); err == nil && !st.IsDir() {
			return cand
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatal("proto/vectors/ not found above " + self)
	return ""
}

type testKey struct {
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
}

// loadTestKeys parses keys.json and cross-checks that the published public
// keys really derive from the published seeds.
func loadTestKeys(t *testing.T, dir string) map[string]testKey {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "keys.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Keys map[string]struct {
			PrivateSeedHex string `json:"private_seed_hex"`
			PublicKeyHex   string `json:"public_key_hex"`
			PublicKeyB64u  string `json:"public_key_b64u"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	out := make(map[string]testKey, len(doc.Keys))
	for name, k := range doc.Keys {
		seed, err := hex.DecodeString(k.PrivateSeedHex)
		if err != nil || len(seed) != ed25519.SeedSize {
			t.Fatalf("keys.json %s: bad seed", name)
		}
		priv := ed25519.NewKeyFromSeed(seed)
		pub := priv.Public().(ed25519.PublicKey)
		if hex.EncodeToString(pub) != k.PublicKeyHex {
			t.Errorf("keys.json %s: public_key_hex does not derive from seed", name)
		}
		if base64.RawURLEncoding.EncodeToString(pub) != k.PublicKeyB64u {
			t.Errorf("keys.json %s: public_key_b64u does not derive from seed", name)
		}
		out[name] = testKey{priv: priv, pub: pub}
	}
	if len(out) != 5 {
		t.Errorf("keys.json: got %d keys, want 5", len(out))
	}
	return out
}

// -------------------------------------------------------------- vector I/O

type signedObj struct {
	Signer    *string         `json:"signer"`
	Unsigned  bool            `json:"unsigned"`
	Object    json.RawMessage `json:"object"`
	Canonical string          `json:"canonical"`
}

type challenge struct {
	Cnonce string `json:"cnonce"`
	IAT    int64  `json:"iat"`
	EXP    int64  `json:"exp"`
}

type vecCheck struct {
	Now             int64      `json:"now"`
	DeviceID        string     `json:"device_id"`
	AccessPoints    []string   `json:"access_points"`
	Lockdown        bool       `json:"lockdown"`
	LastGatewaySync int64      `json:"last_gateway_sync"`
	Challenge       *challenge `json:"challenge"`
}

type step struct {
	Signer    *string         `json:"signer"`
	Object    json.RawMessage `json:"object"`
	Canonical string          `json:"canonical"`
	Expect    string          `json:"expect"`
	Reason    string          `json:"reason"`
	Proof     *signedObj      `json:"proof"` // grants.json replay steps
}

type vector struct {
	Name       string          `json:"name"`
	Expect     string          `json:"expect"`
	Reason     string          `json:"reason"`
	Check      vecCheck        `json:"check"`
	Signer     *string         `json:"signer"`
	Unsigned   bool            `json:"unsigned"`
	Object     json.RawMessage `json:"object"`
	Canonical  string          `json:"canonical"`
	Steps      []step          `json:"steps"`
	Grant      *signedObj      `json:"grant"`
	Transcript *struct {
		Open      signedObj  `json:"open"`
		Challenge *challenge `json:"challenge"`
		Proof     *signedObj `json:"proof"`
	} `json:"transcript"`
}

func loadVectors(t *testing.T, dir, file string) []vector {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, file))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Vectors []vector `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("%s: %v", file, err)
	}
	if len(doc.Vectors) == 0 {
		t.Fatalf("%s: no vectors", file)
	}
	return doc.Vectors
}

// ----------------------------------------------------- layers 1 + 2 checks

// jcsMinusSig re-canonicalizes obj with the gateway's JCS, dropping the
// top-level sig member (unless the object is unsigned).
func jcsMinusSig(t *testing.T, obj json.RawMessage, unsigned bool) []byte {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(string(obj)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("decode object: %v", err)
	}
	if !unsigned {
		delete(m, "sig")
	}
	got, err := keys.Canonicalize(m)
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	return got
}

func objSig(t *testing.T, obj json.RawMessage) string {
	t.Helper()
	var m struct {
		Sig string `json:"sig"`
	}
	if err := json.Unmarshal(obj, &m); err != nil {
		t.Fatal(err)
	}
	return m.Sig
}

// checkCanonicalAndSig runs layer 1 (byte-compare JCS) and layer 2 (verify
// sig under the stated signer, and reproduce it exactly by deterministic
// re-signing). For signer == null (tampered), layer 2 is skipped — the
// verdict layer proves rejection.
func checkCanonicalAndSig(t *testing.T, tk map[string]testKey, signer *string, unsigned bool, obj json.RawMessage, canonical string) {
	t.Helper()
	got := jcsMinusSig(t, obj, unsigned)
	if string(got) != canonical {
		t.Errorf("JCS mismatch:\n got  %s\n want %s", got, canonical)
	}
	if unsigned || signer == nil {
		return
	}
	k, ok := tk[*signer]
	if !ok {
		t.Fatalf("unknown signer %q", *signer)
	}
	sig := objSig(t, obj)
	if !keys.Verify(k.pub, []byte(canonical), sig) {
		t.Errorf("sig does not verify under stated signer %q", *signer)
	}
	resigned := base64.RawURLEncoding.EncodeToString(ed25519.Sign(k.priv, []byte(canonical)))
	if resigned != sig {
		t.Errorf("deterministic re-sign mismatch:\n got  %s\n want %s", resigned, sig)
	}
}

// assertVerdict compares a verifier outcome (reason == "" means accept)
// against the vector's expect/reason.
func assertVerdict(t *testing.T, gotReason, expect, wantReason string) {
	t.Helper()
	switch expect {
	case "accept":
		if gotReason != "" {
			t.Errorf("verdict: got reject(%s), want accept", gotReason)
		}
	case "reject":
		if gotReason == "" {
			t.Errorf("verdict: got accept, want reject(%s)", wantReason)
		} else if gotReason != wantReason {
			t.Errorf("verdict: got reject(%s), want reject(%s)", gotReason, wantReason)
		}
	default:
		t.Fatalf("bad expect %q", expect)
	}
}

// ------------------------------------------------------------ commands.json

func decodeEnvelope(t *testing.T, obj json.RawMessage) *keys.Envelope {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(string(obj)))
	dec.DisallowUnknownFields() // an unknown field would silently escape the sig
	var e keys.Envelope
	if err := dec.Decode(&e); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	return &e
}

func commandReason(t *testing.T, gw ed25519.PublicKey, obj json.RawMessage, check vecCheck, seen keys.NonceSet) string {
	t.Helper()
	err := keys.VerifyCommand(gw, decodeEnvelope(t, obj), keys.VerifyContext{
		Now:          check.Now,
		DeviceID:     check.DeviceID,
		AccessPoints: check.AccessPoints,
		Lockdown:     check.Lockdown,
		Seen:         seen,
	})
	if err == nil {
		return ""
	}
	rej, ok := err.(*keys.Reject)
	if !ok {
		t.Fatalf("VerifyCommand returned non-Reject error: %v", err)
	}
	return rej.Reason
}

func TestVectorsCommands(t *testing.T) {
	dir := vectorsDir(t)
	tk := loadTestKeys(t, dir)
	vecs := loadVectors(t, dir, "commands.json")
	objects := 0
	for _, v := range vecs {
		t.Run(v.Name, func(t *testing.T) {
			seen := keys.NonceSet{}
			steps := v.Steps
			if steps == nil {
				steps = []step{{Signer: v.Signer, Object: v.Object, Canonical: v.Canonical, Expect: v.Expect, Reason: v.Reason}}
			}
			for i, s := range steps {
				objects++
				checkCanonicalAndSig(t, tk, s.Signer, false, s.Object, s.Canonical)
				got := commandReason(t, tk["gateway"].pub, s.Object, v.Check, seen)
				if len(steps) > 1 {
					t.Logf("step %d", i)
				}
				assertVerdict(t, got, s.Expect, s.Reason)
			}
		})
	}
	t.Logf("commands.json: %d vectors, %d signed objects exercised", len(vecs), objects)
}

// ------------------------------------------------------------ pairing.json

type wsAuth struct {
	V        int    `json:"v"`
	Typ      string `json:"typ"`
	DeviceID string `json:"device_id"`
	Cnonce   string `json:"cnonce"`
	TS       int64  `json:"ts"`
	Sig      string `json:"sig"`
}

// verifyWSAuth is the gateway-side ws.auth check (pairing.md), composed from
// keys primitives: sig against the enrolled controller key, then the issued
// cnonce (unknown/expired), then ts freshness within ±ClockSkewSeconds.
func verifyWSAuth(t *testing.T, controllerPub ed25519.PublicKey, obj json.RawMessage, check vecCheck) string {
	t.Helper()
	var a wsAuth
	if err := json.Unmarshal(obj, &a); err != nil {
		t.Fatal(err)
	}
	if !keys.Verify(controllerPub, jcsMinusSig(t, obj, false), a.Sig) {
		return "badsig"
	}
	if a.DeviceID != check.DeviceID {
		return "wrong_device"
	}
	ch := check.Challenge
	if ch == nil || a.Cnonce != ch.Cnonce {
		return "cnonce_unknown"
	}
	if check.Now > ch.EXP {
		return "cnonce_expired"
	}
	if a.TS < check.Now-keys.ClockSkewSeconds {
		return "expired"
	}
	if a.TS > check.Now+keys.ClockSkewSeconds {
		return "not_yet_valid"
	}
	return ""
}

func TestVectorsPairing(t *testing.T) {
	dir := vectorsDir(t)
	tk := loadTestKeys(t, dir)
	vecs := loadVectors(t, dir, "pairing.json")
	for _, v := range vecs {
		t.Run(v.Name, func(t *testing.T) {
			checkCanonicalAndSig(t, tk, v.Signer, v.Unsigned, v.Object, v.Canonical)
			if v.Unsigned {
				// pair.redeem / pair.grant / ws.challenge: canonical-form
				// vectors only; authenticity rides on TLS + claim token.
				return
			}
			got := verifyWSAuth(t, tk["controller"].pub, v.Object, v.Check)
			assertVerdict(t, got, v.Expect, v.Reason)
		})
	}
	t.Logf("pairing.json: %d vectors", len(vecs))
}

// ------------------------------------------------ acks.json + events.json

// verifyFromController is the gateway-side check shared by cmd.ack and
// event: sig against the device's enrolled controller key.
func verifyFromController(t *testing.T, controllerPub ed25519.PublicKey, obj json.RawMessage, check vecCheck) string {
	t.Helper()
	var m struct {
		DeviceID string `json:"device_id"`
		Sig      string `json:"sig"`
	}
	if err := json.Unmarshal(obj, &m); err != nil {
		t.Fatal(err)
	}
	if !keys.Verify(controllerPub, jcsMinusSig(t, obj, false), m.Sig) {
		return "badsig"
	}
	if m.DeviceID != check.DeviceID {
		return "wrong_device"
	}
	return ""
}

func TestVectorsAcks(t *testing.T) {
	dir := vectorsDir(t)
	tk := loadTestKeys(t, dir)
	vecs := loadVectors(t, dir, "acks.json")
	for _, v := range vecs {
		t.Run(v.Name, func(t *testing.T) {
			checkCanonicalAndSig(t, tk, v.Signer, false, v.Object, v.Canonical)
			got := verifyFromController(t, tk["controller"].pub, v.Object, v.Check)
			assertVerdict(t, got, v.Expect, v.Reason)
		})
	}
	t.Logf("acks.json: %d vectors", len(vecs))
}

func TestVectorsEvents(t *testing.T) {
	dir := vectorsDir(t)
	tk := loadTestKeys(t, dir)
	vecs := loadVectors(t, dir, "events.json")
	for _, v := range vecs {
		t.Run(v.Name, func(t *testing.T) {
			checkCanonicalAndSig(t, tk, v.Signer, false, v.Object, v.Canonical)
			got := verifyFromController(t, tk["controller"].pub, v.Object, v.Check)
			assertVerdict(t, got, v.Expect, v.Reason)
		})
	}
	t.Logf("events.json: %d vectors", len(vecs))
}

// ------------------------------------------------------------- grants.json

type grantObj struct {
	GrantID      string `json:"grant_id"`
	AppPubkey    string `json:"app_pubkey"`
	Devices      []string
	AccessPoints []string `json:"access_points"`
	Windows      []struct {
		Days string `json:"days"`
		From string `json:"from"`
		To   string `json:"to"`
	} `json:"windows"`
	IAT int64 `json:"iat"`
	EXP int64 `json:"exp"`
}

type grantProof struct {
	GrantID     string `json:"grant_id"`
	Cnonce      string `json:"cnonce"`
	AccessPoint string `json:"access_point"`
	TS          int64  `json:"ts"`
	Sig         string `json:"sig"`
}

const staleClockLimit = 1209600 // 14 d, grants.md clock rule

var weekdays = map[string]int{"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}

func parseHM(t *testing.T, s string) int {
	t.Helper()
	var h, m int
	if _, err := fmt.Sscanf(s, "%d:%d", &h, &m); err != nil {
		t.Fatalf("bad HH:MM %q", s)
	}
	return h*60 + m // "24:00" => 1440, end of day (to is exclusive)
}

func inWindows(t *testing.T, g grantObj, now int64) bool {
	t.Helper()
	tm := time.Unix(now, 0).UTC() // controller tz default UTC
	day := (int(tm.Weekday()) + 6) % 7
	minute := tm.Hour()*60 + tm.Minute()
	for _, w := range g.Windows {
		lo, hi := w.Days, w.Days
		if i := strings.IndexByte(w.Days, '-'); i >= 0 {
			lo, hi = w.Days[:i], w.Days[i+1:]
		}
		dLo, okLo := weekdays[lo]
		dHi, okHi := weekdays[hi]
		if !okLo || !okHi {
			t.Fatalf("bad days %q", w.Days)
		}
		if day >= dLo && day <= dHi && minute >= parseHM(t, w.From) && minute < parseHM(t, w.To) {
			return true
		}
	}
	return false
}

// verifyGrantRedemption is the controller-side offline redemption decision
// (grants.md verification order, fail-closed), composed from keys
// primitives. Returns "" to open, else the reject reason.
func verifyGrantRedemption(t *testing.T, gwPub ed25519.PublicKey, grantRaw, proofRaw json.RawMessage, openAP string, ch *challenge, check vecCheck, usedCnonces keys.NonceSet) string {
	t.Helper()
	var g grantObj
	if err := json.Unmarshal(grantRaw, &g); err != nil {
		t.Fatal(err)
	}
	var p grantProof
	if err := json.Unmarshal(proofRaw, &p); err != nil {
		t.Fatal(err)
	}
	// 1. Stale-clock refusal.
	if check.Now-check.LastGatewaySync > staleClockLimit {
		return "stale_clock"
	}
	// 2. Lockdown refuses all offline opens.
	if check.Lockdown {
		return "lockdown"
	}
	// 3. Grant signature against the pinned gateway key.
	if !keys.Verify(gwPub, jcsMinusSig(t, grantRaw, false), objSig(t, grantRaw)) {
		return "badsig"
	}
	// 4. Grant validity, skew on both bounds.
	if check.Now < g.IAT-keys.ClockSkewSeconds {
		return "not_yet_valid"
	}
	if check.Now > g.EXP+keys.ClockSkewSeconds {
		return "expired"
	}
	// 5. This controller is covered.
	found := false
	for _, d := range g.Devices {
		if d == check.DeviceID {
			found = true
			break
		}
	}
	if !found {
		return "wrong_device"
	}
	// 6. Requested access point granted and consistent with the proof.
	found = false
	for _, ap := range g.AccessPoints {
		if ap == openAP {
			found = true
			break
		}
	}
	if !found || p.AccessPoint != openAP {
		return "wrong_access_point"
	}
	// 7. Inside a time window.
	if !inWindows(t, g, check.Now) {
		return "window"
	}
	// 8. Proof is for this grant.
	if p.GrantID != g.GrantID {
		return "wrong_grant"
	}
	// 9. Proof signature against the app key bound in the grant.
	appPub, err := base64.RawURLEncoding.DecodeString(g.AppPubkey)
	if err != nil || len(appPub) != ed25519.PublicKeySize {
		return "badsig"
	}
	if !keys.Verify(ed25519.PublicKey(appPub), jcsMinusSig(t, proofRaw, false), p.Sig) {
		return "badsig"
	}
	// 10. Our live, single-use cnonce.
	if ch == nil || p.Cnonce != ch.Cnonce {
		return "cnonce_unknown"
	}
	if check.Now > ch.EXP {
		return "cnonce_expired"
	}
	if usedCnonces.Seen(p.Cnonce) {
		return "cnonce_replay"
	}
	// 11. Proof timestamp fresh, skew both ways.
	if p.TS < check.Now-keys.ClockSkewSeconds {
		return "expired"
	}
	if p.TS > check.Now+keys.ClockSkewSeconds {
		return "not_yet_valid"
	}
	usedCnonces.Mark(p.Cnonce)
	return ""
}

func TestVectorsGrants(t *testing.T) {
	dir := vectorsDir(t)
	tk := loadTestKeys(t, dir)
	vecs := loadVectors(t, dir, "grants.json")
	for _, v := range vecs {
		t.Run(v.Name, func(t *testing.T) {
			if v.Grant == nil || v.Transcript == nil {
				t.Fatal("vector missing grant/transcript")
			}
			// Layers 1+2 on every signed/unsigned object in the transcript.
			checkCanonicalAndSig(t, tk, v.Grant.Signer, false, v.Grant.Object, v.Grant.Canonical)
			checkCanonicalAndSig(t, tk, v.Transcript.Open.Signer, true, v.Transcript.Open.Object, v.Transcript.Open.Canonical)
			var open struct {
				AccessPoint string `json:"access_point"`
			}
			if err := json.Unmarshal(v.Transcript.Open.Object, &open); err != nil {
				t.Fatal(err)
			}
			used := keys.NonceSet{}
			steps := v.Steps
			if steps == nil {
				steps = []step{{Proof: v.Transcript.Proof, Expect: v.Expect, Reason: v.Reason}}
			}
			for i, s := range steps {
				if s.Proof == nil {
					t.Fatal("step missing proof")
				}
				checkCanonicalAndSig(t, tk, s.Proof.Signer, false, s.Proof.Object, s.Proof.Canonical)
				got := verifyGrantRedemption(t, tk["gateway"].pub, v.Grant.Object, s.Proof.Object, open.AccessPoint, v.Transcript.Challenge, v.Check, used)
				if len(steps) > 1 {
					t.Logf("step %d", i)
				}
				assertVerdict(t, got, s.Expect, s.Reason)
			}
		})
	}
	t.Logf("grants.json: %d vectors", len(vecs))
}
