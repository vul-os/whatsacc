package keys

import (
	"testing"
	"time"
)

func TestLoadGeneratesAndPersists(t *testing.T) {
	dir := t.TempDir()
	k1, err := Load(dir)
	if err != nil {
		t.Fatalf("first Load: %v", err)
	}
	k2, err := Load(dir)
	if err != nil {
		t.Fatalf("second Load: %v", err)
	}
	if k1.PublicKeyB64() != k2.PublicKeyB64() {
		t.Error("key not stable across reloads")
	}
	if k1.PublicKeyB64() == "" {
		t.Error("empty public key")
	}
	// A different dir yields a different identity.
	k3, err := Load(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if k3.PublicKeyB64() == k1.PublicKeyB64() {
		t.Error("two boots generated the same key")
	}
}

func TestSignCommandVerifies(t *testing.T) {
	k, err := Load(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cause := map[string]any{"kind": "chat", "channel": "whatsapp", "member": "m-1", "event": "e-1"}
	e, err := k.SignCommand("open", "dev-1", "main", 30*time.Second, cause)
	if err != nil {
		t.Fatalf("SignCommand: %v", err)
	}
	if e.V != 0 || e.Typ != "cmd" || e.Cmd != "open" || e.Nonce == "" || e.Sig == "" {
		t.Errorf("envelope shape: %+v", e)
	}
	if e.EXP-e.IAT != 30 {
		t.Errorf("ttl: iat=%d exp=%d", e.IAT, e.EXP)
	}
	if err := VerifyEnvelope(k.Public(), e); err != nil {
		t.Errorf("verify: %v", err)
	}

	// Tamper with any signed field → verification fails.
	tampered := *e
	tampered.Cmd = "hold"
	if err := VerifyEnvelope(k.Public(), &tampered); err == nil {
		t.Error("tampered cmd verified")
	}
	tampered = *e
	tampered.EXP += 3600
	if err := VerifyEnvelope(k.Public(), &tampered); err == nil {
		t.Error("tampered exp verified")
	}
	tampered = *e
	tampered.DeviceID = "dev-2"
	if err := VerifyEnvelope(k.Public(), &tampered); err == nil {
		t.Error("tampered device_id verified")
	}

	// Wrong key → fails.
	other, _ := Load(t.TempDir())
	if err := VerifyEnvelope(other.Public(), e); err == nil {
		t.Error("verified with wrong key")
	}
}

func TestSignCommandClampsTTL(t *testing.T) {
	k, _ := Load(t.TempDir())
	e, err := k.SignCommand("open", "d", "main", 10*time.Minute, nil)
	if err != nil {
		t.Fatal(err)
	}
	if e.EXP-e.IAT > 60 {
		t.Errorf("ttl not clamped to spec max: %d", e.EXP-e.IAT)
	}
}

// JCS-subset vectors. proto/vectors/ did not exist when this was written —
// these are self-authored vectors matching RFC 8785 for the envelope subset.
// When proto/vectors/ lands, add a test that walks that directory and prefer
// its cases over these.
func TestJCSVectors(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want string
	}{
		{"key ordering", map[string]any{"b": 1, "a": 2, "aa": 3}, `{"a":2,"aa":3,"b":1}`},
		{"nested", map[string]any{"z": map[string]any{"y": "x"}, "a": []any{1, "2", true, nil}},
			`{"a":[1,"2",true,null],"z":{"y":"x"}}`},
		{"escapes", map[string]any{"s": "a\"b\\c\nd\te"}, `{"s":"a\"b\\c\nd\te"}`},
		{"control chars", map[string]any{"s": "x\x01y"}, `{"s":"x\u0001y"}`},
		{"unicode literal", map[string]any{"k": "héllo ✓"}, `{"k":"héllo ✓"}`},
		{"integral float", map[string]any{"n": float64(1789000000)}, `{"n":1789000000}`},
		{"empty", map[string]any{}, `{}`},
	}
	for _, c := range cases {
		got, err := Canonicalize(c.in)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if string(got) != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
	}

	// Envelope-shaped vector: matches proto/commands.md field set.
	env := map[string]any{
		"v": 0, "typ": "cmd", "cmd": "open",
		"device_id": "uuid", "access_point": "main",
		"nonce": "abc", "iat": 1789000000, "exp": 1789000030,
		"cause": map[string]any{"kind": "chat", "channel": "whatsapp"},
	}
	want := `{"access_point":"main","cause":{"channel":"whatsapp","kind":"chat"},"cmd":"open","device_id":"uuid","exp":1789000030,"iat":1789000000,"nonce":"abc","typ":"cmd","v":0}`
	got, err := Canonicalize(env)
	if err != nil || string(got) != want {
		t.Errorf("envelope vector: %v\n got %s\nwant %s", err, got, want)
	}
}

func TestJCSRejectsNonIntegerNumbers(t *testing.T) {
	if _, err := Canonicalize(map[string]any{"f": 1.5}); err == nil {
		t.Error("non-integer number accepted (documented deviation should reject)")
	}
}

func TestCanonicalizeJSONNormalizes(t *testing.T) {
	raw := []byte("{\n  \"b\": 1,\t\"a\": \"x\" }")
	got, err := CanonicalizeJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"a":"x","b":1}` {
		t.Errorf("got %s", got)
	}
}
