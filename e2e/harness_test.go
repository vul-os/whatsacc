package e2e

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Build: the harness runs the REAL shipped binaries, so TestMain compiles them
// once from the sibling modules (../gateway, ../controller). See README.md for
// why this is subprocess-over-the-wire and not an in-process import.
// ---------------------------------------------------------------------------

var (
	gatewayBin    string
	controllerBin string
	simBin        string
)

func TestMain(m *testing.M) {
	code, err := buildAndRun(m)
	if err != nil {
		fmt.Fprintln(os.Stderr, "e2e:", err)
		os.Exit(1)
	}
	os.Exit(code)
}

func buildAndRun(m *testing.M) (int, error) {
	wd, err := os.Getwd()
	if err != nil {
		return 1, fmt.Errorf("getwd: %w", err)
	}
	repo := filepath.Dir(wd) // .../lintel
	gatewayDir := filepath.Join(repo, "gateway")
	controllerDir := filepath.Join(repo, "controller")

	binDir, err := os.MkdirTemp("", "lintel-e2e-bin-")
	if err != nil {
		return 1, fmt.Errorf("tempdir: %w", err)
	}
	defer os.RemoveAll(binDir)

	gatewayBin = filepath.Join(binDir, "lintel-gateway")
	controllerBin = filepath.Join(binDir, "lintel-controller")
	simBin = filepath.Join(binDir, "lintel-controller-sim")

	for _, b := range []struct{ dir, pkg, out string }{
		{gatewayDir, "./cmd/gateway", gatewayBin},
		{controllerDir, "./cmd/controller", controllerBin},
		{controllerDir, "./cmd/controller-sim", simBin},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		cmd := exec.CommandContext(ctx, "go", "build", "-o", b.out, b.pkg)
		cmd.Dir = b.dir
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
		out, err := cmd.CombinedOutput()
		cancel()
		if err != nil {
			return 1, fmt.Errorf("build %s (%s): %v\n%s", b.pkg, b.dir, err, out)
		}
	}
	return m.Run(), nil
}

// ---------------------------------------------------------------------------
// logBuf: a concurrency-safe capture of a subprocess's combined output with
// line-oriented await helpers. This is our "no sleeps-as-sync" primitive for
// conditions that have no HTTP surface (relay pulses, event drains): we poll
// the accumulated log for an observable line, bounded by a timeout.
// ---------------------------------------------------------------------------

type logBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *logBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *logBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

// countLines returns how many output lines contain ALL of subs.
func (l *logBuf) countLines(subs ...string) int {
	n := 0
	for _, line := range strings.Split(l.String(), "\n") {
		ok := true
		for _, s := range subs {
			if !strings.Contains(line, s) {
				ok = false
				break
			}
		}
		if ok && strings.TrimSpace(line) != "" {
			n++
		}
	}
	return n
}

// waitLines blocks until at least min lines contain ALL of subs, or timeout.
func (l *logBuf) waitLines(min int, timeout time.Duration, subs ...string) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if l.countLines(subs...) >= min {
			return true
		}
		time.Sleep(15 * time.Millisecond)
	}
	return l.countLines(subs...) >= min
}

// ---------------------------------------------------------------------------
// gateway: a running gateway subprocess + admin/setup helpers over its HTTP API.
// ---------------------------------------------------------------------------

type gateway struct {
	t          *testing.T
	url        string // http://127.0.0.1:PORT
	apiBase    string // url + "/api" — the /api alias (bare url also works since the pairing fix)
	dataDir    string
	adminToken string
	logs       *logBuf
	priv       ed25519.PrivateKey // gateway signing key, read from its data dir
	pubB64     string
	cmd        *exec.Cmd
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("free port: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// startGateway boots a fresh gateway (own temp data dir, own keypair, random
// port) and blocks until /health is green.
func startGateway(t *testing.T) *gateway {
	t.Helper()
	port := freePort(t)
	dataDir := t.TempDir()
	adminToken := "e2e-admin-claim-" + randHex(8)
	url := fmt.Sprintf("http://127.0.0.1:%d", port)

	gw := &gateway{
		t: t, url: url, apiBase: url + "/api",
		dataDir: dataDir, adminToken: adminToken, logs: &logBuf{},
	}
	cmd := exec.Command(gatewayBin,
		"-data", dataDir,
		"-listen", fmt.Sprintf("127.0.0.1:%d", port),
		"-public-url", url,
		"-admin-claim-token", adminToken,
	)
	cmd.Stdout = gw.logs
	cmd.Stderr = gw.logs
	if err := cmd.Start(); err != nil {
		t.Fatalf("start gateway: %v", err)
	}
	gw.cmd = cmd
	t.Cleanup(func() { killProc(cmd); t.Logf("gateway log:\n%s", gw.logs.String()) })

	// Wait for health (tolerating connection-refused while it boots).
	deadline := time.Now().Add(20 * time.Second)
	for {
		if time.Now().After(deadline) {
			t.Fatalf("gateway never became healthy; log:\n%s", gw.logs.String())
		}
		if healthOK(url + "/health") {
			break
		}
		if gw.cmd.ProcessState != nil {
			t.Fatalf("gateway process exited before healthy; log:\n%s", gw.logs.String())
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Load the gateway's private signing key from its data dir. The harness
	// no longer uses this to self-sign offline grants (see issueOfflineGrant
	// below — grants now come from the REAL POST /v1/offline-grants issuance
	// path); it stays only as the seed the following block cross-checks
	// against what /v1/gateway/key actually serves.
	seedHex, err := os.ReadFile(filepath.Join(dataDir, "gateway_ed25519.seed"))
	if err != nil {
		t.Fatalf("read gateway seed: %v", err)
	}
	seed, err := hex.DecodeString(strings.TrimSpace(string(seedHex)))
	if err != nil || len(seed) != ed25519.SeedSize {
		t.Fatalf("bad gateway seed: %v", err)
	}
	gw.priv = ed25519.NewKeyFromSeed(seed)
	gw.pubB64 = base64.RawURLEncoding.EncodeToString(gw.priv.Public().(ed25519.PublicKey))

	// Cross-check our loaded key against what the gateway serves.
	_, keyResp, _ := httpJSON(t, http.MethodGet, url+"/v1/gateway/key", "", nil)
	if got, _ := keyResp["public_key"].(string); got != gw.pubB64 {
		t.Fatalf("gateway key mismatch: served %q, derived %q", got, gw.pubB64)
	}
	return gw
}

// ---------------------------------------------------------------------------
// tenant: a registered owner + platform admin, with an account/location, used
// as the setup context for each test.
// ---------------------------------------------------------------------------

type tenant struct {
	token      string // access token (owner + platform admin)
	userID     string
	accountID  string
	locationID string
}

// register creates a user (owner of a fresh personal account + anchor
// location) and claims platform-admin so audit endpoints are reachable.
func (gw *gateway) register(t *testing.T) *tenant {
	t.Helper()
	email := "owner-" + randHex(6) + "@example.com"
	st, body, raw := httpJSON(t, http.MethodPost, gw.url+"/v1/auth/register", "", map[string]any{
		"email": email, "password": "correct horse battery",
		"display_name": "Owner", "location_name": "HQ", "country_code": "ZA",
	})
	if st != 201 {
		t.Fatalf("register: %d %s", st, raw)
	}
	tok := body["tokens"].(map[string]any)["access_token"].(string)
	ten := &tenant{
		token:      tok,
		userID:     body["user"].(map[string]any)["id"].(string),
		accountID:  body["account"].(map[string]any)["id"].(string),
		locationID: body["location"].(map[string]any)["id"].(string),
	}
	// Claim platform admin (first-run, one-shot).
	st, _, raw = httpJSON(t, http.MethodPost, gw.url+"/v1/admin/claim", tok, map[string]any{"token": gw.adminToken})
	if st != 200 {
		t.Fatalf("admin claim: %d %s", st, raw)
	}
	return ten
}

// createDevice makes an unpaired device at the tenant's location and returns
// (deviceID, claimToken).
func (gw *gateway) createDevice(t *testing.T, ten *tenant, label string) (string, string) {
	t.Helper()
	st, body, raw := httpJSON(t, http.MethodPost, gw.url+"/v1/devices", ten.token, map[string]any{
		"location_id": ten.locationID, "label": label,
	})
	if st != 201 {
		t.Fatalf("create device: %d %s", st, raw)
	}
	return body["id"].(string), body["claim_token"].(string)
}

// createAP makes an access point at the tenant's location, optionally bound to
// deviceID (pass "" for none), and returns its id.
func (gw *gateway) createAP(t *testing.T, ten *tenant, name, deviceID string) string {
	t.Helper()
	req := map[string]any{"location_id": ten.locationID, "name": name, "kind": "gate"}
	if deviceID != "" {
		req["device_id"] = deviceID
	}
	st, body, raw := httpJSON(t, http.MethodPost, gw.url+"/v1/access-points", ten.token, req)
	if st != 201 {
		t.Fatalf("create AP: %d %s", st, raw)
	}
	return body["id"].(string)
}

// issueOfflineGrant calls the REAL gateway-side issuance endpoint
// (POST /v1/offline-grants, proto/grants.md's gateway-signed `typ:"grant"`)
// as ten and returns the signed grant as raw wire JSON, ready to hand to
// grantOpen/grantIDOf. This is the harness's money-path proof: the grant it
// hands to a controller is produced by the actual product code
// (gateway/internal/httpapi/offline_grants.go +
// gateway/internal/keys.SignGrant), not a fixture standing in for it.
func (gw *gateway) issueOfflineGrant(t *testing.T, ten *tenant, appPubB64 string, apIDs []string) []byte {
	t.Helper()
	st, body, raw := httpJSON(t, http.MethodPost, gw.url+"/v1/offline-grants", ten.token, map[string]any{
		"app_pubkey":       appPubB64,
		"access_point_ids": apIDs,
	})
	if st != http.StatusCreated {
		t.Fatalf("issue offline grant: %d %s", st, raw)
	}
	out, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal issued grant: %v", err)
	}
	return out
}

// open POSTs the open command and returns (status, delivery, full body).
func (gw *gateway) open(t *testing.T, ten *tenant, apID string) (int, string, map[string]any) {
	t.Helper()
	st, body, _ := httpJSON(t, http.MethodPost, gw.url+"/v1/access-points/"+apID+"/open", ten.token, map[string]any{"source": "api"})
	delivery, _ := body["delivery"].(string)
	return st, delivery, body
}

// waitDeviceConnected polls the devices API until the device shows connected.
func (gw *gateway) waitDeviceConnected(t *testing.T, ten *tenant, deviceID string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		_, body, _ := httpJSON(t, http.MethodGet, gw.url+"/v1/devices?account_id="+ten.accountID, ten.token, nil)
		for _, d := range asList(body["devices"]) {
			dm := d.(map[string]any)
			if dm["id"] == deviceID && dm["connected"] == true {
				return
			}
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatalf("device %s never connected", deviceID)
}

// auditRow fetches the most recent access_logs entry for an access point (via
// the platform-admin audit API), or nil.
func (gw *gateway) auditRowForAP(t *testing.T, ten *tenant, apID string) map[string]any {
	t.Helper()
	_, body, _ := httpJSON(t, http.MethodGet, gw.url+"/v1/admin/audit?kind=open&limit=100", ten.token, nil)
	for _, e := range asList(body["entries"]) {
		em := e.(map[string]any)
		if em["access_point_id"] == apID {
			return em
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// controller: a running controller subprocess.
// ---------------------------------------------------------------------------

type controller struct {
	logs     *logBuf
	lanURL   string // http://127.0.0.1:LANPORT
	deviceID string
	cmd      *exec.Cmd
}

// execController builds (does not start) a controller command. gatewayURL is
// passed to -gateway verbatim; the controller appends /pair/redeem to it.
func execController(gatewayURL, claimToken, accessPoints string, lanPort int, logs *logBuf) *exec.Cmd {
	tmp, _ := os.MkdirTemp("", "lintel-ctl-state-")
	cmd := exec.Command(controllerBin,
		"-state", tmp,
		"-gateway", gatewayURL,
		"-claim-token", claimToken,
		"-access-points", accessPoints, // gateway signs envelopes with access_point = AP *id*
		"-lan", fmt.Sprintf("127.0.0.1:%d", lanPort),
		"-insecure",
	)
	cmd.Stdout = logs
	cmd.Stderr = logs
	return cmd
}

// startController pairs a real controller binary against the gateway using the
// gateway's /api base (see the pairing path bug note in the report) and waits
// until the gateway reports it connected.
func startController(t *testing.T, gw *gateway, ten *tenant, deviceID, claimToken, apID string) *controller {
	t.Helper()
	lanPort := freePort(t)
	c := &controller{
		logs:     &logBuf{},
		lanURL:   fmt.Sprintf("http://127.0.0.1:%d", lanPort),
		deviceID: deviceID,
	}
	// NB: gw.apiBase includes /api — see report finding #1.
	cmd := execController(gw.url, claimToken, apID, lanPort, c.logs) // documented bare path (finding #1 fixed)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start controller: %v", err)
	}
	c.cmd = cmd
	t.Cleanup(func() { killProc(cmd); t.Logf("controller log:\n%s", c.logs.String()) })

	gw.waitDeviceConnected(t, ten, deviceID, 25*time.Second)
	return c
}

// waitLAN blocks until the controller's LAN grant listener accepts TCP.
func (c *controller) waitLAN(t *testing.T) {
	t.Helper()
	host := strings.TrimPrefix(c.lanURL, "http://")
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", host, 200*time.Millisecond)
		if err == nil {
			conn.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("LAN listener never came up at %s; log:\n%s", c.lanURL, c.logs.String())
}

// ---------------------------------------------------------------------------
// sim: the controller-sim binary, the only build with an external control
// surface (stdin: status | lockdown | lift). Used to exercise the lockdown
// matrix end-to-end (no gateway command API can push a lockdown — see report).
// ---------------------------------------------------------------------------

type sim struct {
	*controller
	stdin io.WriteCloser
}

func startSim(t *testing.T, gw *gateway, deviceID, claimToken string) *sim {
	t.Helper()
	lanPort := freePort(t)
	c := &controller{
		logs:     &logBuf{},
		lanURL:   fmt.Sprintf("http://127.0.0.1:%d", lanPort),
		deviceID: deviceID,
	}
	cmd := exec.Command(simBin,
		"-state", t.TempDir(),
		"-gateway", gw.apiBase,
		"-claim-token", claimToken,
		"-lan", fmt.Sprintf("127.0.0.1:%d", lanPort),
		"-insecure",
	)
	cmd.Stdout = c.logs
	cmd.Stderr = c.logs
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("sim stdin: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sim: %v", err)
	}
	c.cmd = cmd
	t.Cleanup(func() { stdin.Close(); killProc(cmd); t.Logf("sim log:\n%s", c.logs.String()) })

	// Wait for the gateway WS connect (implies paired + clock synced, so an
	// offline grant is judged on lockdown, not stale_clock).
	if !c.logs.waitLines(1, 25*time.Second, "gateway connected") {
		t.Fatalf("sim never connected to gateway; log:\n%s", c.logs.String())
	}
	c.waitLAN(t)
	return &sim{controller: c, stdin: stdin}
}

func (s *sim) send(t *testing.T, line string) {
	t.Helper()
	if _, err := io.WriteString(s.stdin, line+"\n"); err != nil {
		t.Fatalf("sim stdin write: %v", err)
	}
}

// ---------------------------------------------------------------------------
// offline grants (proto/grants.md): the harness signs a grant AS the gateway
// (using the key it read from disk) and a proof AS the "app".
// ---------------------------------------------------------------------------

func newAppKey(t *testing.T) (ed25519.PrivateKey, string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("app key: %v", err)
	}
	return priv, base64.RawURLEncoding.EncodeToString(pub)
}

// signObject canonicalizes obj (minus any sig), signs it, and returns the wire
// JSON (obj + sig).
func signObject(t *testing.T, priv ed25519.PrivateKey, obj map[string]any) []byte {
	t.Helper()
	delete(obj, "sig")
	canon, err := canonicalize(obj)
	if err != nil {
		t.Fatalf("canonicalize: %v", err)
	}
	obj["sig"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, canon))
	raw, err := json.Marshal(obj)
	if err != nil {
		t.Fatalf("marshal signed: %v", err)
	}
	return raw
}

// grantOpen posts a grant.open and returns the issued cnonce (or fails).
func grantOpen(t *testing.T, c *controller, grantRaw []byte, ap string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"v": 0, "typ": "grant.open",
		"grant": json.RawMessage(grantRaw), "access_point": ap,
	})
	st, resp, raw := httpJSONRaw(t, http.MethodPost, c.lanURL+"/grant/open", body)
	if st != 200 {
		t.Fatalf("grant.open: %d %s", st, raw)
	}
	cn, _ := resp["cnonce"].(string)
	if cn == "" {
		t.Fatalf("grant.open returned no challenge: %s", raw)
	}
	return cn
}

// grantProof posts a proof (grantID signed by appPriv) and returns (result, detail).
func grantProof(t *testing.T, c *controller, appPriv ed25519.PrivateKey, grantID, cnonce, ap string, ts int64) (string, string) {
	t.Helper()
	raw := signObject(t, appPriv, map[string]any{
		"v": 0, "typ": "grant.proof",
		"grant_id": grantID, "cnonce": cnonce, "access_point": ap, "ts": ts,
	})
	st, resp, body := httpJSONRaw(t, http.MethodPost, c.lanURL+"/grant/proof", raw)
	if st != 200 {
		t.Fatalf("grant.proof: %d %s", st, body)
	}
	result, _ := resp["result"].(string)
	detail, _ := resp["detail"].(string)
	return result, detail
}

// signedProof builds and app-signs a grant.proof, returning the wire bytes.
func signedProof(t *testing.T, appPriv ed25519.PrivateKey, grantID, cnonce, ap string, ts int64) []byte {
	t.Helper()
	return signObject(t, appPriv, map[string]any{
		"v": 0, "typ": "grant.proof",
		"grant_id": grantID, "cnonce": cnonce, "access_point": ap, "ts": ts,
	})
}

// postProof posts raw grant.proof bytes and returns (result, detail).
func postProof(t *testing.T, c *controller, raw []byte) (string, string) {
	t.Helper()
	st, resp, body := httpJSONRaw(t, http.MethodPost, c.lanURL+"/grant/proof", raw)
	if st != 200 {
		t.Fatalf("grant.proof: %d %s", st, body)
	}
	result, _ := resp["result"].(string)
	detail, _ := resp["detail"].(string)
	return result, detail
}

// tamperGrant mutates a signed grant's `member` field WITHOUT re-signing, so
// its signature no longer covers the presented bytes (a badsig case).
func tamperGrant(t *testing.T, grantRaw []byte) []byte {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(grantRaw, &m); err != nil {
		t.Fatalf("parse grant: %v", err)
	}
	m["member"] = "attacker@evil.example"
	raw, _ := json.Marshal(m)
	return raw
}

// grantIDOf extracts the grant_id from a signed grant wire object.
func grantIDOf(t *testing.T, grantRaw []byte) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(grantRaw, &m); err != nil {
		t.Fatalf("parse grant: %v", err)
	}
	return m["grant_id"].(string)
}

// ---------------------------------------------------------------------------
// small std-lib helpers
// ---------------------------------------------------------------------------

var httpClient = &http.Client{Timeout: 20 * time.Second}

// healthOK probes a /health URL, tolerating any error (returns false).
func healthOK(url string) bool {
	c := &http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return resp.StatusCode == 200 && m["ok"] == true
}

func httpJSON(t *testing.T, method, url, token string, body any) (int, map[string]any, string) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return doReq(t, req)
}

func httpJSONRaw(t *testing.T, method, url string, raw []byte) (int, map[string]any, string) {
	t.Helper()
	req, err := http.NewRequest(method, url, bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	return doReq(t, req)
}

func doReq(t *testing.T, req *http.Request) (int, map[string]any, string) {
	t.Helper()
	resp, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", req.Method, req.URL, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return resp.StatusCode, m, string(raw)
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func killProc(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(os.Interrupt)
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		_ = cmd.Process.Kill()
		<-done
	}
}
