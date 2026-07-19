// Command controller-sim is an interactive/scriptable simulator for the
// whatsacc reference controller. It runs the REAL agent assembly with the
// mock relay (state transitions printed), or replays the conformance
// fixtures without any gateway:
//
//	controller-sim --gateway https://gate.example --claim-token …   # live agent, mock relay
//	controller-sim --offline-demo                                   # LAN grant flow vs proto/vectors fixtures
//	controller-sim --ble-demo                                       # BLE framing + session vs fixtures (no radio)
//
// In live mode, stdin accepts: status, lockdown, lift, quit.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/vul-os/whatsacc/controller/internal/agent"
	"github.com/vul-os/whatsacc/controller/internal/blesession"
	"github.com/vul-os/whatsacc/controller/internal/clock"
	"github.com/vul-os/whatsacc/controller/internal/framing"
	"github.com/vul-os/whatsacc/controller/internal/grants"
	"github.com/vul-os/whatsacc/controller/internal/jcs"
	"github.com/vul-os/whatsacc/controller/internal/lanserver"
	"github.com/vul-os/whatsacc/controller/internal/relay"
	"github.com/vul-os/whatsacc/controller/internal/vectorfile"
	"github.com/vul-os/whatsacc/controller/internal/wire"
)

func main() {
	var (
		gateway     = flag.String("gateway", "", "gateway base URL (live mode)")
		claimToken  = flag.String("claim-token", "", "claim token (live mode, first run)")
		stateDir    = flag.String("state", "./sim-state", "state directory")
		lanAddr     = flag.String("lan", ":8737", "LAN grant listener address")
		insecure    = flag.Bool("insecure", true, "allow ws://+http:// gateways (sim default)")
		vectorsDir  = flag.String("vectors", "", "path to proto/vectors (default: auto-discover upward)")
		offlineDemo = flag.Bool("offline-demo", false, "exercise the offline grant flow against fixture grants")
		bleDemo     = flag.Bool("ble-demo", false, "exercise the BLE framing codec + redemption core in-memory")
	)
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelDebug}))
	slog.SetDefault(log)

	if *offlineDemo || *bleDemo {
		vdir, err := vectorfile.FindDir(*vectorsDir)
		if err != nil {
			fatal(err)
		}
		if *offlineDemo {
			if err := runOfflineDemo(vdir); err != nil {
				fatal(err)
			}
		}
		if *bleDemo {
			if err := runBLEDemo(vdir); err != nil {
				fatal(err)
			}
		}
		return
	}
	runLive(*stateDir, *gateway, *claimToken, *lanAddr, *insecure, log)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "controller-sim:", err)
	os.Exit(1)
}

// ---- live mode ----

func runLive(stateDir, gateway, claimToken, lanAddr string, insecure bool, log *slog.Logger) {
	mock := relay.NewMock(log)
	a, err := agent.New(agent.Options{
		StateDir: stateDir, GatewayURL: gateway, ClaimToken: claimToken,
		LANAddr: lanAddr, AccessPoints: []string{"main", "pedestrian"},
		Relay: mock, Log: log, AllowInsecure: insecure, Firmware: "0.1.0-sim",
	})
	if err != nil {
		fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		if err := a.Run(ctx); err != nil {
			log.Error("agent stopped", "err", err)
			stop()
		}
	}()
	fmt.Println("sim: commands: status | lockdown | lift | quit")
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		switch strings.TrimSpace(sc.Text()) {
		case "status":
			n, g := a.Queue.Len()
			fmt.Printf("relay=%s lockdown=%v queued_events=%d queued_grant_events=%d paired=%v\n",
				a.Relay.State(), a.St.Lockdown(), n, g, a.St.Pairing() != nil)
		case "lockdown":
			_ = a.St.SetLockdown(true)
			fmt.Println("lockdown latched (local override)")
		case "lift":
			_ = a.St.SetLockdown(false)
			fmt.Println("lockdown lifted (local override)")
		case "quit", "exit":
			return
		case "":
		default:
			fmt.Println("unknown command")
		}
		if ctx.Err() != nil {
			return
		}
	}
}

// ---- offline demo: LAN flow against proto/vectors fixtures ----

func runOfflineDemo(vdir string) error {
	fmt.Println("== offline grant demo (fixtures from", vdir+") ==")
	gf, err := vectorfile.Load(vdir, "grants.json")
	if err != nil {
		return err
	}
	keys, err := vectorfile.LoadKeys(vdir)
	if err != nil {
		return err
	}
	gwPub, err := wire.DecodePub(keys.Keys["gateway"].PublicKeyB64u)
	if err != nil {
		return err
	}

	// Part 1: replay every fixture transcript through the shared
	// verification core (fixed challenge + fixed clock from `check`).
	pass, fail := 0, 0
	for _, v := range gf.Vectors {
		results := replayGrantVector(&v, gwPub)
		for _, r := range results {
			status := "PASS"
			if !r.ok {
				status = "FAIL"
				fail++
			} else {
				pass++
			}
			fmt.Printf("  [%s] %-28s → %s\n", status, r.name, r.got)
		}
	}
	fmt.Printf("fixture transcripts: %d pass, %d fail\n\n", pass, fail)

	// Part 2: live LAN HTTP flow — mock relay, fresh random cnonce, proof
	// signed on the fly with the public test app key.
	fmt.Println("== live LAN flow (httptest server, real random cnonce) ==")
	var valid *vectorfile.Vector
	for i := range gf.Vectors {
		if gf.Vectors[i].Name == "grant-redeem-valid" {
			valid = &gf.Vectors[i]
			break
		}
	}
	if valid == nil {
		return fmt.Errorf("grant-redeem-valid fixture missing")
	}
	fake := &clock.Fake{NowSec: valid.Check.Now, SyncSec: valid.Check.LastGatewaySync}
	mock := relay.NewMock(nil)
	opened := false
	srv := &lanserver.Server{
		DeviceID: valid.Check.DeviceID,
		Exchange: grants.NewExchange(),
		Env: func() grants.Env {
			return grants.Env{Now: fake.Now(), LastGatewaySync: fake.LastGatewaySync(),
				DeviceID: valid.Check.DeviceID, GatewayKey: gwPub}
		},
		OnRedeemed: func(g *grants.Grant, p *grants.Proof) {
			opened = true
			_ = mock.Pulse(700e6)
			fmt.Printf("  relay: PULSE (grant %s at %s)\n", g.GrantID, p.AccessPoint)
		},
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	openBody := valid.Transcript.Open.Object
	fmt.Println("  app → controller: grant.open")
	chRaw, err := postJSON(ts.URL+"/grant/open", openBody)
	if err != nil {
		return err
	}
	var ch grants.Challenge
	if err := json.Unmarshal(chRaw, &ch); err != nil {
		return err
	}
	fmt.Printf("  controller → app: grant.challenge cnonce=%s\n", ch.Cnonce)

	seed, err := keys.Keys["app"].Seed()
	if err != nil {
		return err
	}
	proof, err := signProof(ed25519.NewKeyFromSeed(seed), "9aa70000-0000-4000-8000-000000000001", ch.Cnonce, "main", fake.Now())
	if err != nil {
		return err
	}
	fmt.Println("  app → controller: grant.proof (signed with test app key)")
	resRaw, err := postJSON(ts.URL+"/grant/proof", proof)
	if err != nil {
		return err
	}
	fmt.Printf("  controller → app: %s\n", strings.TrimSpace(string(resRaw)))
	if !opened {
		return fmt.Errorf("offline demo: relay did not open")
	}
	fmt.Println("offline demo complete: gate opened with no gateway present")
	return nil
}

type replayResult struct {
	name string
	got  string
	ok   bool
}

// replayGrantVector runs one grants.json vector (including multi-step
// cnonce-replay flows) through grants.Exchange.
func replayGrantVector(v *vectorfile.Vector, gwPub ed25519.PublicKey) []replayResult {
	x := grants.NewExchange()
	env := grants.Env{
		Now:             v.Check.Now,
		LastGatewaySync: v.Check.LastGatewaySync,
		DeviceID:        v.Check.DeviceID,
		Lockdown:        v.Check.Lockdown,
		GatewayKey:      gwPub,
	}
	var open grants.Open
	_ = json.Unmarshal(v.Transcript.Open.Object, &open)
	var ch grants.Challenge
	_ = json.Unmarshal(v.Transcript.Challenge, &ch)
	x.InjectChallenge(&open, ch)

	verdict := func(res *grants.Result, expect, reason string) replayResult {
		got := res.Result
		if res.Detail != "" {
			got += "(" + res.Detail + ")"
		}
		want := "opened"
		if expect == "reject" {
			want = "denied(" + reason + ")"
		}
		return replayResult{name: v.Name, got: got, ok: got == want}
	}
	if len(v.Steps) > 0 {
		var out []replayResult
		for i, st := range v.Steps {
			res, _, _ := x.HandleProof(st.Proof.Object, env)
			r := verdict(res, st.Expect, st.Reason)
			r.name = fmt.Sprintf("%s[%d]", v.Name, i)
			out = append(out, r)
		}
		return out
	}
	res, _, _ := x.HandleProof(v.Transcript.Proof.Object, env)
	return []replayResult{verdict(res, v.Expect, v.Reason)}
}

func signProof(priv ed25519.PrivateKey, grantID, cnonce, ap string, ts int64) ([]byte, error) {
	m := map[string]any{
		"v": 0, "typ": "grant.proof",
		"grant_id": grantID, "cnonce": cnonce, "access_point": ap, "ts": ts,
	}
	canonical, err := jcs.Canonicalize(m)
	if err != nil {
		return nil, err
	}
	m["sig"] = wire.Sign(priv, canonical)
	return json.Marshal(m)
}

func postJSON(url string, body []byte) ([]byte, error) {
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(io.LimitReader(resp.Body, 1<<20))
}

// ---- BLE demo: framing codec + session core over an in-memory transport ----

type memConn struct {
	out    [][]byte
	closed bool
}

func (m *memConn) SendMessage(msg []byte) error { m.out = append(m.out, msg); return nil }
func (m *memConn) Close() error                 { m.closed = true; return nil }

func runBLEDemo(vdir string) error {
	fmt.Println("== BLE demo (framing + redemption core, in-memory — no radio) ==")
	gf, err := vectorfile.Load(vdir, "grants.json")
	if err != nil {
		return err
	}
	keys, err := vectorfile.LoadKeys(vdir)
	if err != nil {
		return err
	}
	gwPub, err := wire.DecodePub(keys.Keys["gateway"].PublicKeyB64u)
	if err != nil {
		return err
	}
	var valid *vectorfile.Vector
	for i := range gf.Vectors {
		if gf.Vectors[i].Name == "grant-redeem-valid" {
			valid = &gf.Vectors[i]
			break
		}
	}
	if valid == nil {
		return fmt.Errorf("grant-redeem-valid fixture missing")
	}
	var fixedCh grants.Challenge
	_ = json.Unmarshal(valid.Transcript.Challenge, &fixedCh)

	for _, attMTU := range []int{23, 185, 512} {
		usable := attMTU - 3
		fmt.Printf("-- ATT MTU %d (usable %d bytes/write) --\n", attMTU, usable)
		x := grants.NewExchange()
		x.NewCnonce = func() (string, error) { return fixedCh.Cnonce, nil } // deterministic, matches fixture proof
		conn := &memConn{}
		env := func() grants.Env {
			return grants.Env{Now: valid.Check.Now, LastGatewaySync: valid.Check.LastGatewaySync,
				DeviceID: valid.Check.DeviceID, GatewayKey: gwPub}
		}
		opened := false
		sess := blesession.New(x, env, conn, func(g *grants.Grant, p *grants.Proof) {
			opened = true
			fmt.Printf("  relay: PULSE (grant %s)\n", g.GrantID)
		}, nil)

		feed := func(label string, msg []byte) error {
			chunks, err := framing.Chunk(msg, usable)
			if err != nil {
				return err
			}
			fmt.Printf("  app → rx: %s (%d bytes in %d chunks)\n", label, len(msg), len(chunks))
			for _, c := range chunks {
				sess.HandleChunk(c)
			}
			return nil
		}
		if err := feed("grant.open", valid.Transcript.Open.Object); err != nil {
			return err
		}
		if len(conn.out) != 1 {
			return fmt.Errorf("ble demo: expected challenge notification, got %d messages", len(conn.out))
		}
		fmt.Printf("  tx → app: grant.challenge (%d bytes)\n", len(conn.out[0]))
		if err := feed("grant.proof", valid.Transcript.Proof.Object); err != nil {
			return err
		}
		last := conn.out[len(conn.out)-1]
		fmt.Printf("  tx → app: %s\n", string(last))
		if !opened || !conn.closed {
			return fmt.Errorf("ble demo: expected opened + connection drop (opened=%v closed=%v)", opened, conn.closed)
		}
	}

	// frame_too_large behavior
	fmt.Println("-- oversize frame (9 KiB) --")
	x := grants.NewExchange()
	conn := &memConn{}
	sess := blesession.New(x, func() grants.Env { return grants.Env{} }, conn, nil, nil)
	huge := make([]byte, framing.HeaderSize+9*1024)
	huge[0], huge[1] = 0x00, 0x24 // LE length 0x2400 = 9216 > 8192
	sess.HandleChunk(huge)
	if len(conn.out) > 0 {
		fmt.Printf("  tx → app: %s\n", string(conn.out[len(conn.out)-1]))
	}
	fmt.Println("BLE demo complete")
	return nil
}
