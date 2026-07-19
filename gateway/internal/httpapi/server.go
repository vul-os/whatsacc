// Package httpapi is the gateway's HTTP surface: std-lib net/http with Go
// 1.22 pattern routing, no framework (house style). Route shapes mirror the
// Workers backend (backend/src/routes/*) which is the behavioral spec; only a
// skeleton subset is ported so far — see gateway/README.md for the map.
package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/vul-os/whatsacc/gateway/internal/hub"
	"github.com/vul-os/whatsacc/gateway/internal/keys"
	"github.com/vul-os/whatsacc/gateway/internal/portal"
	"github.com/vul-os/whatsacc/gateway/internal/store"
)

// Config is what the server needs beyond its collaborators.
type Config struct {
	Version         string
	Env             string // reported by /health (backend APP_ENV parity)
	PublicURL       string
	AdminClaimToken string // empty = claim disabled (fail-closed)
	JWTSecret       []byte
	// AckTimeout bounds how long an open request waits for the device's
	// cmd.ack before recording 'undelivered'. Zero = default 5 s.
	AckTimeout time.Duration
	// RateLimits is the env layer of the rate-limit config (defaults
	// merged in main via store.ParseRateLimitConfig). Zero value = defaults.
	RateLimits store.RateLimitConfig
}

// Server wires the store, signing keys, device hub and config into an
// http.Handler.
type Server struct {
	cfg   Config
	store *store.Store
	keys  *keys.Keys
	hub   *hub.Hub
	log   *slog.Logger
}

// New builds a Server.
func New(cfg Config, st *store.Store, ks *keys.Keys, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	if cfg.AckTimeout <= 0 {
		cfg.AckTimeout = 5 * time.Second
	}
	if cfg.Env == "" {
		cfg.Env = "self-hosted"
	}
	if (cfg.RateLimits == store.RateLimitConfig{}) {
		cfg.RateLimits = store.RateLimitDefaults
	}
	return &Server{cfg: cfg, store: st, keys: ks, hub: hub.New(), log: log}
}

// Hub exposes the device hub (tests + channel integrations).
func (s *Server) Hub() *hub.Hub { return s.hub }

// Router builds the mux. Later-ported route groups (accounts, locations,
// access, devices, channels, admin console) attach here.
func (s *Server) Router() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /v1/gateway/key", s.handleGatewayKey)

	// auth (spec: backend/src/routes/auth.ts)
	mux.HandleFunc("POST /v1/auth/register", s.handleRegister)
	mux.HandleFunc("POST /v1/auth/login", s.handleLogin)
	mux.HandleFunc("POST /v1/auth/refresh", s.handleRefresh)
	mux.HandleFunc("POST /v1/auth/logout", s.handleLogout)
	mux.Handle("GET /v1/auth/me", s.requireAuth(s.handleMe))

	// instance admin first-run claim (spec: backend/src/routes/admin.ts)
	mux.Handle("GET /v1/admin/claim", s.requireAuth(s.handleClaimState))
	mux.Handle("POST /v1/admin/claim", s.requireAuth(s.handleClaim))

	// platform-admin console (spec: backend admin.ts) — live-admin gated
	mux.Handle("GET /v1/admin/overview", s.requireAdmin(s.handleAdminOverview))
	mux.Handle("GET /v1/admin/accounts", s.requireAdmin(s.handleAdminAccounts))
	mux.Handle("GET /v1/admin/accounts/{id}", s.requireAdmin(s.handleAdminAccountGet))
	mux.Handle("PATCH /v1/admin/accounts/{id}", s.requireAdmin(s.handleAdminAccountPatch))
	mux.Handle("GET /v1/admin/users", s.requireAdmin(s.handleAdminUsers))
	mux.Handle("PATCH /v1/admin/users/{id}", s.requireAdmin(s.handleAdminUserPatch))
	mux.Handle("POST /v1/admin/users/{id}/platform-admin", s.requireAdmin(s.handleAdminPlatformAdmin))
	mux.Handle("GET /v1/admin/limits", s.requireAdmin(s.handleAdminLimitsGet))
	mux.Handle("PATCH /v1/admin/limits", s.requireAdmin(s.handleAdminLimitsPatch))
	mux.Handle("GET /v1/admin/audit", s.requireAdmin(s.handleAdminAudit))
	mux.Handle("GET /v1/admin/audit/actions", s.requireAdmin(s.handleAdminAuditActions))

	// accounts + members + invites (spec: backend/src/routes/accounts.ts)
	mux.Handle("GET /v1/accounts", s.requireAuth(s.handleAccountsList))
	mux.Handle("POST /v1/accounts", s.requireAuth(s.handleAccountCreate))
	// literal "invites" segment wins over {id} in the 1.22 mux
	mux.Handle("POST /v1/accounts/invites/{token}/accept", s.requireAuth(s.handleInviteAccept))
	mux.Handle("GET /v1/accounts/{id}", s.requireAuth(s.handleAccountGet))
	mux.Handle("PATCH /v1/accounts/{id}", s.requireAuth(s.handleAccountPatch))
	mux.Handle("GET /v1/accounts/{id}/members", s.requireAuth(s.handleMembersList))
	mux.Handle("POST /v1/accounts/{id}/invites", s.requireAuth(s.handleInviteCreate))

	// locations + limits (spec: backend/src/routes/locations.ts)
	mux.Handle("GET /v1/accounts/{id}/locations", s.requireAuth(s.handleLocationsList))
	mux.Handle("POST /v1/accounts/{id}/locations", s.requireAuth(s.handleLocationCreate))
	mux.Handle("POST /v1/locations", s.requireAuth(s.handleTopLevelLocationCreate))
	mux.Handle("GET /v1/locations/{id}", s.requireAuth(s.handleLocationGet))
	mux.Handle("PATCH /v1/locations/{id}", s.requireAuth(s.handleLocationPatch))
	mux.Handle("DELETE /v1/locations/{id}", s.requireAuth(s.handleLocationDelete))
	mux.Handle("GET /v1/locations/{id}/limits", s.requireAuth(s.handleLocationLimitsGet))
	mux.Handle("PATCH /v1/locations/{id}/limits", s.requireAuth(s.handleLocationLimitsPatch))

	// access points (spec: backend/src/routes/access.ts)
	mux.Handle("GET /v1/access-points", s.requireAuth(s.handleAccessPointsList))
	mux.Handle("POST /v1/access-points", s.requireAuth(s.handleAccessPointCreate))
	mux.Handle("GET /v1/access-points/{id}", s.requireAuth(s.handleAccessPointGet))

	// the open path + temporary grants (spec: backend access.ts logAccess)
	mux.Handle("POST /v1/access-points/{id}/open", s.requireAuth(s.handleAccessPointOpen))
	mux.Handle("POST /v1/access-points/{id}/close", s.requireAuth(s.handleAccessPointClose))
	mux.Handle("GET /v1/grants", s.requireAuth(s.handleGrantsList))
	mux.Handle("POST /v1/grants", s.requireAuth(s.handleGrantCreate))
	mux.Handle("GET /v1/grants/{id}", s.requireAuth(s.handleGrantGet))
	mux.Handle("POST /v1/grants/{id}/revoke", s.requireAuth(s.handleGrantRevoke))

	// devices + pairing + controller transport (spec: backend devices.ts +
	// proto/pairing.md)
	mux.Handle("GET /v1/devices", s.requireAuth(s.handleDevicesList))
	mux.Handle("POST /v1/devices", s.requireAuth(s.handleDeviceCreate))
	mux.HandleFunc("POST /api/pair/redeem", s.handlePairRedeem)
	mux.HandleFunc("GET /api/controller/ws", s.handleControllerWS)
	mux.HandleFunc("POST /api/controller/challenge", s.handleControllerChallenge)
	mux.HandleFunc("POST /api/controller/poll", s.handleControllerPoll)
	mux.HandleFunc("POST /api/controller/ack", s.handleControllerAck)

	// embedded portal seam — everything unmatched falls through to it
	mux.Handle("/", portal.Handler())

	return mux
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

type ctxKey int

const claimsKey ctxKey = 0

// requireAuth verifies the Bearer access token and stashes claims in context.
func (s *Server) requireAuth(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		tok, ok := strings.CutPrefix(h, "Bearer ")
		if !ok || tok == "" {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		claims, err := VerifyJWT(s.cfg.JWTSecret, tok)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), claimsKey, claims)))
	})
}

func claimsFrom(r *http.Request) *Claims {
	c, _ := r.Context().Value(claimsKey).(*Claims)
	return c
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// health + gateway key
// ---------------------------------------------------------------------------

// handleHealth mirrors backend/src/app.ts GET /health so the Tauri gateway
// picker (src/lib/gateway.ts testGatewayUrl) can probe any gateway: it reads
// {ok, env} and treats ok:false as an unhealthy DB. db_now proves the SQLite
// handle is live (the backend selected now() from Postgres). On a DB error we
// return ok:false + 500, exactly like the backend.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	dbNow, err := s.store.DBNow(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "env": s.cfg.Env, "db_now": dbNow, "version": s.cfg.Version,
	})
}

func (s *Server) handleGatewayKey(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"alg":        "ed25519",
		"public_key": s.keys.PublicKeyB64(),
	})
}
