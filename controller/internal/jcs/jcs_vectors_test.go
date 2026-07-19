package jcs_test

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/vul-os/whatsacc/controller/internal/jcs"
	"github.com/vul-os/whatsacc/controller/internal/vectorfile"
)

// TestCanonicalBytesAllVectors is conformance layer 1 (proto/vectors/README):
// our JCS output over `object` minus top-level `sig` must byte-compare equal
// to every `canonical` field in every vectors file — including nested grant
// objects, transcript messages and multi-step flows.
func TestCanonicalBytesAllVectors(t *testing.T) {
	dir, err := vectorfile.FindDir("")
	if err != nil {
		t.Fatal(err)
	}
	total := 0
	vectors := 0
	for _, name := range []string{"pairing.json", "commands.json", "grants.json", "events.json", "acks.json"} {
		f, err := vectorfile.Load(dir, name)
		if err != nil {
			t.Fatal(err)
		}
		for _, v := range f.Vectors {
			vectors++
			check := func(label string, obj json.RawMessage, canonical string) {
				t.Helper()
				if len(obj) == 0 || canonical == "" {
					return
				}
				got, sig, err := canonMinusSig(obj)
				_ = sig
				if err != nil {
					t.Errorf("%s/%s/%s: canonicalize: %v", name, v.Name, label, err)
					return
				}
				if got != canonical {
					t.Errorf("%s/%s/%s: canonical mismatch\n got: %s\nwant: %s", name, v.Name, label, got, canonical)
				}
				total++
			}
			check("object", v.Object, v.Canonical)
			if v.Grant != nil {
				check("grant", v.Grant.Object, v.Grant.Canonical)
			}
			if v.Transcript != nil {
				if v.Transcript.Open != nil {
					check("open", v.Transcript.Open.Object, v.Transcript.Open.Canonical)
				}
				if v.Transcript.Proof != nil {
					check("proof", v.Transcript.Proof.Object, v.Transcript.Proof.Canonical)
				}
			}
			for i, st := range v.Steps {
				check("step", st.Object, st.Canonical)
				if st.Proof != nil {
					check("step-proof", st.Proof.Object, st.Proof.Canonical)
				}
				_ = i
			}
		}
	}
	if vectors != 61 {
		t.Errorf("expected 61 vectors across the five files, saw %d", vectors)
	}
	if total < 61 {
		t.Errorf("expected ≥61 canonical comparisons, did %d", total)
	}
	t.Logf("byte-compared %d canonical encodings across %d vectors", total, vectors)
}

// canonMinusSig mirrors the signing rule: parse, drop top-level sig, JCS.
// For unsigned objects (no sig member) it is simply JCS of the whole object.
func canonMinusSig(raw []byte) (string, string, error) {
	var m map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil {
		return "", "", err
	}
	sig, _ := m["sig"].(string)
	delete(m, "sig")
	b, err := jcs.Canonicalize(m)
	return string(b), sig, err
}
