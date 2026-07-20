// Command gateway is the lintel server: one Go binary — channels, rules,
// portal, API, device hub, audit — backed by one SQLite file.
//
// Configuration is flags-over-env:
//
//	-data / LINTEL_DATA_DIR             data directory (SQLite db, signing keys)   default ./data
//	-listen / LINTEL_LISTEN             listen address                             default :8080
//	-public-url / LINTEL_PUBLIC_URL     external base URL (webhooks, links)        default ""
//	-admin-claim-token / ADMIN_CLAIM_TOKEN
//	                                    one-shot instance-admin claim token; empty = claim disabled (fail-closed)
//	-behind-proxy / LINTEL_BEHIND_PROXY  permit binding a non-loopback -listen address; default false
//
// This binary serves plain HTTP — there is no built-in TLS/ACME (if you were
// looking for that, see README.md: TLS is the operator's responsibility, via
// a reverse proxy that terminates it and forwards to this process on
// loopback). Because of that, -listen REFUSES to start on anything but a
// loopback address (127.0.0.1/::1/localhost) unless -behind-proxy is passed:
// binding a public interface in plain HTTP would otherwise silently serve
// the admin portal, login, and signing API in cleartext. -behind-proxy is
// the operator's explicit statement "yes, TLS is terminated upstream of
// this" — it does not, and cannot, turn this binary into a TLS server
// itself. See checkListenAddr below for exactly what is and is not
// considered loopback.
//
// Chat-channel credentials (WHATSAPP_*/SLACK_*/TELEGRAM_*, no LINTEL_ prefix —
// see channels.FromEnv) are read directly from the environment, as is the
// WhatsApp engine selection:
//
//	LINTEL_WHATSAPP_ENGINE               "cloud" (default; also anything unset/
//	                                      misspelled) or the opt-in "bridge" —
//	                                      see channels.ResolveWhatsAppEngine.
//	                                      Selecting "bridge" logs a startup
//	                                      warning naming its account-ban risk.
//	LINTEL_WHATSAPP_BRIDGE_URL           opt-in self-hosted bridge (target:
//	LINTEL_WHATSAPP_BRIDGE_API_KEY       Evolution API) base URL / api key /
//	LINTEL_WHATSAPP_BRIDGE_INSTANCE      instance name — only consulted when
//	                                      LINTEL_WHATSAPP_ENGINE=bridge.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/vul-os/lintel/gateway/internal/channels"
	"github.com/vul-os/lintel/gateway/internal/httpapi"
	"github.com/vul-os/lintel/gateway/internal/keys"
	"github.com/vul-os/lintel/gateway/internal/store"
)

// Version is stamped via -ldflags "-X main.Version=..." at release time.
var Version = "0.1.0-dev"

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envBoolOr parses key as a bool (strconv.ParseBool: "1"/"t"/"true"/"TRUE"/
// "True" and their "0"/"f"/"false" counterparts), falling back to def when
// the variable is unset or does not parse.
func envBoolOr(key string, def bool) bool {
	if v := os.Getenv(key); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}

func main() {
	// `gateway verify-audit [-data DIR]` — a CLI subcommand form of
	// GET /v1/admin/audit/verify (see httpapi/adminops.go +
	// store/audithash.go) that works against a cold backup WITHOUT booting
	// the server or its HTTP surface at all: walks both tamper-evident
	// hash chains (access_logs, admin_audit_log) and reports the first
	// broken link, if any, with a non-zero exit code on failure.
	if len(os.Args) > 1 && os.Args[1] == "verify-audit" {
		os.Exit(runVerifyAudit(os.Args[2:]))
	}

	var (
		dataDir     = flag.String("data", envOr("LINTEL_DATA_DIR", "./data"), "data directory")
		listen      = flag.String("listen", envOr("LINTEL_LISTEN", ":8080"), "listen address")
		publicURL   = flag.String("public-url", envOr("LINTEL_PUBLIC_URL", ""), "external base URL")
		claimToken  = flag.String("admin-claim-token", envOr("ADMIN_CLAIM_TOKEN", ""), "one-shot admin claim token (empty disables claiming)")
		behindProxy = flag.Bool("behind-proxy", envBoolOr("LINTEL_BEHIND_PROXY", false), "permit binding a non-loopback -listen address (this binary serves plain HTTP; only set this when TLS is terminated upstream by a reverse proxy)")
	)
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	if err := run(*dataDir, *listen, *publicURL, *claimToken, *behindProxy, log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

// runVerifyAudit implements `gateway verify-audit`. It opens the SQLite
// database exactly the way the server does (store.Open), which means it
// applies any pending migration + hash-chain backfill to the file it is
// pointed at — a real, if small, mutation. For forensic use against a
// backup, run this against a COPY, never the original evidence file.
// (Operator-facing docs for this subcommand are not part of this change —
// see gateway/README.md, owned separately.)
func runVerifyAudit(args []string) int {
	fs := flag.NewFlagSet("verify-audit", flag.ExitOnError)
	dataDir := fs.String("data", envOr("LINTEL_DATA_DIR", "./data"), "data directory")
	fs.Parse(args)

	st, err := store.Open(*dataDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open store: %v\n", err)
		return 1
	}
	defer st.Close()

	results, err := st.VerifyHashChains(context.Background())
	if err != nil {
		fmt.Fprintf(os.Stderr, "verify: %v\n", err)
		return 1
	}
	ok := true
	for _, res := range results {
		if res.OK {
			fmt.Printf("%-16s OK   (%d rows)\n", res.Table, res.RowsChecked)
			continue
		}
		ok = false
		fmt.Printf("%-16s TAMPERED at index %d (row id %s): %s\n",
			res.Table, res.Break.Index, res.Break.RowID, res.Break.Reason)
	}
	if !ok {
		return 1
	}
	return 0
}

// checkListenAddr enforces the "no accidental public cleartext bind" rule
// described in this file's top-of-file doc comment. It resolves addr the
// same way net/http's Server would (host/port split, then IP-vs-hostname),
// and refuses anything that is not loopback-only unless behindProxy is set.
//
// This is deliberately about the RESOLVED address, not the literal flag
// text: "0.0.0.0:8080", "[::]:8080", ":8080" (empty host — Go's own
// "listen on all interfaces" shorthand) and a hostname whose DNS resolves
// off-box must all be caught, not just literal non-loopback IPs.
func checkListenAddr(addr string, behindProxy bool) error {
	if behindProxy {
		return nil
	}
	loopback, err := resolveListenLoopback(addr, net.LookupIP)
	if err != nil {
		return fmt.Errorf("-listen %q: %w", addr, err)
	}
	if loopback {
		return nil
	}
	return fmt.Errorf(
		"refusing to start: -listen %q is not a loopback address. "+
			"This binary serves plain HTTP with no built-in TLS — binding a "+
			"non-loopback address here would serve the admin portal, login, "+
			"and signing API in cleartext. Put a reverse proxy (that "+
			"terminates TLS) in front of this process and bind it to "+
			"loopback (e.g. -listen 127.0.0.1:8080), or, if you have already "+
			"done that and this process just needs to accept the proxy's "+
			"forwarded connections, pass -behind-proxy (or set "+
			"LINTEL_BEHIND_PROXY=1) to declare that intent explicitly. See "+
			"README.md's deployment/TLS section for the reverse-proxy setup.",
		addr)
}

// resolveListenLoopback reports whether every address addr's host part
// could resolve to is a loopback address. lookupIP resolves hostnames (it is
// injected so tests can cover hostname resolution deterministically, without
// depending on real DNS or /etc/hosts); production always passes
// net.LookupIP.
//
// Recognized forms:
//   - ""            (empty host, e.g. ":8080")            -> false (wildcard bind)
//   - "0.0.0.0"                                            -> false
//   - "::" / "[::]"                                        -> false (unspecified)
//   - "127.0.0.1", "127.x.x.x"                              -> true
//   - "::1", "[::1]"                                        -> true
//   - "localhost"                                           -> true (resolves loopback-only)
//   - any other hostname                                    -> true only if EVERY
//     address it resolves to is loopback; false (or an error) otherwise.
func resolveListenLoopback(addr string, lookupIP func(host string) ([]net.IP, error)) (bool, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false, fmt.Errorf("invalid listen address: %w", err)
	}
	if host == "" {
		// ":8080" — net/http binds this to all available unicast addresses,
		// i.e. the wildcard bind, exactly like "0.0.0.0"/"::". Not loopback.
		return false, nil
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback(), nil
	}
	// Not an IP literal: a hostname. Resolve it and require every address it
	// could resolve to be loopback — a hostname that resolves to a mix of
	// loopback and non-loopback addresses is, in practice, not a safe
	// loopback bind (whichever address the OS picks first at bind time may
	// not be the loopback one).
	ips, err := lookupIP(host)
	if err != nil {
		return false, fmt.Errorf("resolve listen host %q: %w", host, err)
	}
	if len(ips) == 0 {
		return false, fmt.Errorf("listen host %q resolved to no addresses", host)
	}
	for _, ip := range ips {
		if !ip.IsLoopback() {
			return false, nil
		}
	}
	return true, nil
}

func run(dataDir, listen, publicURL, claimToken string, behindProxy bool, log *slog.Logger) error {
	if err := checkListenAddr(listen, behindProxy); err != nil {
		return err
	}

	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("data dir: %w", err)
	}

	st, err := store.Open(dataDir)
	if err != nil {
		return fmt.Errorf("store: %w", err)
	}
	defer st.Close()

	ks, err := keys.Load(dataDir)
	if err != nil {
		return fmt.Errorf("keys: %w", err)
	}

	secret, err := loadOrCreateSecret(filepath.Join(dataDir, "jwt_secret"))
	if err != nil {
		return fmt.Errorf("jwt secret: %w", err)
	}

	srv := httpapi.New(httpapi.Config{
		Version:         Version,
		Env:             envOr("LINTEL_ENV", "self-hosted"),
		PublicURL:       publicURL,
		AdminClaimToken: claimToken,
		JWTSecret:       secret,
		// Rate-limit env layer (db overrides via PATCH /v1/admin/limits sit on
		// top; see store.ResolveRateLimitConfig).
		RateLimits: store.ParseRateLimitConfig(os.Getenv),
		// Credential-endpoint brute-force throttles (login/register/refresh/
		// admin-claim) — env-only, deliberately NOT admin-overridable at
		// runtime; see store.AuthRateLimitConfig's doc comment.
		AuthRateLimits: store.ParseAuthRateLimitConfig(os.Getenv),
		// Chat channels (WhatsApp/Slack/Telegram): env-named per the backend.
		Channels: channels.FromEnv(os.Getenv, publicURL),
	}, st, ks, log)

	// Always-on channel workers (Slack Socket Mode, when SLACK_APP_TOKEN set)
	// live for the process lifetime.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	srv.StartChannels(ctx)

	log.Info("lintel gateway", "version", Version, "listen", listen,
		"data", dataDir, "gateway_key", ks.PublicKeyB64())

	httpSrv := &http.Server{
		Addr:              listen,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	return httpSrv.ListenAndServe()
}

// loadOrCreateSecret persists a random 32-byte JWT signing secret in the data
// dir at first boot (hex, 0600) so sessions survive restarts.
func loadOrCreateSecret(path string) ([]byte, error) {
	if raw, err := os.ReadFile(path); err == nil {
		secret, err := hex.DecodeString(string(raw))
		if err != nil || len(secret) < 32 {
			return nil, fmt.Errorf("corrupt jwt secret file %s", path)
		}
		return secret, nil
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(hex.EncodeToString(secret)), 0o600); err != nil {
		return nil, err
	}
	return secret, nil
}
