package httpapi

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/vul-os/lintel/gateway/internal/hub"
	"github.com/vul-os/lintel/gateway/internal/store"
)

// Devices + pairing + controller transport, porting backend
// src/routes/devices.ts and proto/pairing.md.
//
// WebSocket library: github.com/coder/websocket (the maintained successor of
// nhooyr.io/websocket) — context-native API, zero transitive dependencies,
// and a net/http-integrated Accept that fits the std-lib router; gorilla
// carries a callback-era API and needed no features we lack here.

const (
	claimDefaultTTL = time.Hour
	claimMinTTL     = 60 * time.Second
	claimMaxTTL     = 7 * 24 * time.Hour // pairing.md rule 1: TTL ≤ 7 d
	pollInterval    = 30
)

// GET /v1/devices[?location_id=&account_id=]
func (s *Server) handleDevicesList(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	locationID := r.URL.Query().Get("location_id")
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
		devices, err := s.store.DevicesByAccountDetailed(r.Context(), aid, locationID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		for _, d := range devices {
			list = append(list, map[string]any{
				"id":               d.ID,
				"location_id":      d.LocationID,
				"label":            nilIfEmpty(d.Label),
				"status":           d.Status,
				"paired_at":        nullInt64(d.PairedAt),
				"last_seen_at":     nullInt64(d.LastSeenAt),
				"claim_expires_at": nullInt64(d.ClaimExpiresAt),
				"created_at":       d.CreatedAt,
				"connected":        s.hub.Connected(d.ID),
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": list})
}

type createDeviceReq struct {
	LocationID      string `json:"location_id"`
	Label           string `json:"label"`
	ClaimTTLSeconds *int64 `json:"claim_ttl_seconds"`
}

// POST /v1/devices — admin creates an unpaired device + one-shot claim
// token. The ONLY time the plaintext token exists outside the admin's hands;
// storage keeps the hash.
func (s *Server) handleDeviceCreate(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	var req createDeviceReq
	if !readJSON(w, r, &req) {
		return
	}
	if req.LocationID == "" || len(req.Label) > 120 {
		writeErr(w, http.StatusBadRequest, "invalid_device")
		return
	}
	ttl := claimDefaultTTL
	if req.ClaimTTLSeconds != nil {
		d := time.Duration(*req.ClaimTTLSeconds) * time.Second
		if d < claimMinTTL || d > claimMaxTTL {
			writeErr(w, http.StatusBadRequest, "invalid_claim_ttl")
			return
		}
		ttl = d
	}
	accountID, role, ok := s.locationScope(w, r, req.LocationID)
	if !ok {
		return
	}
	if !isAdminRole(role) {
		writeErr(w, http.StatusForbidden, "not_account_admin")
		return
	}
	claimToken := randomToken()
	expires := time.Now().Add(ttl).Unix()
	d, err := s.store.CreateDeviceWithClaim(r.Context(), accountID, req.LocationID, req.Label, hashToken(claimToken), expires)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	// Durable trail for device/claim issuance (security assessment finding:
	// this previously left only a transient slog line — an attacker with
	// an admin session pairing a rogue controller left no queryable trace).
	// Best-effort per WriteAdminAudit's own contract: never blocks the
	// create. The claim token itself is NEVER written to the audit log —
	// only its existence and metadata.
	if err := s.store.WriteAdminAudit(r.Context(), c.Sub, "device_claim_create", "device", d.ID, true,
		map[string]any{"location_id": req.LocationID, "account_id": accountID, "claim_expires_at": expires}); err != nil {
		s.log.Error("device create audit write failed", "device_id", d.ID, "err", err)
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":               d.ID,
		"location_id":      d.LocationID,
		"label":            nilIfEmpty(d.Label),
		"status":           d.Status,
		"claim_token":      claimToken,
		"claim_expires_at": expires,
		"created_by":       c.Sub,
	})
}

// ---------------------------------------------------------------------------
// Pairing redeem (proto/pairing.md)
// ---------------------------------------------------------------------------

type pairRedeemReq struct {
	V                int            `json:"v"`
	Typ              string         `json:"typ"`
	ClaimToken       string         `json:"claim_token"`
	ControllerPubkey string         `json:"controller_pubkey"`
	HW               map[string]any `json:"hw"`
}

// POST /api/pair/redeem — unauthenticated by design: authenticity is TLS +
// possession of the single-use claim token (pairing.md). Burns the token,
// enrolls the controller key, and answers with the pair.grant shape — the
// ONLY moment the gateway public key is accepted for pinning.
func (s *Server) handlePairRedeem(w http.ResponseWriter, r *http.Request) {
	var req pairRedeemReq
	if !readJSON(w, r, &req) {
		return
	}
	if req.Typ != "pair.redeem" || req.V != 0 || req.ClaimToken == "" {
		writeErr(w, http.StatusBadRequest, "invalid_redeem")
		return
	}
	if _, ok := hub.DecodePubkey(req.ControllerPubkey); !ok {
		writeErr(w, http.StatusBadRequest, "invalid_controller_pubkey")
		return
	}
	d, err := s.store.RedeemClaim(r.Context(), hashToken(req.ClaimToken), req.ControllerPubkey)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "device_not_found")
		return
	case errors.Is(err, store.ErrDeviceAlreadyPaired):
		writeErr(w, http.StatusBadRequest, "device_already_paired")
		return
	case errors.Is(err, store.ErrClaimExpired):
		writeErr(w, http.StatusBadRequest, "claim_expired")
		return
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	s.log.Info("device paired", "device", d.ID, "location", d.LocationID)
	// Durable trail for a successful pairing redemption (security
	// assessment finding: previously only a transient slog line — a
	// rogue controller enrolling a key left no queryable, durable record).
	// This route is unauthenticated by design (proto/pairing.md:
	// authenticity is possession of the single-use claim token, not a
	// user session), so there is no actor user id — actor_user_id is left
	// empty on purpose, and detail carries what actually happened:
	// which device, and the controller's own self-reported hw info (never
	// the claim token itself, burned before this point anyway).
	if err := s.store.WriteAdminAudit(r.Context(), "", "device_pair_redeem", "device", d.ID, true,
		map[string]any{"location_id": d.LocationID, "controller_pubkey": req.ControllerPubkey, "hw": req.HW}); err != nil {
		s.log.Error("pair redeem audit write failed", "device_id", d.ID, "err", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"v":              0,
		"typ":            "pair.grant",
		"device_id":      d.ID,
		"gateway_pubkey": s.keys.PublicKeyB64(),
		"ws_url":         s.wsURL(r),
		"poll_interval":  pollInterval,
	})
}

// wsURL derives the controller WebSocket endpoint from the configured public
// URL (falling back to the request host).
func (s *Server) wsURL(r *http.Request) string {
	base := strings.TrimSuffix(s.cfg.PublicURL, "/")
	switch {
	case strings.HasPrefix(base, "https://"):
		base = "wss://" + strings.TrimPrefix(base, "https://")
	case strings.HasPrefix(base, "http://"):
		base = "ws://" + strings.TrimPrefix(base, "http://")
	case base == "":
		scheme := "wss"
		if r.TLS == nil {
			scheme = "ws"
		}
		base = scheme + "://" + r.Host
	}
	return base + "/api/controller/ws"
}

// ---------------------------------------------------------------------------
// Controller WebSocket (pairing.md rule 5 + ws.challenge/ws.auth)
// ---------------------------------------------------------------------------

// GET /api/controller/ws
func (s *Server) handleControllerWS(w http.ResponseWriter, r *http.Request) {
	// Controllers are not browsers; Origin-based CSRF does not apply, and
	// authentication is the signed challenge below. Hence InsecureSkipVerify.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusInternalError, "closed")

	ctx := r.Context()
	nowUnix := time.Now().Unix()
	ch, err := hub.NewChallenge(nowUnix)
	if err != nil {
		conn.Close(websocket.StatusInternalError, "internal")
		return
	}
	if err := writeWS(ctx, conn, ch.Wire()); err != nil {
		return
	}

	authCtx, cancel := context.WithTimeout(ctx, time.Duration(hub.ChallengeTTL)*time.Second)
	_, raw, err := conn.Read(authCtx)
	cancel()
	if err != nil {
		conn.Close(websocket.StatusPolicyViolation, "auth_timeout")
		return
	}
	var auth hub.Auth
	if err := jsonUnmarshal(raw, &auth); err != nil || auth.DeviceID == "" {
		conn.Close(websocket.StatusPolicyViolation, "badsig")
		return
	}
	pkB64, err := s.store.DevicePublicKey(ctx, auth.DeviceID)
	if err != nil {
		// Unknown/unpaired device: report the pairing.md reason without
		// confirming device existence beyond it.
		conn.Close(websocket.StatusPolicyViolation, "badsig")
		return
	}
	pub, ok := hub.DecodePubkey(pkB64)
	if !ok {
		conn.Close(websocket.StatusPolicyViolation, "badsig")
		return
	}
	if reason := hub.VerifyAuth(pub, raw, auth.DeviceID, ch, false, time.Now().Unix()); reason != "" {
		conn.Close(websocket.StatusPolicyViolation, reason)
		return
	}

	deviceID := auth.DeviceID
	_ = s.store.TouchDeviceSeen(ctx, deviceID)
	send, done, unregister := s.hub.Register(deviceID)
	defer unregister()
	s.log.Info("controller connected", "device", deviceID)

	// Writer: hub → socket.
	writeErrCh := make(chan error, 1)
	go func() {
		for {
			select {
			case payload, okc := <-send:
				if !okc {
					return
				}
				if err := conn.Write(ctx, websocket.MessageText, payload); err != nil {
					writeErrCh <- err
					return
				}
			case <-done:
				conn.Close(websocket.StatusGoingAway, "displaced")
				return
			case <-ctx.Done():
				return
			}
		}
	}()

	// Reader: acks + events.
	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			return
		}
		select {
		case <-writeErrCh:
			return
		default:
		}
		s.handleControllerUplink(ctx, deviceID, pub, msg)
	}
}

// handleControllerUplink verifies and routes one signed controller message
// (cmd.ack / event). Invalid signatures are dropped fail-closed.
func (s *Server) handleControllerUplink(ctx context.Context, deviceID string, pub ed25519.PublicKey, msg []byte) {
	var head struct {
		Typ string `json:"typ"`
	}
	if err := jsonUnmarshal(msg, &head); err != nil {
		return
	}
	if reason := hub.VerifyFromController(pub, msg, deviceID); reason != "" {
		s.log.Warn("controller uplink rejected", "device", deviceID, "typ", head.Typ, "reason", reason)
		return
	}
	_ = s.store.TouchDeviceSeen(ctx, deviceID)
	switch head.Typ {
	case "cmd.ack":
		var ack hub.Ack
		if err := jsonUnmarshal(msg, &ack); err != nil {
			return
		}
		if s.hub.ResolveAck(ack) {
			return
		}
		s.handleLateAck(ctx, deviceID, ack)
	case "event":
		s.log.Info("controller event", "device", deviceID)
	}
}

// handleLateAck is reached only after ResolveAck already reported no
// waiter for this ack's nonce — either it is late (the ack-wait deadline
// already passed) or it does not correspond to any dispatch this hub
// remembers. By the time this runs the ack has ALREADY been verified
// (VerifyFromController, above, in both callers) against the enrolled
// device key; hub.LateAckReconcile only decides whether it is still
// entitled to correct the record (matching nonce, matching device, within
// hub.LateAckWindow) — see proto/commands.md "The lost-ack case, specified
// honestly" for why this must not just be a log line.
func (s *Server) handleLateAck(ctx context.Context, deviceID string, ack hub.Ack) {
	logID, ok := s.hub.LateAckReconcile(ack, time.Now().Unix())
	if !ok {
		s.log.Info("late ack (no longer reconcilable)", "device", deviceID, "nonce", ack.Nonce, "result", ack.Result)
		return
	}
	newLogID, err := s.store.ReconcileLateAck(ctx, logID, ack.Result, ack.Detail, ack.TS)
	if err != nil {
		s.log.Error("late ack reconcile failed", "device", deviceID, "orig_log_id", logID, "nonce", ack.Nonce, "err", err)
		return
	}
	s.log.Info("late ack reconciled", "device", deviceID, "orig_log_id", logID, "reconcile_log_id", newLogID, "result", ack.Result)
}

// devicePub loads + decodes a device's enrolled key, fail-closed.
func (s *Server) devicePub(ctx context.Context, deviceID string) (ed25519.PublicKey, bool) {
	pkB64, err := s.store.DevicePublicKey(ctx, deviceID)
	if err != nil {
		return nil, false
	}
	return hub.DecodePubkey(pkB64)
}

// ---------------------------------------------------------------------------
// HTTPS long-poll fallback (pairing.md rule 5: fall back at poll_interval)
// ---------------------------------------------------------------------------

// POST /api/controller/challenge {device_id} → ws.challenge for the poll flow.
func (s *Server) handleControllerChallenge(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DeviceID string `json:"device_id"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if _, ok := s.devicePub(r.Context(), req.DeviceID); !ok {
		// One reject reason for unknown AND unpaired: no device enumeration.
		writeErr(w, http.StatusForbidden, "badsig")
		return
	}
	ch, err := s.hub.IssuePollChallenge(req.DeviceID, time.Now().Unix())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, ch.Wire())
}

// POST /api/controller/poll — the body is EXACTLY a ws.auth message; a valid
// one drains the device's queued commands. Single-use challenge, so each
// poll needs a fresh one.
func (s *Server) handleControllerPoll(w http.ResponseWriter, r *http.Request) {
	raw, ok := readRawJSON(w, r)
	if !ok {
		return
	}
	var auth hub.Auth
	if err := jsonUnmarshal(raw, &auth); err != nil || auth.DeviceID == "" || auth.Typ != "ws.auth" {
		writeErr(w, http.StatusForbidden, "badsig")
		return
	}
	pub, okp := s.devicePub(r.Context(), auth.DeviceID)
	if !okp {
		writeErr(w, http.StatusForbidden, "badsig")
		return
	}
	if reason := s.hub.ConsumePollChallenge(pub, raw, auth.DeviceID, time.Now().Unix()); reason != "" {
		writeErr(w, http.StatusForbidden, reason)
		return
	}
	_ = s.store.TouchDeviceSeen(r.Context(), auth.DeviceID)
	writeJSON(w, http.StatusOK, map[string]any{
		"commands":      s.hub.DrainQueue(auth.DeviceID),
		"poll_interval": pollInterval,
	})
}

// POST /api/controller/ack — signed cmd.ack over HTTPS (poll-fallback path).
func (s *Server) handleControllerAck(w http.ResponseWriter, r *http.Request) {
	raw, ok := readRawJSON(w, r)
	if !ok {
		return
	}
	var ack hub.Ack
	if err := jsonUnmarshal(raw, &ack); err != nil || ack.Typ != "cmd.ack" || ack.DeviceID == "" {
		writeErr(w, http.StatusForbidden, "badsig")
		return
	}
	pub, okp := s.devicePub(r.Context(), ack.DeviceID)
	if !okp {
		writeErr(w, http.StatusForbidden, "badsig")
		return
	}
	if reason := hub.VerifyFromController(pub, raw, ack.DeviceID); reason != "" {
		writeErr(w, http.StatusForbidden, reason)
		return
	}
	_ = s.store.TouchDeviceSeen(r.Context(), ack.DeviceID)
	if !s.hub.ResolveAck(ack) {
		s.handleLateAck(r.Context(), ack.DeviceID, ack)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

func writeWS(ctx context.Context, conn *websocket.Conn, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, raw)
}

func jsonUnmarshal(raw []byte, v any) error { return json.Unmarshal(raw, v) }

// readRawJSON slurps a small JSON body verbatim (signature verification
// needs the exact object, re-canonicalized — not a lossy struct round-trip).
func readRawJSON(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	raw, err := io.ReadAll(r.Body)
	if err != nil || len(raw) == 0 {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return nil, false
	}
	return raw, true
}
