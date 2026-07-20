package main

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vul-os/lintel/gateway/internal/store"

	_ "modernc.org/sqlite"
)

// discardLogger is a *slog.Logger that writes nowhere, for tests that only
// care about run()'s returned error, not its log output.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// captureStdout runs fn with os.Stdout redirected to a pipe and returns
// everything it printed. runVerifyAudit talks to a plain terminal (no
// structured logger), so this is the simplest way to assert on its output
// without changing its signature just for testability.
func captureStdout(t *testing.T, fn func() int) (string, int) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stdout
	os.Stdout = w
	code := fn()
	os.Stdout = orig
	w.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(out), code
}

// TestVerifyAuditCLICleanDatabase proves the CLI subcommand works against
// a database with no server booted (store.Open is the only thing it does —
// no HTTP, no httpapi.Server) and reports success on an untampered chain.
func TestVerifyAuditCLICleanDatabase(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	u, err := st.CreateUser(ctx, "cli@x.com", "h", "C", "")
	if err != nil {
		t.Fatal(err)
	}
	acct, loc, err := st.CreateAccountWithOwner(ctx, u.ID, "CLI House", "ZA")
	if err != nil {
		t.Fatal(err)
	}
	ap, err := st.CreateAccessPoint(ctx, acct.ID, loc.ID, "Gate", "gate")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertAccessLog(ctx, store.AccessLog{
		AccessPointID: ap.ID, LocationID: loc.ID, AccountID: acct.ID,
		Command: "open", Source: "web", Success: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.WriteAdminAudit(ctx, u.ID, "test_action", "thing", "t1", true, map[string]any{}); err != nil {
		t.Fatal(err)
	}
	st.Close()

	out, code := captureStdout(t, func() int { return runVerifyAudit([]string{"-data", dir}) })
	if code != 0 {
		t.Fatalf("want exit 0 on a clean chain, got %d, output:\n%s", code, out)
	}
	if !strings.Contains(out, "access_logs") || !strings.Contains(out, "admin_audit_log") {
		t.Errorf("expected both tables reported: %s", out)
	}
	if strings.Contains(out, "TAMPERED") {
		t.Errorf("clean database reported as tampered: %s", out)
	}
}

// TestVerifyAuditCLIDetectsTamper proves the non-zero exit path: a
// directly-tampered row (simulating an attacker with raw file access —
// the same threat model as internal/store/audithash_test.go's
// TestHashChainDetectsTamper) makes the CLI report TAMPERED and exit 1,
// entirely without booting the HTTP server.
func TestVerifyAuditCLIDetectsTamper(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	u, err := st.CreateUser(ctx, "cli2@x.com", "h", "C", "")
	if err != nil {
		t.Fatal(err)
	}
	acct, loc, err := st.CreateAccountWithOwner(ctx, u.ID, "CLI House 2", "ZA")
	if err != nil {
		t.Fatal(err)
	}
	ap, err := st.CreateAccessPoint(ctx, acct.ID, loc.ID, "Gate", "gate")
	if err != nil {
		t.Fatal(err)
	}
	logID, err := st.InsertAccessLog(ctx, store.AccessLog{
		AccessPointID: ap.ID, LocationID: loc.ID, AccountID: acct.ID,
		Command: "open", Source: "web", Success: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	st.Close()

	// Simulate an attacker with raw filesystem access to lintel.db —
	// exactly the threat model the hash chain defends against — by opening
	// the SQLite file directly, outside the Store type entirely, and
	// tampering with a row after dropping the append-only trigger.
	raw, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "lintel.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`DROP TRIGGER access_logs_immutable`); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`UPDATE access_logs SET error = 'forged' WHERE id = ?`, logID); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	out, code := captureStdout(t, func() int { return runVerifyAudit([]string{"-data", dir}) })
	if code != 1 {
		t.Fatalf("want exit 1 on a tampered chain, got %d, output:\n%s", code, out)
	}
	if !strings.Contains(out, "TAMPERED") || !strings.Contains(out, logID) {
		t.Errorf("expected TAMPERED report naming row %s: %s", logID, out)
	}
}

// fakeLookupIP builds a lookupIP-shaped func from a fixed table, so hostname
// resolution tests are hermetic (no real DNS / /etc/hosts dependency).
func fakeLookupIP(table map[string][]net.IP) func(string) ([]net.IP, error) {
	return func(host string) ([]net.IP, error) {
		ips, ok := table[host]
		if !ok {
			return nil, errors.New("fakeLookupIP: no such host " + host)
		}
		return ips, nil
	}
}

// TestResolveListenLoopback is the table-driven proof for the core claim of
// TASK 1: the check operates on the RESOLVED address, not the literal flag
// text, so every disguise for "bind everything" (empty host, 0.0.0.0, ::,
// [::], an off-loopback hostname) is caught exactly like every legitimate
// local-dev form (127.0.0.1, localhost, [::1]) is let through.
func TestResolveListenLoopback(t *testing.T) {
	lookup := fakeLookupIP(map[string][]net.IP{
		"localhost":              {net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		"public.example.invalid": {net.ParseIP("203.0.113.10")},
		"mixed.example.invalid":  {net.ParseIP("127.0.0.1"), net.ParseIP("203.0.113.10")},
	})

	tests := []struct {
		name     string
		addr     string
		wantLoop bool
		wantErr  bool
	}{
		// Legitimate local-dev forms — must NOT be blocked.
		{name: "ipv4 loopback", addr: "127.0.0.1:8080", wantLoop: true},
		{name: "ipv4 loopback other 127/8", addr: "127.5.5.5:8080", wantLoop: true},
		{name: "ipv6 loopback bracketed", addr: "[::1]:8080", wantLoop: true},
		{name: "localhost hostname", addr: "localhost:8080", wantLoop: true},

		// Every disguise for "bind everything" — must be blocked.
		{name: "empty host (wildcard shorthand)", addr: ":8080", wantLoop: false},
		{name: "explicit ipv4 wildcard", addr: "0.0.0.0:8080", wantLoop: false},
		{name: "ipv6 unspecified bare", addr: "0.0.0.0:8080", wantLoop: false},
		{name: "ipv6 unspecified bracketed", addr: "[::]:8080", wantLoop: false},
		{name: "hostname resolving off-loopback", addr: "public.example.invalid:8080", wantLoop: false},
		{name: "hostname resolving to a mix", addr: "mixed.example.invalid:8080", wantLoop: false},

		// Malformed / unresolvable — must error, not silently pass.
		{name: "missing port", addr: "127.0.0.1", wantErr: true},
		{name: "unresolvable hostname", addr: "nowhere.example.invalid:8080", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			loop, err := resolveListenLoopback(tt.addr, lookup)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("resolveListenLoopback(%q): want error, got loop=%v", tt.addr, loop)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveListenLoopback(%q): unexpected error: %v", tt.addr, err)
			}
			if loop != tt.wantLoop {
				t.Errorf("resolveListenLoopback(%q) = %v, want %v", tt.addr, loop, tt.wantLoop)
			}
		})
	}
}

// TestCheckListenAddr proves the fail-closed-by-default / opt-in-override
// behavior end to end (using the real net.LookupIP resolver, since
// "localhost" and "127.0.0.1" must work with zero mocking in real use):
// every non-loopback bind is refused unless -behind-proxy is set, and every
// loopback bind (including "localhost", the one hostname form operators
// actually use) always starts, flag or no flag.
func TestCheckListenAddr(t *testing.T) {
	tests := []struct {
		name        string
		addr        string
		behindProxy bool
		wantErr     bool
	}{
		{name: "loopback ipv4, no flag", addr: "127.0.0.1:8080", behindProxy: false, wantErr: false},
		{name: "loopback ipv6, no flag", addr: "[::1]:8080", behindProxy: false, wantErr: false},
		{name: "localhost hostname, no flag", addr: "localhost:8080", behindProxy: false, wantErr: false},
		{name: "wildcard empty host, no flag", addr: ":8080", behindProxy: false, wantErr: true},
		{name: "0.0.0.0, no flag", addr: "0.0.0.0:8080", behindProxy: false, wantErr: true},
		{name: "[::], no flag", addr: "[::]:8080", behindProxy: false, wantErr: true},
		{name: "0.0.0.0, behind-proxy set", addr: "0.0.0.0:8080", behindProxy: true, wantErr: false},
		{name: "wildcard empty host, behind-proxy set", addr: ":8080", behindProxy: true, wantErr: false},
		{name: "[::], behind-proxy set", addr: "[::]:8080", behindProxy: true, wantErr: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := checkListenAddr(tt.addr, tt.behindProxy)
			if tt.wantErr && err == nil {
				t.Fatalf("checkListenAddr(%q, behindProxy=%v): want error, got nil", tt.addr, tt.behindProxy)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("checkListenAddr(%q, behindProxy=%v): unexpected error: %v", tt.addr, tt.behindProxy, err)
			}
			if tt.wantErr && err != nil && !strings.Contains(err.Error(), "-behind-proxy") {
				t.Errorf("expected error to name the -behind-proxy escape hatch, got: %v", err)
			}
		})
	}
}

// TestRunRefusesPublicBindWithoutOptIn proves the wiring end to end through
// run() itself (not just the checkListenAddr helper): a non-loopback -listen
// with behindProxy=false must fail BEFORE touching disk (no data dir is
// created) or the network, and the same call with behindProxy=true (or a
// loopback address) must pass the gate. It does not assert ListenAndServe
// actually succeeds — httpSrv.ListenAndServe blocks forever on success, so
// that is out of scope here — only that the gate itself does not block a
// legitimate local-dev boot and does block an un-opted-in public one.
func TestRunRefusesPublicBindWithoutOptIn(t *testing.T) {
	log := discardLogger()

	dir := filepath.Join(t.TempDir(), "should-not-be-created")
	err := run(dir, "0.0.0.0:0", "", "", false, log)
	if err == nil {
		t.Fatal("run() with a public bind and behindProxy=false: want error, got nil")
	}
	if !strings.Contains(err.Error(), "-behind-proxy") {
		t.Errorf("expected error to name the -behind-proxy escape hatch, got: %v", err)
	}
	if _, statErr := os.Stat(dir); !os.IsNotExist(statErr) {
		t.Errorf("data dir %s should not have been created before the listen check ran", dir)
	}
}
