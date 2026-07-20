package httpapi

// Offline-grant issuance (proto/grants.md): the gateway-side half of the
// contract. The controller side (verification, redemption, the fail-closed
// 11-step order) is real and conformance-tested; this file is what actually
// produces a `typ:"grant"` object, so the app can later prove itself
// directly to a controller — no gateway, no Meta, no signal — at redemption
// time.
//
// AUTHORIZATION MODEL (the crux — a minted grant is offline-redeemable and
// CANNOT be recalled before its exp): every requested access point is run
// through the exact same gates the online open path enforces before it will
// ever dispatch a command — accessPointScope's membership gate
// (access.go/open.go) plus LogAccess's account-suspended and user-disabled
// checks (openpath.go). An access point that would 404/403 on a live /open
// right now is refused here too, for the same reason and with the same
// status codes. Fail-closed and ALL-OR-NOTHING: if the caller is not
// currently entitled to every access point they asked for, nothing is
// issued — a grant silently narrowed to a subset the caller didn't notice
// would be worse than an honest error.
//
// EXPOSURE WINDOW: proto/grants.md's own "bounded-exposure tradeoff" — once
// minted, a grant authorizes its access_points for its full windows until
// exp, and there is no revocation channel (that's an explicit v0
// non-goal — a v1 wire change, not something this pass invents). The one
// lever this endpoint controls is keeping that window as small as the
// contract allows: TTL is the fixed proto default (7 days,
// keys.DefaultGrantTTL) and is NOT caller-extendable. Every issuance is
// also written to the admin audit trail (WriteAdminAudit) so an operator
// can see who holds what and decide whether a lockdown is warranted — the
// honest limit of what is possible without a revocation wire change.
//
// LOCKDOWN: the gateway has no live or cached view of any controller's
// lockdown latch — that state is deliberately controller-local (see
// proto/grants.md "that locality is the feature this whole path exists
// for"), and there is today no command path that would even let the
// gateway learn it (dispatch is open/close only). Issuance therefore
// cannot check it, and checking a stale snapshot at mint time would be
// worse than useless — a controller can enter lockdown seconds after
// issuance and the grant is still live regardless. What actually enforces
// lockdown against an offline grant is the controller's own check at
// REDEMPTION time (step 2 of controller/internal/grants.Exchange.
// HandleProof, unmodified, already conformance-tested against
// proto/vectors/grants.json) — the freshest possible signal, by design.
import (
	"errors"
	"net/http"
	"sort"

	"github.com/vul-os/lintel/gateway/internal/hub"
	"github.com/vul-os/lintel/gateway/internal/keys"
	"github.com/vul-os/lintel/gateway/internal/store"
)

// offlineGrantMaxAPs is a sanity cap on one request (not a security
// boundary — every entry is still individually authorized), mirroring
// grantCreateReq's AccessPointIDs bound in open.go.
const offlineGrantMaxAPs = 50

type offlineGrantReq struct {
	AppPubkey      string   `json:"app_pubkey"`
	AccessPointIDs []string `json:"access_point_ids"`
}

// POST /v1/offline-grants — mint a proto/grants.md offline-redeemable
// `typ:"grant"` for the caller, binding their app's own keypair to every
// access point they currently have live standing access to (see file
// header for the authorization model).
func (s *Server) handleOfflineGrantIssue(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	var req offlineGrantReq
	if !readJSON(w, r, &req) {
		return
	}
	if _, ok := hub.DecodePubkey(req.AppPubkey); !ok {
		writeErr(w, http.StatusBadRequest, "invalid_app_pubkey")
		return
	}
	if len(req.AccessPointIDs) < 1 || len(req.AccessPointIDs) > offlineGrantMaxAPs {
		writeErr(w, http.StatusBadRequest, "invalid_grant")
		return
	}
	seenAP := map[string]bool{}
	for _, id := range req.AccessPointIDs {
		if id == "" || seenAP[id] {
			writeErr(w, http.StatusBadRequest, "invalid_grant")
			return
		}
		seenAP[id] = true
	}

	// Caller's own account-independent standing (mirrors LogAccess's
	// user_disabled check — a disabled user gets nothing, at any access
	// point, exactly like a live /open would deny them).
	u, err := s.store.UserByID(r.Context(), c.Sub)
	if err != nil || u.Status != "active" {
		writeErr(w, http.StatusForbidden, "user_disabled")
		return
	}

	deviceSet := map[string]bool{}
	var devices, resolvedAPs []string
	for _, apID := range req.AccessPointIDs {
		apc, err := s.store.AccessPointContextByID(r.Context(), apID)
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "access_point_not_found")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		// Membership gate — identical to accessPointScope (access.go):
		// non-members, and members whose status has moved off 'active'
		// (an "expired"/removed membership — store.MemberRole scopes to
		// status = 'active'), get 404, never a 403 that would confirm the
		// access point exists.
		if _, err := s.store.MemberRole(r.Context(), apc.AccountID, c.Sub); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeErr(w, http.StatusNotFound, "access_point_not_found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		// Account-suspended gate — identical to LogAccess's "open" check:
		// suspension freezes every open regardless of channel; an offline
		// grant that outlived a suspension would be a much bigger hole than
		// a single denied live open, so it is refused at MINT time too.
		if apc.AccountStatus == "suspended" {
			writeErr(w, http.StatusForbidden, "account_suspended")
			return
		}
		// No controller attached: an offline grant for this access point
		// could never be redeemed by any controller (grants.Exchange checks
		// device_id ∈ grant.devices; there is no device to list), so it
		// would be dead weight silently widening the signed document for no
		// reason. Refuse explicitly rather than issue a grant that can
		// never open anything at this access point.
		if apc.DeviceID == "" {
			writeErr(w, http.StatusBadRequest, "access_point_has_no_device")
			return
		}
		resolvedAPs = append(resolvedAPs, apc.ID)
		if !deviceSet[apc.DeviceID] {
			deviceSet[apc.DeviceID] = true
			devices = append(devices, apc.DeviceID)
		}
	}
	sort.Strings(devices)
	sort.Strings(resolvedAPs)

	grantID := store.NewID()
	// v0 has no per-member schedule to draw from (the online open path
	// applies no time-of-day restriction to members either — see
	// gateway/internal/store/openpath.go), so the window is unrestricted:
	// exactly as much access, in time, as the live /open path already
	// grants. A narrower per-member schedule is a future feature, not a v0
	// regression from parity with the online path.
	windows := []keys.GrantWindow{{Days: "mon-sun", From: "00:00", To: "24:00"}}
	g, err := s.keys.SignGrant(grantID, c.Sub, req.AppPubkey, devices, resolvedAPs, windows, keys.DefaultGrantTTL)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	// Audit: "so an operator can see who holds what" — proto/grants.md has
	// no revocation channel, so this is the honest substitute: a platform
	// admin can see every issued grant's member/access_points/devices/exp
	// and decide whether a lockdown is warranted. Best-effort per
	// WriteAdminAudit's own contract — never blocks issuance.
	if err := s.store.WriteAdminAudit(r.Context(), c.Sub, "offline_grant_issue", "grant", grantID, true,
		map[string]any{
			"member":        c.Sub,
			"access_points": resolvedAPs,
			"devices":       devices,
			"iat":           g.IAT,
			"exp":           g.EXP,
		}); err != nil {
		s.log.Error("offline grant audit write failed", "grant_id", grantID, "err", err)
	}

	writeJSON(w, http.StatusCreated, g)
}
