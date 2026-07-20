package httpapi

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/vul-os/lintel/gateway/internal/store"
)

// Access points (and, from stage 3, the open path + temporary grants),
// porting backend/src/routes/access.ts.

var apKinds = map[string]bool{"gate": true, "door": true, "barrier": true, "other": true}

// accessPointJSON is the backend shapeAccessPoint parity shape. The meter is
// derived from access_logs; movement metering + maintenance records are
// deferred (documented deviation in gateway/README.md), so the maintenance
// block carries the "nothing recorded" shape.
func accessPointJSON(d store.AccessPointDetail) map[string]any {
	return map[string]any{
		"id":          d.ID,
		"location_id": d.LocationID,
		"name":        d.Name,
		"kind":        d.Kind,
		"device_id":   nilIfEmpty(d.DeviceID),
		"status":      d.Status,
		"meter": map[string]any{
			"movement_m":   0,
			"total_opens":  d.TotalOpens,
			"total_closes": d.TotalCloses,
			"last_op_at":   nullInt64(d.LastOpAt),
		},
		"maintenance": map[string]any{
			"last_serviced_at":        nil,
			"last_service_movement_m": nil,
			"next_due_movement_m":     nil,
			"next_due_at":             nil,
			"due_now":                 false,
			"movement_remaining_m":    nil,
			"pct_used":                nil,
		},
	}
}

// GET /v1/access-points[?account_id=] — with account_id the listing is
// scoped to that tenant (member gate); without it, every access point across
// the caller's accounts (backend RLS default view).
func (s *Server) handleAccessPointsList(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	accountID := r.URL.Query().Get("account_id")
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
		aps, err := s.store.AccessPointsByAccountDetailed(r.Context(), aid)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		for _, ap := range aps {
			list = append(list, accessPointJSON(ap))
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"access_points": list})
}

// accessPointScope resolves an access point to its owning account/location
// and the caller's role. Non-members get 404 access_point_not_found.
func (s *Server) accessPointScope(w http.ResponseWriter, r *http.Request, apID string) (apc *store.AccessPointContext, role string, ok bool) {
	c := claimsFrom(r)
	apc, err := s.store.AccessPointContextByID(r.Context(), apID)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "access_point_not_found")
		return nil, "", false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return nil, "", false
	}
	role, err = s.store.MemberRole(r.Context(), apc.AccountID, c.Sub)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "access_point_not_found")
		return nil, "", false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return nil, "", false
	}
	return apc, role, true
}

// GET /v1/access-points/{id}
func (s *Server) handleAccessPointGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	apc, _, ok := s.accessPointScope(w, r, id)
	if !ok {
		return
	}
	d, err := s.store.AccessPointDetailByID(r.Context(), apc.AccountID, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, accessPointJSON(*d))
}

type createAccessPointReq struct {
	LocationID string   `json:"location_id"`
	Name       string   `json:"name"`
	Kind       string   `json:"kind"`
	DeviceID   *string  `json:"device_id"`
	Lat        *float64 `json:"lat"`
	Long       *float64 `json:"long"`
}

// POST /v1/access-points — admin of the account owning the location (the
// access_points WITH CHECK policy, pre-checked for a clean 403/404).
func (s *Server) handleAccessPointCreate(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	var req createAccessPointReq
	if !readJSON(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.LocationID == "" || req.Name == "" || len(req.Name) > 120 || !apKinds[req.Kind] {
		writeErr(w, http.StatusBadRequest, "invalid_access_point")
		return
	}
	accountID, role, ok := s.locationScope(w, r, req.LocationID)
	if !ok {
		return
	}
	if !isAdminRole(role) {
		writeErr(w, http.StatusForbidden, "not_account_admin")
		return
	}
	deviceID := ""
	if req.DeviceID != nil {
		deviceID = *req.DeviceID
	}
	d, err := s.store.CreateAccessPointFull(r.Context(), accountID, req.LocationID, req.Name, req.Kind, deviceID, req.Lat, req.Long)
	switch {
	case errors.Is(err, store.ErrDeviceNotAtLocation):
		writeErr(w, http.StatusBadRequest, "device_not_at_location")
		return
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "location_not_found")
		return
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	// Durable trail for access-point creation, including which controller
	// (if any) it was bound to — the finding's "pair a rogue controller...
	// and leave no queryable trace" gap applies just as much to binding an
	// already-paired device to a NEW access point as it does to the pairing
	// itself.
	if err := s.store.WriteAdminAudit(r.Context(), c.Sub, "access_point_create", "access_point", d.ID, true,
		map[string]any{"account_id": accountID, "location_id": req.LocationID, "name": req.Name,
			"kind": req.Kind, "device_id": nilIfEmpty(deviceID)}); err != nil {
		s.log.Error("access point create audit write failed", "access_point_id", d.ID, "err", err)
	}
	writeJSON(w, http.StatusCreated, accessPointJSON(*d))
}

// ---------------------------------------------------------------------------
// null helpers shared by the /v1 shapes
// ---------------------------------------------------------------------------

func nullInt64(v sql.NullInt64) any {
	if !v.Valid {
		return nil
	}
	return v.Int64
}

func nullFloat64(v sql.NullFloat64) any {
	if !v.Valid {
		return nil
	}
	return v.Float64
}
