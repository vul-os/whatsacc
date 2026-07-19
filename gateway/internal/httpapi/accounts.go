package httpapi

import (
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/vul-os/whatsacc/gateway/internal/store"
)

// Accounts + members + invites, porting backend/src/routes/accounts.ts.
//
// Tenancy is app-layer: every handler resolves the caller's membership role
// in the target account FIRST (s.memberRole) and 404s for non-members —
// cross-tenant probes are indistinguishable from not-found, exactly like the
// Postgres RLS behavior being replaced.

var (
	phoneE164Re = regexp.MustCompile(`^\+[1-9][0-9]{6,14}$`)
	roleValues  = map[string]bool{"owner": true, "admin": true, "member": true, "viewer": true}
)

const inviteTTL = 7 * 24 * time.Hour

// memberRole resolves the caller's active role in accountID. On failure it
// writes 404 account_not_found (tenancy contract) and returns ok=false.
func (s *Server) memberRole(w http.ResponseWriter, r *http.Request, accountID string) (string, bool) {
	c := claimsFrom(r)
	role, err := s.store.MemberRole(r.Context(), accountID, c.Sub)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "account_not_found")
		return "", false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return "", false
	}
	return role, true
}

// isAdminRole is the backend's is_account_admin: owner or admin.
func isAdminRole(role string) bool { return role == "owner" || role == "admin" }

// requireAccountAdmin gates on admin-of-account: 404 for non-members (no
// existence leak), 403 not_account_admin for plain members.
func (s *Server) requireAccountAdmin(w http.ResponseWriter, r *http.Request, accountID string) bool {
	role, ok := s.memberRole(w, r, accountID)
	if !ok {
		return false
	}
	if !isAdminRole(role) {
		writeErr(w, http.StatusForbidden, "not_account_admin")
		return false
	}
	return true
}

// GET /v1/accounts
func (s *Server) handleAccountsList(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	accounts, err := s.store.AccountsForUser(r.Context(), c.Sub)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	list := make([]map[string]any, 0, len(accounts))
	for _, a := range accounts {
		list = append(list, map[string]any{
			"id": a.ID, "name": a.Name, "role": a.Role, "status": a.Status,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": list})
}

type createAccountReq struct {
	Name        string `json:"name"`
	CountryCode string `json:"country_code"`
}

// POST /v1/accounts — bootstraps account + owner membership + anchor location.
func (s *Server) handleAccountCreate(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	var req createAccountReq
	if !readJSON(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 120 {
		writeErr(w, http.StatusBadRequest, "invalid_name")
		return
	}
	if req.CountryCode != "" && len(req.CountryCode) != 2 {
		writeErr(w, http.StatusBadRequest, "invalid_country_code")
		return
	}
	acct, _, err := s.store.CreateAccountWithOwner(r.Context(), c.Sub, req.Name, strings.ToUpper(req.CountryCode))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": acct.ID})
}

// GET /v1/accounts/{id}
func (s *Server) handleAccountGet(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	acct, err := s.store.AccountByIDScoped(r.Context(), r.PathValue("id"), c.Sub)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "account_not_found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": acct.ID, "name": acct.Name, "status": acct.Status,
	})
}

type updateAccountReq struct {
	Name *string `json:"name"`
}

// PATCH /v1/accounts/{id} — rename (account admins; the accounts UPDATE RLS
// policy required is_account_admin).
func (s *Server) handleAccountPatch(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req updateAccountReq
	if !readJSON(w, r, &req) {
		return
	}
	if !s.requireAccountAdmin(w, r, id) {
		return
	}
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" || len(name) > 120 {
			writeErr(w, http.StatusBadRequest, "invalid_name")
			return
		}
		if err := s.store.RenameAccount(r.Context(), id, name); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /v1/accounts/{id}/members — full roster, members only (the
// app.account_member_list self-gate, app-layer).
func (s *Server) handleMembersList(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := s.memberRole(w, r, id); !ok {
		return
	}
	members, err := s.store.MemberList(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	list := make([]map[string]any, 0, len(members))
	for _, m := range members {
		var dn any
		if m.DisplayName != "" {
			dn = m.DisplayName
		}
		list = append(list, map[string]any{
			"user_id": m.UserID, "role": m.Role, "status": m.Status,
			"email": m.Email, "display_name": dn,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": list})
}

type inviteReq struct {
	Email     string `json:"email"`
	Role      string `json:"role"`
	PhoneE164 string `json:"phone_e164"`
}

// POST /v1/accounts/{id}/invites
//
// SECURITY (ported fix): the accept token is NEVER returned to the inviter —
// it is delivered to the INVITEE only. Without delivery channels wired in the
// gateway yet, email_sent/whatsapp_sent report false and tests recover the
// token via store.SetInviteTokenHash (backend parity for mocked delivery).
func (s *Server) handleInviteCreate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req inviteReq
	if !readJSON(w, r, &req) {
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if req.Email == "" || !strings.Contains(req.Email, "@") {
		writeErr(w, http.StatusBadRequest, "invalid_email")
		return
	}
	if req.Role == "" {
		req.Role = "member"
	}
	if !roleValues[req.Role] {
		writeErr(w, http.StatusBadRequest, "invalid_role")
		return
	}
	if !phoneE164Re.MatchString(req.PhoneE164) {
		writeErr(w, http.StatusBadRequest, "invalid_phone")
		return
	}
	if !s.requireAccountAdmin(w, r, id) {
		return
	}
	tokenPlain := randomToken()
	inviteID, err := s.store.CreateInvite(r.Context(), id, req.Email, req.Role, req.PhoneE164,
		hashToken(tokenPlain), time.Now().Add(inviteTTL).Unix())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	// tokenPlain deliberately dropped here — delivery seam (email/WhatsApp)
	// attaches later; the create response must never carry it.
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": inviteID, "email_sent": false, "whatsapp_sent": false,
	})
}

type acceptInviteReq struct {
	PhoneE164 string `json:"phone_e164"`
}

// POST /v1/accounts/invites/{token}/accept — cannot use account scope (the
// caller is not a member yet). NEVER auto-verifies phones (see store.AcceptInvite).
func (s *Server) handleInviteAccept(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	token := r.PathValue("token")
	var req acceptInviteReq
	if !readJSON(w, r, &req) {
		return
	}
	if req.PhoneE164 != "" && !phoneE164Re.MatchString(req.PhoneE164) {
		writeErr(w, http.StatusBadRequest, "invalid_phone")
		return
	}
	res, err := s.store.AcceptInvite(r.Context(), hashToken(token), c.Sub, req.PhoneE164)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "invite_not_found")
		return
	case errors.Is(err, store.ErrInviteUsed):
		writeErr(w, http.StatusBadRequest, "invite_used")
		return
	case errors.Is(err, store.ErrInviteRevoked):
		writeErr(w, http.StatusBadRequest, "invite_revoked")
		return
	case errors.Is(err, store.ErrInviteExpired):
		writeErr(w, http.StatusBadRequest, "invite_expired")
		return
	case errors.Is(err, store.ErrInviteEmailMismatch):
		writeErr(w, http.StatusBadRequest, "invite_email_mismatch")
		return
	case errors.Is(err, store.ErrInvitePhoneMismatch):
		writeErr(w, http.StatusBadRequest, "invite_phone_mismatch")
		return
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"account_id":                  res.AccountID,
		"role":                        res.Role,
		"phone_verification_required": res.PhoneVerificationRequired,
	})
}
