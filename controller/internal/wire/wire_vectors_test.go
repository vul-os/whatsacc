package wire_test

import (
	"crypto/ed25519"
	"encoding/json"
	"testing"

	"github.com/vul-os/lintel/controller/internal/vectorfile"
	"github.com/vul-os/lintel/controller/internal/wire"
)

func loadAll(t *testing.T) (string, map[string]ed25519.PrivateKey, map[string]ed25519.PublicKey) {
	t.Helper()
	dir, err := vectorfile.FindDir("")
	if err != nil {
		t.Fatal(err)
	}
	keys, err := vectorfile.LoadKeys(dir)
	if err != nil {
		t.Fatal(err)
	}
	privs := map[string]ed25519.PrivateKey{}
	pubs := map[string]ed25519.PublicKey{}
	for name, k := range keys.Keys {
		seed, err := k.Seed()
		if err != nil {
			t.Fatal(err)
		}
		priv := ed25519.NewKeyFromSeed(seed)
		privs[name] = priv
		pubs[name] = priv.Public().(ed25519.PublicKey)
	}
	return dir, privs, pubs
}

// TestSignaturesReproduceVectors is conformance layer 2: Ed25519 is
// deterministic, so signing each vector's canonical bytes with the declared
// signer's seed must reproduce object.sig exactly.
func TestSignaturesReproduceVectors(t *testing.T) {
	dir, privs, _ := loadAll(t)
	signed := 0
	for _, name := range []string{"pairing.json", "commands.json", "grants.json", "events.json", "acks.json"} {
		f, err := vectorfile.Load(dir, name)
		if err != nil {
			t.Fatal(err)
		}
		for _, v := range f.Vectors {
			try := func(label, signer string, obj json.RawMessage, canonical string) {
				t.Helper()
				if signer == "" || canonical == "" || len(obj) == 0 {
					return
				}
				priv, ok := privs[signer]
				if !ok {
					t.Fatalf("unknown signer %q", signer)
				}
				var m map[string]any
				if err := json.Unmarshal(obj, &m); err != nil {
					t.Fatal(err)
				}
				wantSig, _ := m["sig"].(string)
				gotSig := wire.Sign(priv, []byte(canonical))
				if gotSig != wantSig {
					t.Errorf("%s/%s/%s: signature mismatch\n got: %s\nwant: %s", name, v.Name, label, gotSig, wantSig)
				}
				signed++
			}
			try("object", v.Signer, v.Object, v.Canonical)
			if v.Grant != nil {
				try("grant", v.Grant.Signer, v.Grant.Object, v.Grant.Canonical)
			}
			if v.Transcript != nil && v.Transcript.Proof != nil {
				try("proof", v.Transcript.Proof.Signer, v.Transcript.Proof.Object, v.Transcript.Proof.Canonical)
			}
			for _, st := range v.Steps {
				try("step", st.Signer, st.Object, st.Canonical)
				if st.Proof != nil {
					try("step-proof", st.Proof.Signer, st.Proof.Object, st.Proof.Canonical)
				}
			}
		}
	}
	if signed < 40 {
		t.Errorf("expected to reproduce ≥40 signatures, did %d", signed)
	}
	t.Logf("reproduced %d vector signatures byte-for-byte", signed)
}

// TestVerifyRawAgainstVectors: layer 3 for the pure signature dimension —
// VerifyRaw accepts genuine signer/pub pairings and rejects attacker/
// tampered objects against the gateway or controller key they claim.
func TestVerifyRawAgainstVectors(t *testing.T) {
	dir, _, pubs := loadAll(t)
	cases := []struct {
		file string
		pub  ed25519.PublicKey
	}{
		{"commands.json", pubs["gateway"]},
		{"events.json", pubs["controller"]},
		{"acks.json", pubs["controller"]},
	}
	for _, c := range cases {
		f, err := vectorfile.Load(dir, c.file)
		if err != nil {
			t.Fatal(err)
		}
		for _, v := range f.Vectors {
			if len(v.Object) == 0 {
				continue
			}
			err := wire.VerifyRaw(c.pub, v.Object)
			genuine := v.Signer == "gateway" || v.Signer == "controller"
			if genuine && err != nil {
				t.Errorf("%s/%s: genuine signature rejected: %v", c.file, v.Name, err)
			}
			if !genuine && err == nil {
				t.Errorf("%s/%s: forged/tampered signature accepted", c.file, v.Name)
			}
		}
	}
}

// TestWSAuthVectors runs pairing.json's ws.auth accept + reject matrix
// through VerifyWSAuth, and proves SignWSAuth reproduces the vector
// signature from the same inputs.
func TestWSAuthVectors(t *testing.T) {
	dir, privs, pubs := loadAll(t)
	f, err := vectorfile.Load(dir, "pairing.json")
	if err != nil {
		t.Fatal(err)
	}
	ran := 0
	for _, v := range f.Vectors {
		var probe struct {
			Typ    string `json:"typ"`
			Cnonce string `json:"cnonce"`
			TS     int64  `json:"ts"`
		}
		if err := json.Unmarshal(v.Object, &probe); err != nil || probe.Typ != "ws.auth" {
			continue
		}
		ran++
		var ch wire.WSChallenge
		if err := json.Unmarshal(v.Check.Challenge, &ch); err != nil {
			t.Fatalf("%s: challenge: %v", v.Name, err)
		}
		used := map[string]bool{}
		err := wire.VerifyWSAuth(pubs["controller"], v.Object, &ch, v.Check.Now, used)
		switch v.Expect {
		case "accept":
			if err != nil {
				t.Errorf("%s: expected accept, got %v", v.Name, err)
			}
			// Deterministic re-signing must reproduce the vector sig.
			raw, serr := wire.SignWSAuth(privs["controller"], v.Check.DeviceID, probe.Cnonce, probe.TS)
			if serr != nil {
				t.Fatal(serr)
			}
			var m map[string]any
			_ = json.Unmarshal(raw, &m)
			var want map[string]any
			_ = json.Unmarshal(v.Object, &want)
			if m["sig"] != want["sig"] {
				t.Errorf("%s: SignWSAuth sig mismatch\n got %v\nwant %v", v.Name, m["sig"], want["sig"])
			}
			// Replay of the same cnonce must now fail.
			if err2 := wire.VerifyWSAuth(pubs["controller"], v.Object, &ch, v.Check.Now, used); err2 == nil {
				t.Errorf("%s: cnonce reuse accepted", v.Name)
			}
		case "reject":
			rej, ok := err.(*wire.Reject)
			if !ok {
				t.Errorf("%s: expected reject %q, got %v", v.Name, v.Reason, err)
			} else if rej.Reason != v.Reason {
				t.Errorf("%s: expected reason %q, got %q", v.Name, v.Reason, rej.Reason)
			}
		}
	}
	if ran != 5 {
		t.Errorf("expected 5 ws.auth vectors, ran %d", ran)
	}
}

// TestAckAndEventBuildersMatchVectors proves our OWN envelope builders
// (Ack.Signable / Event.Signable → SignMap) serialize exactly like the
// vectors: rebuilding each accept-vector from its parsed fields and signing
// with the controller seed must reproduce object.sig.
func TestAckAndEventBuildersMatchVectors(t *testing.T) {
	dir, privs, _ := loadAll(t)

	af, err := vectorfile.Load(dir, "acks.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range af.Vectors {
		if v.Signer != "controller" {
			continue
		}
		var a wire.Ack
		if err := json.Unmarshal(v.Object, &a); err != nil {
			t.Fatal(err)
		}
		a.Sig = ""
		raw, err := wire.SignAck(privs["controller"], &a)
		if err != nil {
			t.Fatal(err)
		}
		assertSameSig(t, "ack/"+v.Name, raw, v.Object)
	}

	ef, err := vectorfile.Load(dir, "events.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range ef.Vectors {
		if v.Signer != "controller" {
			continue
		}
		var e wire.Event
		if err := json.Unmarshal(v.Object, &e); err != nil {
			t.Fatal(err)
		}
		e.Sig = ""
		raw, err := wire.SignEvent(privs["controller"], &e)
		if err != nil {
			t.Fatal(err)
		}
		assertSameSig(t, "event/"+v.Name, raw, v.Object)
	}
}

func assertSameSig(t *testing.T, name string, got, want json.RawMessage) {
	t.Helper()
	var g, w map[string]any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatal(err)
	}
	if g["sig"] != w["sig"] {
		t.Errorf("%s: builder sig mismatch\n got %v\nwant %v", name, g["sig"], w["sig"])
	}
}
