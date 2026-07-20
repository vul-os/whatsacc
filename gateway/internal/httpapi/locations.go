package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/vul-os/lintel/gateway/internal/store"
)

// Locations + quotas, porting backend/src/routes/locations.ts.

var locationTypes = map[string]bool{"house": true, "complex": true, "building": true, "other": true}

// locationScope resolves a location id to its owning account and the
// caller's role there. Non-members get 404 location_not_found — a location
// in another tenant is indistinguishable from a missing one.
func (s *Server) locationScope(w http.ResponseWriter, r *http.Request, locationID string) (accountID, role string, ok bool) {
	c := claimsFrom(r)
	accountID, err := s.store.LocationAccountID(r.Context(), locationID)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "location_not_found")
		return "", "", false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return "", "", false
	}
	role, err = s.store.MemberRole(r.Context(), accountID, c.Sub)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "location_not_found")
		return "", "", false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return "", "", false
	}
	return accountID, role, true
}

func locationJSON(d store.LocationDetail, withCounts bool) map[string]any {
	var addr any = json.RawMessage(d.Address)
	m := map[string]any{
		"id":                 d.ID,
		"parent_location_id": nilIfEmpty(d.ParentLocationID),
		"type":               d.Type,
		"name":               d.Name,
		"slug":               d.Slug,
		"status":             d.Status,
		"address":            addr,
	}
	if withCounts {
		m["access_point_count"] = d.AccessPointCount
		m["member_count"] = d.MemberCount
		m["last_opened_at"] = nullInt64(d.LastOpenedAt)
	} else {
		m["account_id"] = d.AccountID
		m["lat"] = nullFloat64(d.Lat)
		m["long"] = nullFloat64(d.Long)
	}
	return m
}

// GET /v1/accounts/{id}/locations
func (s *Server) handleLocationsList(w http.ResponseWriter, r *http.Request) {
	accountID := r.PathValue("id")
	if _, ok := s.memberRole(w, r, accountID); !ok {
		return
	}
	locs, err := s.store.LocationsByAccountDetailed(r.Context(), accountID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	list := make([]map[string]any, 0, len(locs))
	for _, l := range locs {
		list = append(list, locationJSON(l, true))
	}
	writeJSON(w, http.StatusOK, map[string]any{"locations": list})
}

type createLocationReq struct {
	ParentLocationID *string        `json:"parent_location_id"`
	Type             string         `json:"type"`
	Name             string         `json:"name"`
	Slug             string         `json:"slug"`
	Address          map[string]any `json:"address"`
	Lat              *float64       `json:"lat"`
	Long             *float64       `json:"long"`
}

// POST /v1/accounts/{id}/locations — nested create under an existing account
// (admin, per the locations INSERT policy). Creator becomes location owner.
func (s *Server) handleLocationCreate(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	accountID := r.PathValue("id")
	var req createLocationReq
	if !readJSON(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 120 || !locationTypes[req.Type] {
		writeErr(w, http.StatusBadRequest, "invalid_location")
		return
	}
	if !s.requireAccountAdmin(w, r, accountID) {
		return
	}
	parent := ""
	if req.ParentLocationID != nil {
		parent = *req.ParentLocationID
	}
	id, err := s.store.CreateLocationFull(r.Context(), accountID, store.CreateLocationArgs{
		ParentLocationID: parent,
		Type:             req.Type,
		Name:             req.Name,
		Slug:             req.Slug,
		AddressJSON:      marshalAddress(req.Address),
		Lat:              req.Lat,
		Long:             req.Long,
		CreatorUserID:    c.Sub,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if err := s.store.WriteAdminAudit(r.Context(), c.Sub, "location_create", "location", id, true,
		map[string]any{"account_id": accountID, "name": req.Name, "type": req.Type}); err != nil {
		s.log.Error("location create audit write failed", "location_id", id, "err", err)
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

type createTopLevelLocationReq struct {
	Name        string         `json:"name"`
	Type        string         `json:"type"`
	CountryCode string         `json:"country_code"`
	Address     map[string]any `json:"address"`
	Lat         *float64       `json:"lat"`
	Long        *float64       `json:"long"`
}

// POST /v1/locations — top-level create: locations are first-class, each one
// gets a FRESH 1:1 account so its members are isolated from any other
// location the same user owns. The caller becomes owner of the new account.
func (s *Server) handleTopLevelLocationCreate(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	var req createTopLevelLocationReq
	if !readJSON(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Type == "" {
		req.Type = "house"
	}
	if req.Name == "" || len(req.Name) > 120 || !locationTypes[req.Type] {
		writeErr(w, http.StatusBadRequest, "invalid_location")
		return
	}
	// CreateAccountWithOwner already creates the anchor location (1:1 model);
	// apply the extra fields to it.
	acct, loc, err := s.store.CreateAccountWithOwner(r.Context(), c.Sub, req.Name, strings.ToUpper(req.CountryCode))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	patch := store.LocationPatch{Lat: req.Lat, Long: req.Long}
	if req.Type != "house" {
		// anchor defaults to house; adjust via direct update
		_ = s.store.UpdateLocationType(r.Context(), acct.ID, loc.ID, req.Type)
	}
	if req.Address != nil {
		aj := marshalAddress(req.Address)
		patch.AddressJSON = &aj
	}
	if patch.AddressJSON != nil || patch.Lat != nil || patch.Long != nil {
		if err := s.store.UpdateLocation(r.Context(), acct.ID, loc.ID, patch); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
	}
	if err := s.store.UpsertLocationMember(r.Context(), loc.ID, c.Sub, "owner"); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": loc.ID, "account_id": acct.ID})
}

// GET /v1/locations/{id}
func (s *Server) handleLocationGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	accountID, _, ok := s.locationScope(w, r, id)
	if !ok {
		return
	}
	d, err := s.store.LocationDetailByID(r.Context(), accountID, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, locationJSON(*d, false))
}

type patchLocationReq struct {
	Name    *string        `json:"name"`
	Address map[string]any `json:"address"`
	Lat     *float64       `json:"lat"`
	Long    *float64       `json:"long"`
	Status  *string        `json:"status"`
}

// PATCH /v1/locations/{id} — admins only. Backend parity note: under RLS a
// plain member's UPDATE filtered to zero rows and surfaced as 404; we
// reproduce that observable behavior (404, not 403) for non-admin members.
func (s *Server) handleLocationPatch(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	id := r.PathValue("id")
	var req patchLocationReq
	if !readJSON(w, r, &req) {
		return
	}
	accountID, role, ok := s.locationScope(w, r, id)
	if !ok {
		return
	}
	if !isAdminRole(role) {
		writeErr(w, http.StatusNotFound, "location_not_found")
		return
	}
	if req.Name != nil && (strings.TrimSpace(*req.Name) == "" || len(*req.Name) > 120) {
		writeErr(w, http.StatusBadRequest, "invalid_name")
		return
	}
	patch := store.LocationPatch{Name: req.Name, Lat: req.Lat, Long: req.Long, Status: req.Status}
	if req.Address != nil {
		aj := marshalAddress(req.Address)
		patch.AddressJSON = &aj
	}
	if err := s.store.UpdateLocation(r.Context(), accountID, id, patch); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "location_not_found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if err := s.store.WriteAdminAudit(r.Context(), c.Sub, "location_update", "location", id, true,
		map[string]any{"account_id": accountID}); err != nil {
		s.log.Error("location patch audit write failed", "location_id", id, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// DELETE /v1/locations/{id} — owner/admin of the parent account; drops the
// 1:1 account when no sibling locations remain.
func (s *Server) handleLocationDelete(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	id := r.PathValue("id")
	accountID, role, ok := s.locationScope(w, r, id)
	if !ok {
		return
	}
	if !isAdminRole(role) {
		writeErr(w, http.StatusForbidden, "not_account_admin")
		return
	}
	dropped, err := s.store.DeleteLocation(r.Context(), accountID, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if err := s.store.WriteAdminAudit(r.Context(), c.Sub, "location_delete", "location", id, true,
		map[string]any{"account_id": accountID, "account_dropped": dropped}); err != nil {
		s.log.Error("location delete audit write failed", "location_id", id, "err", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id, "account_dropped": dropped})
}

// ---------------------------------------------------------------------------
// Limits (abuse-protection quotas) + usage
// ---------------------------------------------------------------------------

// GET /v1/locations/{id}/limits — member-visible so the portal can show
// "3 of 4 opens used"; usage computed over the same UTC day window the
// enforcement counters use.
func (s *Server) handleLocationLimitsGet(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	id := r.PathValue("id")
	if _, _, ok := s.locationScope(w, r, id); !ok {
		return
	}
	quotas, err := s.store.LocationQuotas(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	dayStart := store.FixedWindowStart(time.Now().Unix(), store.DayS)
	locOpens, myOpens, members, err := s.store.LocationUsage(r.Context(), id, c.Sub, dayStart)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	memberList := make([]map[string]any, 0, len(members))
	for _, m := range members {
		memberList = append(memberList, map[string]any{
			"user_id": nilIfEmpty(m.UserID), "email": nilIfEmpty(m.Email), "opens_today": m.OpensToday,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"location_id": id,
		"quotas": map[string]any{
			"max_opens_per_member_per_day":   quotas.MaxOpensPerMemberPerDay,
			"max_opens_per_location_per_day": quotas.MaxOpensPerLocationPerDay,
		},
		"usage": map[string]any{
			"day_start":            time.Unix(dayStart, 0).UTC().Format(time.RFC3339),
			"location_opens_today": locOpens,
			"my_opens_today":       myOpens,
			"members":              memberList,
		},
	})
}

type patchLimitsReq struct {
	MaxOpensPerMemberPerDay   json.RawMessage `json:"max_opens_per_member_per_day"`
	MaxOpensPerLocationPerDay json.RawMessage `json:"max_opens_per_location_per_day"`
}

// parseLimitField distinguishes omitted (raw==nil) / null (clear) / integer.
func parseLimitField(raw json.RawMessage, maxV int64) (has bool, val *int64, ok bool) {
	if raw == nil {
		return false, nil, true
	}
	if string(raw) == "null" {
		return true, nil, true
	}
	var n int64
	if err := json.Unmarshal(raw, &n); err != nil || n < 1 || n > maxV {
		return false, nil, false
	}
	return true, &n, true
}

// PATCH /v1/locations/{id}/limits — admin-only. NULL clears a cap
// (unlimited); omitted fields are left unchanged.
func (s *Server) handleLocationLimitsPatch(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	id := r.PathValue("id")
	var req patchLimitsReq
	if !readJSON(w, r, &req) {
		return
	}
	hasM, mv, okM := parseLimitField(req.MaxOpensPerMemberPerDay, 100_000)
	hasL, lv, okL := parseLimitField(req.MaxOpensPerLocationPerDay, 1_000_000)
	if !okM || !okL {
		writeErr(w, http.StatusBadRequest, "invalid_limit")
		return
	}
	_, role, ok := s.locationScope(w, r, id)
	if !ok {
		return
	}
	if !isAdminRole(role) {
		writeErr(w, http.StatusForbidden, "not_account_admin")
		return
	}
	quotas, err := s.store.PatchLocationQuotas(r.Context(), id, hasM, mv, hasL, lv)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if err := s.store.WriteAdminAudit(r.Context(), c.Sub, "location_limits_update", "location", id, true,
		map[string]any{
			"max_opens_per_member_per_day":   quotas.MaxOpensPerMemberPerDay,
			"max_opens_per_location_per_day": quotas.MaxOpensPerLocationPerDay,
		}); err != nil {
		s.log.Error("location limits patch audit write failed", "location_id", id, "err", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"location_id": id,
		"quotas": map[string]any{
			"max_opens_per_member_per_day":   quotas.MaxOpensPerMemberPerDay,
			"max_opens_per_location_per_day": quotas.MaxOpensPerLocationPerDay,
		},
	})
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

func marshalAddress(m map[string]any) string {
	if m == nil {
		return "{}"
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
