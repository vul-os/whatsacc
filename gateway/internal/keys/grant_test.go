package keys

// Conformance: proves the PRODUCTION Grant type (this file's signable(),
// used by SignGrant — the same one httpapi's issuance handler calls) is
// byte-identical to proto/vectors/grants.json's "grant-redeem-valid"
// vector, not just conceptually compatible with it.
//
// internal/keys/vectors_test.go (package keys_test) already proves the
// gateway's Canonicalize/Verify primitives reproduce every grants.json
// vector via a STANDALONE reimplementation of the field layout — this test
// is deliberately narrower and complementary: it drives the actual `Grant`
// struct and its unexported signable() (only reachable from an internal
// _test.go in package keys) through the same vector, so a field-name typo
// or ordering mistake in the real issuance type would be caught here even
// if it slipped past the standalone reimplementation.

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func findVectorsDir(t *testing.T) string {
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

func loadGatewayTestKey(t *testing.T, dir string) ed25519.PrivateKey {
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
	seed, err := hex.DecodeString(doc.Keys["gateway"].PrivateSeedHex)
	if err != nil || len(seed) != ed25519.SeedSize {
		t.Fatalf("bad gateway seed in keys.json: %v", err)
	}
	return ed25519.NewKeyFromSeed(seed)
}

// findGrantVector pulls the named vector's grant.object/grant.canonical out
// of grants.json without needing the full vectorfile machinery (that lives
// in the controller module, a separate Go module this one does not depend
// on).
func findGrantVector(t *testing.T, dir, name string) (object json.RawMessage, canonical string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "grants.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Vectors []struct {
			Name  string `json:"name"`
			Grant struct {
				Object    json.RawMessage `json:"object"`
				Canonical string          `json:"canonical"`
			} `json:"grant"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, v := range doc.Vectors {
		if v.Name == name {
			return v.Grant.Object, v.Grant.Canonical
		}
	}
	t.Fatalf("vector %q not found in grants.json", name)
	return nil, ""
}

// TestGrantSignableMatchesVector drives the PRODUCTION Grant.signable() +
// Canonicalize + Sign through proto/vectors/grants.json's
// "grant-redeem-valid" fixture and requires byte-identical canonical JSON
// and a byte-identical signature — proof that SignGrant, called for real
// from the issuance handler, produces objects the unmodified controller
// (which conformance-tests against these same vectors) will accept.
func TestGrantSignableMatchesVector(t *testing.T) {
	dir := findVectorsDir(t)
	gwPriv := loadGatewayTestKey(t, dir)

	objRaw, wantCanonical := findGrantVector(t, dir, "grant-redeem-valid")
	var want struct {
		V            int      `json:"v"`
		Typ          string   `json:"typ"`
		GrantID      string   `json:"grant_id"`
		Member       string   `json:"member"`
		AppPubkey    string   `json:"app_pubkey"`
		Devices      []string `json:"devices"`
		AccessPoints []string `json:"access_points"`
		Windows      []struct {
			Days string `json:"days"`
			From string `json:"from"`
			To   string `json:"to"`
		} `json:"windows"`
		IAT int64  `json:"iat"`
		EXP int64  `json:"exp"`
		Sig string `json:"sig"`
	}
	if err := json.Unmarshal(objRaw, &want); err != nil {
		t.Fatal(err)
	}

	windows := make([]GrantWindow, len(want.Windows))
	for i, w := range want.Windows {
		windows[i] = GrantWindow{Days: w.Days, From: w.From, To: w.To}
	}
	g := &Grant{
		V: want.V, Typ: want.Typ, GrantID: want.GrantID, Member: want.Member,
		AppPubkey: want.AppPubkey, Devices: want.Devices, AccessPoints: want.AccessPoints,
		Windows: windows, IAT: want.IAT, EXP: want.EXP,
	}

	gotCanonical, err := Canonicalize(g.signable())
	if err != nil {
		t.Fatal(err)
	}
	if string(gotCanonical) != wantCanonical {
		t.Fatalf("canonical mismatch:\n got: %s\nwant: %s", gotCanonical, wantCanonical)
	}

	gotSig := base64.RawURLEncoding.EncodeToString(ed25519.Sign(gwPriv, gotCanonical))
	if gotSig != want.Sig {
		t.Fatalf("signature mismatch:\n got: %s\nwant: %s", gotSig, want.Sig)
	}

	// And the reverse direction: Verify accepts the vector's own signature
	// against the derived public key.
	pub := gwPriv.Public().(ed25519.PublicKey)
	if !Verify(pub, gotCanonical, want.Sig) {
		t.Fatal("Verify rejected the vector's genuine signature")
	}
}

// TestSignGrant_ShapeAndTTL exercises the exported production entrypoint
// end to end (not just signable()): field wiring, dedup-free pass-through
// of devices/access_points, and the TTL clamp that bounds the offline
// exposure window (proto/grants.md "What bounds the exposure" — the only
// lever v0 has is keeping this default small; SignGrant must never honor a
// caller-requested TTL beyond it).
func TestSignGrant_ShapeAndTTL(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	k := &Keys{priv: priv, pub: priv.Public().(ed25519.PublicKey)}

	windows := []GrantWindow{{Days: "mon-sun", From: "00:00", To: "24:00"}}
	before := time.Now().Unix()
	g, err := k.SignGrant("grant-1", "member-1", "app-pubkey-b64u",
		[]string{"dev-1", "dev-2"}, []string{"ap-1", "ap-2"}, windows, 30*24*time.Hour /* over the cap */)
	if err != nil {
		t.Fatal(err)
	}
	after := time.Now().Unix()

	if g.V != 0 || g.Typ != "grant" || g.GrantID != "grant-1" || g.Member != "member-1" {
		t.Fatalf("grant fields: %+v", g)
	}
	if len(g.Devices) != 2 || g.Devices[0] != "dev-1" || g.Devices[1] != "dev-2" {
		t.Fatalf("devices not passed through: %v", g.Devices)
	}
	if g.IAT < before || g.IAT > after {
		t.Fatalf("iat %d not in [%d,%d]", g.IAT, before, after)
	}
	// TTL clamp: a 30-day request must be clamped down to DefaultGrantTTL (7d).
	wantMaxEXP := before + int64(DefaultGrantTTL/time.Second)
	if g.EXP > wantMaxEXP+1 { // +1 s slack for the before/after straddle
		t.Fatalf("exp %d exceeds the clamped 7-day bound (%d) — TTL clamp not enforced", g.EXP, wantMaxEXP)
	}
	if g.EXP-g.IAT != int64(DefaultGrantTTL/time.Second) {
		t.Fatalf("exp-iat = %d, want exactly DefaultGrantTTL (%d)", g.EXP-g.IAT, int64(DefaultGrantTTL/time.Second))
	}

	// Signature verifies against the derived public key.
	msg, err := Canonicalize(g.signable())
	if err != nil {
		t.Fatal(err)
	}
	if !Verify(k.pub, msg, g.Sig) {
		t.Fatal("SignGrant produced a signature that does not verify")
	}

	// ttl<=0 also falls back to the default (not zero-lived).
	g2, err := k.SignGrant("grant-2", "member-1", "app-pubkey-b64u", nil, []string{"ap-1"}, windows, 0)
	if err != nil {
		t.Fatal(err)
	}
	if g2.EXP-g2.IAT != int64(DefaultGrantTTL/time.Second) {
		t.Fatalf("ttl<=0 did not fall back to DefaultGrantTTL: exp-iat=%d", g2.EXP-g2.IAT)
	}
}
