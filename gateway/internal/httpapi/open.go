package httpapi

// The open path (product core) + temporary grants, porting the rest of
// backend/src/routes/access.ts. Every open funnels through store.LogAccess —
// the single choke point — and, unlike the Workers backend (whose device
// dispatch was still a TODO), an allowed open is then SIGNED and pushed to
// the access point's controller over the device hub.

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/vul-os/whatsacc/gateway/internal/store"
)

var opSources = map[string]bool{"web": true, "whatsapp": true, "api": true}

type opReq struct {
	Lat    *float64 `json:"lat"`
	Long   *float64 `json:"long"`
	Source string   `json:"source"`
}

func (s *Server) handleAccessPointOpen(w http.ResponseWriter, r *http.Request) {
	s.handleOp(w, r, "open")
}

func (s *Server) handleAccessPointClose(w http.ResponseWriter, r *http.Request) {
	s.handleOp(w, r, "close")
}

func (s *Server) handleOp(w http.ResponseWriter, r *http.Request, command string) {
	c := claimsFrom(r)
	id := r.PathValue("id")
	var req opReq
	if !readJSON(w, r, &req) {
		return
	}
	if req.Source == "" {
		req.Source = "web"
	}
	if !opSources[req.Source] {
		writeErr(w, http.StatusBadRequest, "invalid_source")
		return
	}

	// Membership gate (the backend's RLS at-route equivalent): non-members
	// get 404 before the choke point ever runs.
	if _, _, ok := s.accessPointScope(w, r, id); !ok {
		return
	}

	verdict, err := s.store.LogAccess(r.Context(), s.cfg.RateLimits, store.LogAccessArgs{
		UserID:        c.Sub,
		AccessPointID: id,
		Command:       command,
		Source:        req.Source,
		Lat:           req.Lat,
		Long:          req.Long,
	})
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "access_point_not_found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if !verdict.Allowed {
		switch verdict.Reason {
		case "account_suspended", "user_disabled":
			writeErr(w, http.StatusForbidden, verdict.Reason)
		default: // rate_limited | quota_exceeded → 429 + Retry-After
			w.Header().Set("Retry-After", strconv.FormatInt(verdict.RetryAfterS, 10))
			writeJSON(w, http.StatusTooManyRequests, map[string]any{
				"error":         verdict.Reason,
				"retry_after_s": verdict.RetryAfterS,
			})
		}
		return
	}

	delivery := s.dispatchCommand(r, command, verdict)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "command": command, "delivery": delivery,
	})
}

// dispatchCommand signs the envelope and pushes it to the access point's
// controller. Outcomes (audited on the access_logs row per commands.md):
//
//	acked        controller answered (a denied/errored ack is audit-tagged)
//	undelivered  connected but silent past the ack deadline
//	queued       offline — queued for the long-poll fallback
//	no_device    access point has no controller attached (backend parity:
//	             the open still succeeds; dispatch was a backend TODO)
func (s *Server) dispatchCommand(r *http.Request, command string, verdict *store.LogAccessResult) string {
	if verdict.AP.DeviceID == "" {
		return "no_device"
	}
	cause := map[string]any{"source": "gateway", "log_id": verdict.LogID}
	env, err := s.keys.SignCommand(command, verdict.AP.DeviceID, verdict.AP.ID, 30*time.Second, cause)
	if err != nil {
		s.log.Error("sign command", "err", err)
		_ = s.store.UpdateAccessLogError(r.Context(), verdict.LogID, "undelivered")
		return "undelivered"
	}
	outcome := s.hub.Dispatch(r.Context(), verdict.AP.DeviceID, env, s.cfg.AckTimeout)
	switch outcome.Delivery {
	case "acked":
		if outcome.Result == "denied" || outcome.Result == "error" {
			tag := "ack:" + outcome.Result
			if outcome.Detail != "" {
				tag += ":" + outcome.Detail
			}
			_ = s.store.UpdateAccessLogError(r.Context(), verdict.LogID, tag)
		}
	case "undelivered":
		_ = s.store.UpdateAccessLogError(r.Context(), verdict.LogID, "undelivered")
	}
	return outcome.Delivery
}

// ---------------------------------------------------------------------------
// Temporary access grants
// ---------------------------------------------------------------------------

func grantJSON(g store.Grant) map[string]any {
	var maxUses any
	if g.MaxUses.Valid {
		maxUses = g.MaxUses.Int64
	}
	return map[string]any{
		"id":                 g.ID,
		"account_id":         g.AccountID,
		"granted_by_user_id": nilIfEmpty(g.GrantedByUserID),
		"phone_e164":         g.PhoneE164,
		"visitor_name":       nilIfEmpty(g.VisitorName),
		"starts_at":          g.StartsAt,
		"ends_at":            g.EndsAt,
		"max_uses":           maxUses,
		"uses_count":         g.UsesCount,
		"status":             g.Status,
		"effective_status":   g.EffectiveStatus(time.Now().Unix()),
		"revoked_at":         nullInt64(g.RevokedAt),
		"notes":              nilIfEmpty(g.Notes),
		"last_used_at":       nullInt64(g.LastUsedAt),
		"access_point_ids":   g.AccessPointIDs,
		"created_at":         g.CreatedAt,
	}
}

// GET /v1/grants[?account_id=&phone_e164=&status=]
func (s *Server) handleGrantsList(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	q := r.URL.Query()
	accountID := q.Get("account_id")
	phone := q.Get("phone_e164")
	status := q.Get("status")
	if status != "" && status != "active" && status != "revoked" {
		writeErr(w, http.StatusBadRequest, "invalid_status")
		return
	}
	if phone != "" && !phoneE164Re.MatchString(phone) {
		writeErr(w, http.StatusBadRequest, "invalid_phone")
		return
	}
	var accountIDs []string
	if accountID != "" {
		if _, ok := s.memberRole(w, r, accountID); !ok {
			return
		}
		accountIDs = []string{accountID}
	} else {
		accounts, err := s.store.AccountsForUser(r.Context(), c.Sub)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		for _, a := range accounts {
			accountIDs = append(accountIDs, a.ID)
		}
	}
	list := make([]map[string]any, 0)
	for _, aid := range accountIDs {
		grants, err := s.store.GrantsByAccount(r.Context(), aid, phone, status)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		for _, g := range grants {
			list = append(list, grantJSON(g))
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"grants": list})
}

// grantScope finds the grant across the caller's accounts (RLS-equivalent).
func (s *Server) grantScope(w http.ResponseWriter, r *http.Request, grantID string) (*store.Grant, string, bool) {
	c := claimsFrom(r)
	accounts, err := s.store.AccountsForUser(r.Context(), c.Sub)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return nil, "", false
	}
	for _, a := range accounts {
		g, err := s.store.GrantByID(r.Context(), a.ID, grantID)
		if err == nil {
			return g, a.Role, true
		}
		if !errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusInternalServerError, "internal")
			return nil, "", false
		}
	}
	writeErr(w, http.StatusNotFound, "grant_not_found")
	return nil, "", false
}

// GET /v1/grants/{id}
func (s *Server) handleGrantGet(w http.ResponseWriter, r *http.Request) {
	g, _, ok := s.grantScope(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, grantJSON(*g))
}

type grantCreateReq struct {
	PhoneE164      string   `json:"phone_e164"`
	VisitorName    string   `json:"visitor_name"`
	StartsAt       string   `json:"starts_at"`
	EndsAt         string   `json:"ends_at"`
	MaxUses        *int64   `json:"max_uses"`
	AccessPointIDs []string `json:"access_point_ids"`
	Notes          string   `json:"notes"`
}

// POST /v1/grants — all access points must belong to ONE account the caller
// admins; cross-tenant access points are indistinguishable from missing.
func (s *Server) handleGrantCreate(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	var req grantCreateReq
	if !readJSON(w, r, &req) {
		return
	}
	if !phoneE164Re.MatchString(req.PhoneE164) {
		writeErr(w, http.StatusBadRequest, "invalid_phone")
		return
	}
	if len(req.AccessPointIDs) < 1 || len(req.AccessPointIDs) > 50 ||
		len(req.VisitorName) > 120 || len(req.Notes) > 2000 ||
		(req.MaxUses != nil && (*req.MaxUses < 1 || *req.MaxUses > 10_000)) {
		writeErr(w, http.StatusBadRequest, "invalid_grant")
		return
	}
	startsAt := time.Now().Unix()
	if req.StartsAt != "" {
		t, err := time.Parse(time.RFC3339, req.StartsAt)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid_starts_at")
			return
		}
		startsAt = t.Unix()
	}
	endT, err := time.Parse(time.RFC3339, req.EndsAt)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_ends_at")
		return
	}
	endsAt := endT.Unix()
	if endsAt <= startsAt {
		writeErr(w, http.StatusBadRequest, "invalid_window")
		return
	}

	// 1. Resolve every AP; all must exist and share one account.
	accountID := ""
	seen := map[string]bool{}
	for _, apID := range req.AccessPointIDs {
		if seen[apID] {
			writeErr(w, http.StatusBadRequest, "invalid_grant")
			return
		}
		seen[apID] = true
		apc, err := s.store.AccessPointContextByID(r.Context(), apID)
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "access_point_not_found")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		if accountID == "" {
			accountID = apc.AccountID
		} else if apc.AccountID != accountID {
			writeErr(w, http.StatusBadRequest, "cross_account_grant")
			return
		}
	}
	// 2. Caller must be a member (else 404 — no existence leak) and admin.
	role, err := s.store.MemberRole(r.Context(), accountID, c.Sub)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "access_point_not_found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if !isAdminRole(role) {
		writeErr(w, http.StatusForbidden, "not_account_admin")
		return
	}

	g, err := s.store.CreateGrant(r.Context(), accountID, store.CreateGrantArgs{
		GrantedByUserID: c.Sub,
		PhoneE164:       req.PhoneE164,
		VisitorName:     strings.TrimSpace(req.VisitorName),
		StartsAt:        startsAt,
		EndsAt:          endsAt,
		MaxUses:         req.MaxUses,
		Notes:           req.Notes,
		AccessPointIDs:  req.AccessPointIDs,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	// Visitor WhatsApp notification: channel seam, not wired in the gateway
	// yet (documented in README).
	writeJSON(w, http.StatusCreated, grantJSON(*g))
}

// POST /v1/grants/{id}/revoke — account admins only.
func (s *Server) handleGrantRevoke(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	g, role, ok := s.grantScope(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	if !isAdminRole(role) {
		writeErr(w, http.StatusForbidden, "not_account_admin")
		return
	}
	revoked, err := s.store.RevokeGrant(r.Context(), g.AccountID, g.ID, c.Sub)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "grant_not_revocable")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, grantJSON(*revoked))
}
