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

	"github.com/vul-os/whatsacc/gateway/internal/keys"
	"github.com/vul-os/whatsacc/gateway/internal/portal"
	"github.com/vul-os/whatsacc/gateway/internal/store"
)

// Config is what the server needs beyond its collaborators.
type Config struct {
	Version         string
	PublicURL       string
	AdminClaimToken string // empty = claim disabled (fail-closed)
	JWTSecret       []byte
}

// Server wires the store, signing keys and config into an http.Handler.
type Server struct {
	cfg   Config
	store *store.Store
	keys  *keys.Keys
	log   *slog.Logger
}

// New builds a Server.
func New(cfg Config, st *store.Store, ks *keys.Keys, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	return &Server{cfg: cfg, store: st, keys: ks, log: log}
}

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

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": s.cfg.Version})
}

func (s *Server) handleGatewayKey(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"alg":        "ed25519",
		"public_key": s.keys.PublicKeyB64(),
	})
}
