// Command gateway is the whatsacc server: one Go binary — channels, rules,
// portal, API, device hub, audit — backed by one SQLite file.
//
// Configuration is flags-over-env:
//
//	-data / WACC_DATA_DIR             data directory (SQLite db, signing keys)   default ./data
//	-listen / WACC_LISTEN             listen address                             default :8080
//	-public-url / WACC_PUBLIC_URL     external base URL (webhooks, links)        default ""
//	-admin-claim-token / ADMIN_CLAIM_TOKEN
//	                                  one-shot instance-admin claim token; empty = claim disabled (fail-closed)
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/vul-os/whatsacc/gateway/internal/channels"
	"github.com/vul-os/whatsacc/gateway/internal/httpapi"
	"github.com/vul-os/whatsacc/gateway/internal/keys"
	"github.com/vul-os/whatsacc/gateway/internal/store"
)

// Version is stamped via -ldflags "-X main.Version=..." at release time.
var Version = "0.1.0-dev"

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	var (
		dataDir    = flag.String("data", envOr("WACC_DATA_DIR", "./data"), "data directory")
		listen     = flag.String("listen", envOr("WACC_LISTEN", ":8080"), "listen address")
		publicURL  = flag.String("public-url", envOr("WACC_PUBLIC_URL", ""), "external base URL")
		claimToken = flag.String("admin-claim-token", envOr("ADMIN_CLAIM_TOKEN", ""), "one-shot admin claim token (empty disables claiming)")
	)
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	if err := run(*dataDir, *listen, *publicURL, *claimToken, log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(dataDir, listen, publicURL, claimToken string, log *slog.Logger) error {
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
		Env:             envOr("WACC_ENV", "self-hosted"),
		PublicURL:       publicURL,
		AdminClaimToken: claimToken,
		JWTSecret:       secret,
		// Rate-limit env layer (db overrides via PATCH /v1/admin/limits sit on
		// top; see store.ResolveRateLimitConfig).
		RateLimits: store.ParseRateLimitConfig(os.Getenv),
		// Chat channels (WhatsApp/Slack/Telegram): env-named per the backend.
		Channels: channels.FromEnv(os.Getenv, publicURL),
	}, st, ks, log)

	// Always-on channel workers (Slack Socket Mode, when SLACK_APP_TOKEN set)
	// live for the process lifetime.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	srv.StartChannels(ctx)

	log.Info("whatsacc gateway", "version", Version, "listen", listen,
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
