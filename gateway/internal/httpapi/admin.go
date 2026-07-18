package httpapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"
)

// First-run instance-admin claim, porting backend/src/routes/admin.ts
// GET/POST /admin/claim semantics:
//
//   - authenticated but deliberately NOT admin-gated (it bootstraps the admin)
//   - fail-closed: no ADMIN_CLAIM_TOKEN configured → nobody can claim
//   - constant-time token comparison
//   - one-shot: winning burns the mechanism permanently via the
//     'admin_claimed' instance_settings flag + is_platform_admin flag,
//     atomically in store.ClaimPlatformAdmin
//
// Deferred with admin_audit_log: audit rows for denied/successful claims.

// GET /v1/admin/claim — boolean-only disclosure for setup UIs.
func (s *Server) handleClaimState(w http.ResponseWriter, r *http.Request) {
	claimed, err := s.store.AdminClaimState(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	tokenConfigured := strings.TrimSpace(s.cfg.AdminClaimToken) != ""
	writeJSON(w, http.StatusOK, map[string]any{
		"claimed":   claimed,
		"claimable": tokenConfigured && !claimed,
	})
}

type claimReq struct {
	Token string `json:"token"`
}

// POST /v1/admin/claim
func (s *Server) handleClaim(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	var req claimReq
	if !readJSON(w, r, &req) {
		return
	}

	claimed, err := s.store.AdminClaimState(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if claimed {
		writeErr(w, http.StatusForbidden, "claim_closed")
		return
	}
	envToken := strings.TrimSpace(s.cfg.AdminClaimToken)
	if envToken == "" {
		writeErr(w, http.StatusForbidden, "claim_disabled")
		return
	}
	if !timingSafeEqual(req.Token, envToken) {
		writeErr(w, http.StatusForbidden, "invalid_claim_token")
		return
	}

	won, err := s.store.ClaimPlatformAdmin(r.Context(), c.Sub)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if !won {
		writeErr(w, http.StatusForbidden, "claim_closed")
		return
	}
	s.log.Info("instance claimed", "user", c.Sub, "email", c.Email)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "user_id": c.Sub, "is_platform_admin": true,
	})
}

// timingSafeEqual compares two strings in constant time regardless of length
// mismatch (hash both, then compare digests — same trick as the backend's
// timingSafeEqualStr).
func timingSafeEqual(a, b string) bool {
	ha := sha256.Sum256([]byte(a))
	hb := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
}
