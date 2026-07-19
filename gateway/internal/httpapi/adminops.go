package httpapi

// Platform-admin (gateway operator) routes, porting backend
// src/routes/admin.ts (everything beyond the first-run claim in admin.go).
//
// SECURITY MODEL (ported):
//   - Every route sits behind requireAuth + a LIVE is_platform_admin check —
//     the users row is re-read per request, so revocation is immediate and
//     the JWT's adm claim is never trusted for gating. Denied probes are
//     audit-logged best-effort (the 403 never depends on the audit write).
//   - Cross-tenant store methods (store/admin.go) are only reachable through
//     this gate.
//   - "Last active platform admin" mutations run in one store transaction on
//     the single serialized SQLite connection — the equivalent of the
//     backend's pg_advisory_xact_lock serialization (SQLite has exactly one
//     writer; there is no interleaving window between the count and the
//     update inside the transaction).

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/vul-os/whatsacc/gateway/internal/store"
)

// requireAdmin wraps a handler with the live platform-admin gate.
func (s *Server) requireAdmin(next http.HandlerFunc) http.Handler {
	return s.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		c := claimsFrom(r)
		u, err := s.store.UserByID(r.Context(), c.Sub)
		if err != nil || u.Status != "active" || !u.IsPlatformAdmin {
			if err := s.store.WriteAdminAudit(r.Context(), c.Sub, "admin_access_denied",
				"route", r.URL.Path, false,
				map[string]any{"method": r.Method, "path": r.URL.Path}); err != nil {
				s.log.Error("admin_audit_write_failed", "err", err)
			}
			writeErr(w, http.StatusForbidden, "not_platform_admin")
			return
		}
		next(w, r)
	})
}

func pageParams(r *http.Request) (limit, offset int) {
	limit = 50
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v >= 1 && v <= 200 {
		limit = v
	}
	if v, err := strconv.Atoi(r.URL.Query().Get("offset")); err == nil && v >= 0 && v <= 1_000_000 {
		offset = v
	}
	return
}

// ---- Overview -------------------------------------------------------------

// GET /v1/admin/overview
func (s *Server) handleAdminOverview(w http.ResponseWriter, r *http.Request) {
	totals, err := s.store.AdminOverview(r.Context(), time.Now().Unix())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	signups, err := s.store.RecentSignups(r.Context(), 10)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	denials := map[string]any{"rate_limited": 0, "quota_exceeded": 0, "account_suspended": 0, "other": 0}
	total := 0
	for reason, n := range totals.DenialsToday {
		key := reason
		if _, known := denials[key]; !known {
			key = "other"
		}
		denials[key] = denials[key].(int) + n
		total += n
	}
	denials["total"] = total
	recent := make([]map[string]any, 0, len(signups))
	for _, u := range signups {
		recent = append(recent, map[string]any{
			"id": u.ID, "email": u.Email, "display_name": nilIfEmpty(u.DisplayName),
			"status": u.Status, "is_platform_admin": u.IsPlatformAdmin, "created_at": u.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"totals": map[string]any{
			"users": totals.Users, "accounts": totals.Accounts, "locations": totals.Locations,
			"devices": totals.Devices, "access_points": totals.AccessPoints,
		},
		"opens":          map[string]any{"today": totals.OpensToday, "last_7d": totals.OpensLast7d},
		"denials_today":  denials,
		"recent_signups": recent,
	})
}

// ---- Accounts -------------------------------------------------------------

// GET /v1/admin/accounts
func (s *Server) handleAdminAccounts(w http.ResponseWriter, r *http.Request) {
	limit, offset := pageParams(r)
	rows, total, err := s.store.AdminAccounts(r.Context(), r.URL.Query().Get("query"), limit, offset, time.Now().Unix())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	list := make([]map[string]any, 0, len(rows))
	for _, a := range rows {
		list = append(list, map[string]any{
			"id": a.ID, "name": a.Name, "status": a.Status, "country_code": a.CountryCode,
			"created_at": a.CreatedAt, "member_count": a.MemberCount,
			"location_count": a.LocationCount, "opens_7d": a.Opens7d,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": list, "total": total, "limit": limit, "offset": offset})
}

// GET /v1/admin/accounts/{id}
func (s *Server) handleAdminAccountGet(w http.ResponseWriter, r *http.Request) {
	d, err := s.store.AdminAccountByID(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "account_not_found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	members := make([]map[string]any, 0, len(d.Members))
	for _, m := range d.Members {
		members = append(members, map[string]any{
			"user_id": m.UserID, "email": m.Email, "display_name": nilIfEmpty(m.DisplayName),
			"role": m.Role, "status": m.Status,
		})
	}
	locations := make([]map[string]any, 0, len(d.Locations))
	for _, l := range d.Locations {
		locations = append(locations, map[string]any{
			"id": l.ID, "name": l.Name, "type": l.Type, "slug": l.Slug, "status": l.Status,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"account": map[string]any{
			"id": d.Account.ID, "name": d.Account.Name, "status": d.Account.Status,
			"country_code": d.Account.CountryCode, "created_at": d.CreatedAt,
		},
		"members":            members,
		"locations":          locations,
		"recent_access_logs": auditEntriesJSON(d.Recent),
	})
}

type adminAccountPatchReq struct {
	Status string `json:"status"`
}

// PATCH /v1/admin/accounts/{id} — suspend/reactivate (enforced by the
// choke point on every open).
func (s *Server) handleAdminAccountPatch(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	id := r.PathValue("id")
	var req adminAccountPatchReq
	if !readJSON(w, r, &req) {
		return
	}
	if req.Status != "active" && req.Status != "suspended" {
		writeErr(w, http.StatusBadRequest, "invalid_status")
		return
	}
	a, err := s.store.SetAccountStatus(r.Context(), id, req.Status)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "account_not_found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	_ = s.store.WriteAdminAudit(r.Context(), c.Sub, "account_status", "account", id, true,
		map[string]any{"status": req.Status})
	writeJSON(w, http.StatusOK, map[string]any{"account": map[string]any{
		"id": a.ID, "name": a.Name, "status": a.Status, "country_code": a.CountryCode,
	}})
}

// ---- Users ----------------------------------------------------------------

// GET /v1/admin/users
func (s *Server) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	limit, offset := pageParams(r)
	rows, total, err := s.store.AdminUsers(r.Context(), r.URL.Query().Get("query"), limit, offset)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	list := make([]map[string]any, 0, len(rows))
	for _, u := range rows {
		accounts := make([]map[string]any, 0, len(u.Accounts))
		for _, a := range u.Accounts {
			accounts = append(accounts, map[string]any{"account_id": a.AccountID, "name": a.Name, "role": a.Role})
		}
		list = append(list, map[string]any{
			"id": u.ID, "email": u.Email, "status": u.Status, "is_platform_admin": u.IsPlatformAdmin,
			"display_name": nilIfEmpty(u.DisplayName), "created_at": u.CreatedAt,
			"accounts": accounts, "last_access_at": nullInt64(u.LastAccessAt),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": list, "total": total, "limit": limit, "offset": offset})
}

type adminUserPatchReq struct {
	Status string `json:"status"`
}

// PATCH /v1/admin/users/{id} — disable/reactivate. Disabling revokes all
// refresh tokens; access tokens die at the live gates on next use.
func (s *Server) handleAdminUserPatch(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	id := r.PathValue("id")
	var req adminUserPatchReq
	if !readJSON(w, r, &req) {
		return
	}
	if req.Status != "active" && req.Status != "disabled" {
		writeErr(w, http.StatusBadRequest, "invalid_status")
		return
	}
	if req.Status == "disabled" && id == c.Sub {
		writeErr(w, http.StatusBadRequest, "cannot_disable_self")
		return
	}
	u, err := s.store.SetUserStatus(r.Context(), id, req.Status)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "user_not_found")
		return
	case errors.Is(err, store.ErrLastAdmin):
		writeErr(w, http.StatusBadRequest, "cannot_disable_last_admin")
		return
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	_ = s.store.WriteAdminAudit(r.Context(), c.Sub, "user_status", "user", id, true,
		map[string]any{"status": req.Status, "email": u.Email})
	writeJSON(w, http.StatusOK, map[string]any{"user": map[string]any{
		"id": u.ID, "email": u.Email, "status": u.Status, "is_platform_admin": u.IsPlatformAdmin,
	}})
}

type platformAdminReq struct {
	Grant *bool `json:"grant"`
}

// POST /v1/admin/users/{id}/platform-admin
func (s *Server) handleAdminPlatformAdmin(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	id := r.PathValue("id")
	var req platformAdminReq
	if !readJSON(w, r, &req) {
		return
	}
	if req.Grant == nil {
		writeErr(w, http.StatusBadRequest, "invalid_grant")
		return
	}
	u, err := s.store.SetPlatformAdmin(r.Context(), id, *req.Grant)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "user_not_found")
		return
	case errors.Is(err, store.ErrLastAdmin):
		writeErr(w, http.StatusBadRequest, "cannot_revoke_last_admin")
		return
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	_ = s.store.WriteAdminAudit(r.Context(), c.Sub, "platform_admin", "user", id, true,
		map[string]any{"grant": *req.Grant, "email": u.Email})
	writeJSON(w, http.StatusOK, map[string]any{"user": map[string]any{
		"id": u.ID, "email": u.Email, "status": u.Status, "is_platform_admin": u.IsPlatformAdmin,
	}})
}

// ---- Rate-limit overrides -------------------------------------------------

func rateLimitConfigJSON(cfg store.RateLimitConfig) map[string]any {
	return map[string]any{
		"open_cooldown_s":        cfg.OpenCooldownS,
		"opens_per_hour":         cfg.OpensPerHour,
		"chat_msgs_per_min":      cfg.ChatMsgsPerMin,
		"account_opens_per_hour": cfg.AccountOpensPerHour,
	}
}

func (s *Server) limitsPayload(r *http.Request) map[string]any {
	overrides := s.store.ReadRateLimitOverrides(r.Context())
	ovOut := map[string]any{}
	for _, f := range store.RateLimitOverrideFields {
		if v, ok := overrides[f]; ok {
			ovOut[f] = v
		} else {
			ovOut[f] = nil
		}
	}
	return map[string]any{
		"defaults":  rateLimitConfigJSON(store.RateLimitDefaults),
		"env":       rateLimitConfigJSON(s.cfg.RateLimits),
		"overrides": ovOut,
		"effective": rateLimitConfigJSON(store.MergeRateLimitConfig(s.cfg.RateLimits, overrides)),
	}
}

// GET /v1/admin/limits
func (s *Server) handleAdminLimitsGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.limitsPayload(r))
}

type limitsPatchReq struct {
	OpenCooldownS       json.RawMessage `json:"open_cooldown_s"`
	OpensPerHour        json.RawMessage `json:"opens_per_hour"`
	ChatMsgsPerMin      json.RawMessage `json:"chat_msgs_per_min"`
	AccountOpensPerHour json.RawMessage `json:"account_opens_per_hour"`
	ConfirmKillSwitch   bool            `json:"confirm_kill_switch"`
}

// parseOverridePatch: omitted (nil) / null (clear) / non-negative int.
func parseOverridePatch(raw json.RawMessage) (present bool, clear bool, val int64, ok bool) {
	if raw == nil {
		return false, false, 0, true
	}
	if string(raw) == "null" {
		return true, true, 0, true
	}
	var n int64
	if err := json.Unmarshal(raw, &n); err != nil || n < 0 || n > 1_000_000_000 {
		return false, false, 0, false
	}
	return true, false, n, true
}

// PATCH /v1/admin/limits — runtime overrides (db > env > default). 0 for
// opens_per_hour / account_opens_per_hour blocks EVERY gate on the instance
// (a real kill-switch feature) — it requires confirm_kill_switch: true so a
// typo or sloppy script can never do it by accident.
func (s *Server) handleAdminLimitsPatch(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	var req limitsPatchReq
	if !readJSON(w, r, &req) {
		return
	}
	fields := map[string]json.RawMessage{
		"open_cooldown_s":        req.OpenCooldownS,
		"opens_per_hour":         req.OpensPerHour,
		"chat_msgs_per_min":      req.ChatMsgsPerMin,
		"account_opens_per_hour": req.AccountOpensPerHour,
	}
	anyField := false
	wantsKillSwitch := false
	patch := map[string]any{} // audited
	current := s.store.ReadRateLimitOverrides(r.Context())
	next := store.RateLimitOverrides{}
	for k, v := range current {
		next[k] = v
	}
	for _, name := range store.RateLimitOverrideFields {
		present, clear, val, ok := parseOverridePatch(fields[name])
		if !ok {
			writeErr(w, http.StatusBadRequest, "invalid_limit_value")
			return
		}
		if !present {
			continue
		}
		anyField = true
		if clear {
			delete(next, name)
			patch[name] = nil
		} else {
			next[name] = val
			patch[name] = val
			if val == 0 && (name == "opens_per_hour" || name == "account_opens_per_hour") {
				wantsKillSwitch = true
			}
		}
	}
	if !anyField {
		writeErr(w, http.StatusBadRequest, "no_limit_fields")
		return
	}
	if wantsKillSwitch && !req.ConfirmKillSwitch {
		writeErr(w, http.StatusBadRequest, "kill_switch_confirmation_required")
		return
	}
	if err := s.store.InstanceSettingSet(r.Context(), store.InstanceRateLimitsKey, next, c.Sub); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	_ = s.store.WriteAdminAudit(r.Context(), c.Sub, "limits_update", "instance",
		store.InstanceRateLimitsKey, true, map[string]any{"patch": patch, "overrides": next})
	writeJSON(w, http.StatusOK, s.limitsPayload(r))
}

// ---- Audit ----------------------------------------------------------------

func auditEntriesJSON(entries []store.AuditLogEntry) []map[string]any {
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, map[string]any{
			"id": e.ID, "ts": e.TS, "command": nilIfEmpty(e.Command), "source": nilIfEmpty(e.Source),
			"success": e.Success, "error": nilIfEmpty(e.Error),
			"account_id": nilIfEmpty(e.AccountID), "account_name": nilIfEmpty(e.AccountName),
			"location_id": nilIfEmpty(e.LocationID), "location_name": nilIfEmpty(e.LocationName),
			"access_point_id": nilIfEmpty(e.AccessPointID), "access_point_name": nilIfEmpty(e.AccessPointName),
			"user_id": nilIfEmpty(e.UserID), "user_email": nilIfEmpty(e.UserEmail),
		})
	}
	return out
}

var auditKinds = map[string]bool{
	"": true, "all": true, "denied": true, "success": true, "open": true, "close": true,
	"rate_limited": true, "quota_exceeded": true, "account_suspended": true, "user_disabled": true,
}

// GET /v1/admin/audit — cross-account access_logs.
func (s *Server) handleAdminAudit(w http.ResponseWriter, r *http.Request) {
	limit, offset := pageParams(r)
	kind := r.URL.Query().Get("kind")
	if !auditKinds[kind] {
		writeErr(w, http.StatusBadRequest, "invalid_kind")
		return
	}
	entries, total, err := s.store.AdminAudit(r.Context(), kind, limit, offset)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if kind == "" {
		kind = "all"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"entries": auditEntriesJSON(entries), "total": total, "limit": limit, "offset": offset, "kind": kind,
	})
}

// GET /v1/admin/audit/actions — the admin-action trail.
func (s *Server) handleAdminAuditActions(w http.ResponseWriter, r *http.Request) {
	limit, offset := pageParams(r)
	actions, total, err := s.store.AdminAuditActions(r.Context(), limit, offset)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	list := make([]map[string]any, 0, len(actions))
	for _, a := range actions {
		list = append(list, map[string]any{
			"id": a.ID, "actor_user_id": nilIfEmpty(a.ActorUserID), "actor_email": nilIfEmpty(a.ActorEmail),
			"action": a.Action, "target_kind": nilIfEmpty(a.TargetKind), "target_id": nilIfEmpty(a.TargetID),
			"allowed": a.Allowed, "detail": a.Detail, "created_at": a.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"actions": list, "total": total, "limit": limit, "offset": offset})
}
