// Package httpapi is the gateway's HTTP surface: std-lib net/http with Go
// 1.22 pattern routing, no framework (house style). Route shapes mirror the
// Workers backend (backend/src/routes/*) which is the behavioral spec; only a
// skeleton subset is ported so far — see gateway/README.md for the map.
package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/vul-os/lintel/gateway/internal/channels"
	"github.com/vul-os/lintel/gateway/internal/hub"
	"github.com/vul-os/lintel/gateway/internal/keys"
	"github.com/vul-os/lintel/gateway/internal/portal"
	"github.com/vul-os/lintel/gateway/internal/store"
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
	// AuthRateLimits bounds the credential endpoints (login/register/
	// refresh) and the admin claim against brute-force/DoS — see
	// store.AuthRateLimitConfig's doc comment. Zero value = defaults.
	AuthRateLimits store.AuthRateLimitConfig
	// Channels holds the chat-channel credentials (WhatsApp/Slack/Telegram).
	// Zero value = every channel refuses its webhook (fail-closed) and its
	// sender is a config-unset no-op.
	Channels channels.Config
	// DMTAPTransport is the DMTAP dial-out channel's transport (see
	// channels/dmtap.go). nil (the default — main.go never sets this today)
	// means the DMTAP channel is disabled: fail-closed, never a silent no-op
	// that could be mistaken for working. There is no env var for this yet
	// because there is no real transport to configure (see dmtap.go's TODO).
	DMTAPTransport channels.DMTAPTransport
}

// Server wires the store, signing keys, device hub and config into an
// http.Handler.
type Server struct {
	cfg   Config
	store *store.Store
	keys  *keys.Keys
	hub   *hub.Hub
	log   *slog.Logger

	// Chat-channel seam (internal/channels). The Channel values authenticate
	// inbound webhooks; the senders are interfaces so tests inject fakes.
	wa        channels.WhatsApp
	slack     channels.Slack
	tg        channels.Telegram
	waSend    channels.WhatsAppSender
	slackSend channels.SlackSender
	tgSend    channels.TelegramSender
	socket    *channels.SocketMode // non-nil only when a Slack app token is set; also in dial below
	dmtap     *channels.DMTAP      // non-nil only when cfg.DMTAPTransport is set; also in dial below

	// dial holds every configured DialChannel (subscribe-shaped channels —
	// see channels.DialChannel): Slack Socket Mode today, DMTAP alongside it.
	// StartChannels launches whichever of these report Enabled().
	dial []channels.DialChannel
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
	if (cfg.AuthRateLimits == store.AuthRateLimitConfig{}) {
		cfg.AuthRateLimits = store.AuthRateLimitDefaults
	}
	if cfg.Channels.PublicURL == "" {
		cfg.Channels.PublicURL = cfg.PublicURL
	}
	s := &Server{cfg: cfg, store: st, keys: ks, hub: hub.New(), log: log}
	ch := cfg.Channels
	s.wa = channels.WhatsApp{AppSecret: ch.WhatsAppAppSecret, VerifyToken: ch.WhatsAppVerifyToken, PublicURL: ch.PublicURL}
	s.slack = channels.Slack{SigningSecret: ch.SlackSigningSecret}
	s.tg = channels.Telegram{WebhookSecret: ch.TelegramWebhookSecret}
	// WhatsApp engine: cloud (Meta Cloud API) is the default and the only
	// implicit choice; the self-hosted bridge is opt-in only and, when
	// selected, gets a non-negotiable startup warning naming the account-ban
	// risk (see channels/send.go's "WhatsApp engine selection" section).
	waEngine := channels.ResolveWhatsAppEngine(ch.WhatsAppEngine)
	if waEngine == channels.WhatsAppEngineBridge {
		log.Warn(channels.WhatsAppBanRiskWarning)
	}
	s.waSend = channels.NewWhatsAppSender(waEngine, ch)
	s.slackSend = &channels.HTTPSlackSender{BotToken: ch.SlackBotToken}
	s.tgSend = &channels.HTTPTelegramSender{BotToken: ch.TelegramBotToken}
	if ch.SlackAppToken != "" {
		// Socket Mode: the zero-URL path. Events + interactions arrive over the
		// outbound WebSocket and are fed through the SAME handlers as the webhook.
		s.socket = &channels.SocketMode{AppToken: ch.SlackAppToken, Logger: log, Handle: s.handleSlackSocketEnvelope}
		s.dial = append(s.dial, s.socket)
	}
	if cfg.DMTAPTransport != nil {
		// DMTAP: the second DialChannel, proving the seam generalizes beyond
		// Slack. Only reachable when a caller injects a real Transport (see
		// channels/dmtap.go — none exists in this codebase yet); main.go never
		// does, so this stays disabled in the shipped binary today.
		s.dmtap = &channels.DMTAP{Transport: cfg.DMTAPTransport, Logger: log, Handle: s.handleDMTAPIntent}
		s.dial = append(s.dial, s.dmtap)
	}
	return s
}

// Hub exposes the device hub (tests + channel integrations).
func (s *Server) Hub() *hub.Hub { return s.hub }

// StartChannels launches every configured dial-out channel worker
// (channels.DialChannel — Slack Socket Mode, DMTAP) bound to ctx. Disabled
// channels (Enabled() == false, e.g. no credentials configured) are skipped:
// fail-closed, never "runs unauthenticated". Call once after New; it returns
// immediately, the workers run in the background.
func (s *Server) StartChannels(ctx context.Context) {
	for _, d := range s.dial {
		if d == nil || !d.Enabled() {
			continue
		}
		s.log.Info("dial-out channel enabled", "channel", d.Kind())
		go d.Run(ctx)
	}
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
	mux.Handle("POST /v1/auth/logout-all", s.requireAuth(s.handleLogoutAll))
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
	mux.Handle("GET /v1/admin/audit/verify", s.requireAdmin(s.handleAdminAuditVerify))

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

	// offline grants (spec: proto/grants.md) — the gateway-side issuance half
	// of the emergency no-internet path; controller/internal/grants verifies.
	mux.Handle("POST /v1/offline-grants", s.requireAuth(s.handleOfflineGrantIssue))

	// devices + pairing + controller transport (spec: backend devices.ts +
	// proto/pairing.md)
	mux.Handle("GET /v1/devices", s.requireAuth(s.handleDevicesList))
	mux.Handle("POST /v1/devices", s.requireAuth(s.handleDeviceCreate))
	// proto/pairing.md's diagram specifies POST /pair/redeem — that's the path
	// the controller builds from its --gateway URL. Serve it there (spec form)
	// and keep the /api alias for existing callers.
	mux.HandleFunc("POST /pair/redeem", s.handlePairRedeem)
	mux.HandleFunc("POST /api/pair/redeem", s.handlePairRedeem)
	mux.HandleFunc("GET /api/controller/ws", s.handleControllerWS)
	mux.HandleFunc("POST /api/controller/challenge", s.handleControllerChallenge)
	mux.HandleFunc("POST /api/controller/poll", s.handleControllerPoll)
	mux.HandleFunc("POST /api/controller/ack", s.handleControllerAck)

	// chat channels (spec: backend/src/routes/{whatsapp,slack,telegram}.ts).
	// Unauthenticated by design: each self-authenticates its provider signature
	// / secret token (fail-closed), then funnels opens through the SAME
	// store.LogAccess choke point + hub dispatch the /v1 open route uses.
	mux.HandleFunc("GET /webhooks/whatsapp", s.handleWhatsAppVerify)
	mux.HandleFunc("POST /webhooks/whatsapp", s.handleWhatsAppWebhook)
	mux.HandleFunc("POST /webhooks/slack", s.handleSlackEvents)
	mux.HandleFunc("POST /webhooks/slack/interactions", s.handleSlackInteractions)
	mux.HandleFunc("POST /webhooks/telegram", s.handleTelegramWebhook)

	// embedded portal seam — everything unmatched falls through to it
	mux.Handle("/", portal.Handler())

	return mux
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

type ctxKey int

const claimsKey ctxKey = 0

// requireAuth verifies the Bearer access token AND re-reads the user's LIVE
// status from the users row before letting the request through.
//
// Before this, only requireAdmin (adminops.go) did the live re-read — its
// own comment explains why: "the users row is re-read per request, so
// revocation is immediate and the JWT's adm claim is never trusted for
// gating." That discipline was not applied to ordinary auth, so a disabled
// user's still-signature-valid access token kept working for up to its
// full TTL (accessTTL, 15 minutes) after an admin disabled them — the
// finding this closes. The cost is one extra query per authenticated
// request (requireAdmin already pays it, and pays it TWICE now — once here
// and once for its own is_platform_admin check — a small, accepted
// redundancy on a self-hosted, requests-per-minute-not-per-second system).
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
		u, err := s.store.UserByID(r.Context(), claims.Sub)
		if err != nil || u.Status != "active" {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), claimsKey, claims)))
	})
}

// clientIP returns the TCP peer address (the host part of RemoteAddr) —
// NEVER a client-supplied header. X-Forwarded-For / X-Real-IP are
// deliberately not honored: this gateway has no configured trusted-proxy
// allowlist, and without one, trusting a client-controlled header would
// let an attacker mint a fresh "IP" on every request and defeat every
// per-IP throttle in authratelimit.go outright. A reverse-proxy deployment
// that wants per-real-client throttling needs a trusted-proxy config added
// first — using an unvalidated header here would be a worse regression
// than not supporting that deployment shape yet.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// authIPGate enforces an IP-scoped auth throttle (store.AuthRateLimitConfig)
// before a credential-endpoint handler does any real work. It writes the
// response itself on denial/error and returns false — callers just
// `if !s.authIPGate(...) { return }`, the same shape as this package's
// other gate helpers (memberRole, requireAccountAdmin, ...).
//
// Fails CLOSED on a counter-store error — see authratelimit.go's package
// doc comment for why this deliberately diverges from openpath.go's
// fail-open policy.
func (s *Server) authIPGate(w http.ResponseWriter, r *http.Request, scope string, limit int64) bool {
	ok, retry, err := s.store.CheckAuthRateLimit(r.Context(), scope, "ip:"+clientIP(r), limit, time.Now().Unix())
	if err != nil {
		s.log.Error("auth rate limit check failed", "scope", scope, "err", err)
		writeErr(w, http.StatusServiceUnavailable, "rate_limit_unavailable")
		return false
	}
	if !ok {
		w.Header().Set("Retry-After", strconv.FormatInt(retry, 10))
		writeErr(w, http.StatusTooManyRequests, "rate_limited")
		return false
	}
	return true
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
