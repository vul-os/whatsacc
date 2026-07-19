package lanserver_test

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vul-os/whatsacc/controller/internal/grants"
	"github.com/vul-os/whatsacc/controller/internal/jcs"
	"github.com/vul-os/whatsacc/controller/internal/lanserver"
	"github.com/vul-os/whatsacc/controller/internal/vectorfile"
	"github.com/vul-os/whatsacc/controller/internal/wire"
)

// TestLANFlowEndToEnd drives the real HTTP endpoints with a FRESH random
// cnonce (unlike the fixture replays): grant.open → challenge → app-signed
// proof → opened, plus single-use enforcement on the second proof.
func TestLANFlowEndToEnd(t *testing.T) {
	dir, err := vectorfile.FindDir("")
	if err != nil {
		t.Fatal(err)
	}
	f, err := vectorfile.Load(dir, "grants.json")
	if err != nil {
		t.Fatal(err)
	}
	keys, err := vectorfile.LoadKeys(dir)
	if err != nil {
		t.Fatal(err)
	}
	gwPub, err := wire.DecodePub(keys.Keys["gateway"].PublicKeyB64u)
	if err != nil {
		t.Fatal(err)
	}
	appSeed, err := keys.Keys["app"].Seed()
	if err != nil {
		t.Fatal(err)
	}
	appPriv := ed25519.NewKeyFromSeed(appSeed)

	var valid *vectorfile.Vector
	for i := range f.Vectors {
		if f.Vectors[i].Name == "grant-redeem-valid" {
			valid = &f.Vectors[i]
			break
		}
	}
	redeemed := 0
	srv := &lanserver.Server{
		DeviceID: valid.Check.DeviceID,
		Exchange: grants.NewExchange(),
		Env: func() grants.Env {
			return grants.Env{
				Now:             valid.Check.Now,
				LastGatewaySync: valid.Check.LastGatewaySync,
				DeviceID:        valid.Check.DeviceID,
				GatewayKey:      gwPub,
			}
		},
		OnRedeemed: func(g *grants.Grant, p *grants.Proof) { redeemed++ },
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	post := func(path string, body []byte) []byte {
		t.Helper()
		resp, err := http.Post(ts.URL+path, "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}

	chRaw := post("/grant/open", valid.Transcript.Open.Object)
	var ch grants.Challenge
	if err := json.Unmarshal(chRaw, &ch); err != nil || ch.Typ != "grant.challenge" || ch.Cnonce == "" {
		t.Fatalf("bad challenge: %s", chRaw)
	}
	if ch.EXP-ch.IAT != wire.CnonceTTLSeconds {
		t.Fatalf("challenge validity: %d", ch.EXP-ch.IAT)
	}

	proof := signProof(t, appPriv, "9aa70000-0000-4000-8000-000000000001", ch.Cnonce, "main", valid.Check.Now)
	var res grants.Result
	if err := json.Unmarshal(post("/grant/proof", proof), &res); err != nil || res.Result != "opened" {
		t.Fatalf("expected opened: %+v", res)
	}
	if redeemed != 1 {
		t.Fatalf("OnRedeemed calls: %d", redeemed)
	}
	// Single-use cnonce: same proof again is a replay.
	if err := json.Unmarshal(post("/grant/proof", proof), &res); err != nil || res.Detail != wire.ReasonCnonceReplay {
		t.Fatalf("expected cnonce_replay: %+v", res)
	}
	// Unknown cnonce.
	bogus := signProof(t, appPriv, "9aa70000-0000-4000-8000-000000000001", "AAAAAAAAAAAAAAAAAAAAAA", "main", valid.Check.Now)
	if err := json.Unmarshal(post("/grant/proof", bogus), &res); err != nil || res.Detail != wire.ReasonCnonceUnknown {
		t.Fatalf("expected cnonce_unknown: %+v", res)
	}
	// Oversize body.
	if err := json.Unmarshal(post("/grant/open", make([]byte, lanserver.MaxBody+10)), &res); err != nil || res.Detail != "frame_too_large" {
		t.Fatalf("expected frame_too_large: %+v", res)
	}
	if redeemed != 1 {
		t.Fatalf("relay actuated on a denied path: %d", redeemed)
	}
}

func signProof(t *testing.T, priv ed25519.PrivateKey, grantID, cnonce, ap string, ts int64) []byte {
	t.Helper()
	m := map[string]any{
		"v": 0, "typ": "grant.proof",
		"grant_id": grantID, "cnonce": cnonce, "access_point": ap, "ts": ts,
	}
	canonical, err := jcs.Canonicalize(m)
	if err != nil {
		t.Fatal(err)
	}
	m["sig"] = wire.Sign(priv, canonical)
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
