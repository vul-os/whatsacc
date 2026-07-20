package httpapi

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/vul-os/lintel/gateway/internal/store"
)

// Auth endpoints — the skeleton subset of backend/src/routes/auth.ts. Real
// argon2id hashing and real token issuance; the ceremony around them
// (email verification, password reset, Google OAuth, invites) is deferred.

const (
	accessTTL  = 15 * time.Minute
	refreshTTL = 30 * 24 * time.Hour
)

func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

type registerReq struct {
	Email        string `json:"email"`
	Password     string `json:"password"`
	DisplayName  string `json:"display_name"`
	LocationName string `json:"location_name"`
	CountryCode  string `json:"country_code"`
}

// POST /v1/auth/register — create user + profile + personal account with one
// anchor location (invite_token path deferred with account_invites).
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req registerReq
	if !readJSON(w, r, &req) {
		return
	}
	req.Email = strings.TrimSpace(req.Email)
	if req.Email == "" || !strings.Contains(req.Email, "@") {
		writeErr(w, http.StatusBadRequest, "invalid_email")
		return
	}
	if len(req.Password) < 8 {
		writeErr(w, http.StatusBadRequest, "weak_password")
		return
	}
	if strings.TrimSpace(req.LocationName) == "" {
		writeErr(w, http.StatusBadRequest, "location_required")
		return
	}
	hash, err := HashPassword(req.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	u, err := s.store.CreateUser(r.Context(), req.Email, hash, req.DisplayName, req.CountryCode)
	if errors.Is(err, store.ErrEmailTaken) {
		writeErr(w, http.StatusConflict, "email_taken")
		return
	}
	if err != nil {
		s.log.Error("register", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	acct, loc, err := s.store.CreateAccountWithOwner(r.Context(), u.ID, req.LocationName, req.CountryCode)
	if err != nil {
		s.log.Error("register account", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	tokens, ok := s.issueTokensCtx(w, r, u)
	if !ok {
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"user":       map[string]any{"id": u.ID, "email": u.Email},
		"account":    map[string]any{"id": acct.ID, "name": acct.Name},
		"location":   map[string]any{"id": loc.ID, "name": loc.Name, "slug": loc.Slug},
		"tokens":     tokens,
		"token_type": "Bearer",
	})
}

type loginReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// POST /v1/auth/login
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if !readJSON(w, r, &req) {
		return
	}
	u, err := s.store.UserByEmail(r.Context(), req.Email)
	if err != nil {
		// Burn a verify anyway so user-not-found and bad-password take
		// comparable time (no account enumeration by timing).
		VerifyPassword(req.Password, dummyHash)
		writeErr(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	if u.Status != "active" || u.PasswordHash == "" || !VerifyPassword(req.Password, u.PasswordHash) {
		writeErr(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	tokens, ok := s.issueTokensCtx(w, r, u)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":       map[string]any{"id": u.ID, "email": u.Email, "is_platform_admin": u.IsPlatformAdmin},
		"tokens":     tokens,
		"token_type": "Bearer",
	})
}

// dummyHash keeps login timing flat when the email doesn't exist.
var dummyHash = func() string {
	h, err := HashPassword("lintel-dummy")
	if err != nil {
		panic(err)
	}
	return h
}()

type refreshReq struct {
	RefreshToken string `json:"refresh_token"`
}

// POST /v1/auth/refresh — rotate the refresh token; a replayed (already
// rotated/revoked) token revokes its whole family (reuse detection, per the
// backend's family model).
func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req refreshReq
	if !readJSON(w, r, &req) {
		return
	}
	rt, err := s.store.RefreshTokenByHash(r.Context(), hashToken(req.RefreshToken))
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid_refresh_token")
		return
	}
	if rt.RevokedAt.Valid || rt.ReplacedBy.Valid {
		// Reuse of a rotated token: kill the family.
		_ = s.store.RevokeRefreshFamily(r.Context(), rt.FamilyID)
		writeErr(w, http.StatusUnauthorized, "refresh_token_reused")
		return
	}
	if time.Now().Unix() >= rt.ExpiresAt {
		writeErr(w, http.StatusUnauthorized, "refresh_token_expired")
		return
	}
	u, err := s.store.UserByID(r.Context(), rt.UserID)
	if err != nil || u.Status != "active" {
		writeErr(w, http.StatusUnauthorized, "invalid_refresh_token")
		return
	}
	newPlain := randomToken()
	newID := store.NewID()
	if err := s.store.RotateRefreshToken(r.Context(), rt.ID, newID, rt.FamilyID, u.ID,
		hashToken(newPlain), time.Now().Add(refreshTTL).Unix()); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	access, err := SignJWT(s.cfg.JWTSecret, u.ID, u.Email, u.IsPlatformAdmin, accessTTL)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tokens":     map[string]any{"access_token": access, "refresh_token": newPlain},
		"token_type": "Bearer",
	})
}

// POST /v1/auth/logout — revoke the presented refresh token's family.
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	var req refreshReq
	if !readJSON(w, r, &req) {
		return
	}
	if rt, err := s.store.RefreshTokenByHash(r.Context(), hashToken(req.RefreshToken)); err == nil {
		_ = s.store.RevokeRefreshFamily(r.Context(), rt.FamilyID)
	}
	// Idempotent: unknown tokens still get 200 (nothing to enumerate).
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// GET /v1/auth/me
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	u, err := s.store.UserByID(r.Context(), c.Sub)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	accounts, err := s.store.AccountsForUser(r.Context(), u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	list := make([]map[string]any, 0, len(accounts))
	for _, a := range accounts {
		list = append(list, map[string]any{"id": a.ID, "name": a.Name, "role": a.Role})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":     map[string]any{"id": u.ID, "email": u.Email, "is_platform_admin": u.IsPlatformAdmin},
		"accounts": list,
	})
}

// issueTokensCtx issues access+refresh with the request context.
func (s *Server) issueTokensCtx(w http.ResponseWriter, r *http.Request, u *store.User) (map[string]any, bool) {
	access, err := SignJWT(s.cfg.JWTSecret, u.ID, u.Email, u.IsPlatformAdmin, accessTTL)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return nil, false
	}
	refresh := randomToken()
	if err := s.store.InsertRefreshToken(r.Context(), store.NewID(), store.NewID(), u.ID,
		hashToken(refresh), time.Now().Add(refreshTTL).Unix()); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return nil, false
	}
	return map[string]any{"access_token": access, "refresh_token": refresh}, true
}
