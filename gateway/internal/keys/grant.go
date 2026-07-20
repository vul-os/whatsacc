package keys

import "time"

// DefaultGrantTTL is proto/grants.md's default offline-grant TTL — 7 days.
// This is the ONLY sub-lockdown bound on the "revoked member keeps
// everything the grant authorizes" exposure window described there ("What
// bounds the exposure"): a grant, once issued, is self-contained and
// offline-verifiable, so there is no live channel to shorten its life after
// the fact. SignGrant clamps to this — the issuance path never lets a
// caller request a longer-lived grant than the contract specifies.
const DefaultGrantTTL = 7 * 24 * time.Hour

// GrantWindow is a weekly access window (proto/grants.md): days is an
// inclusive mon..sun range in week order, no wrap-around; from/to are
// "HH:MM", to exclusive, "24:00" = end of day. Field-for-field identical to
// controller/internal/grants.Window — kept as an independent copy on
// purpose: the gateway and controller are separate Go modules with no
// shared dependency (see proto/ as the single source of truth both sides
// implement against).
type GrantWindow struct {
	Days string `json:"days"`
	From string `json:"from"`
	To   string `json:"to"`
}

// Grant is the gateway-signed offline-redeemable grant object
// (proto/grants.md `typ:"grant"`). sig is
// base64url(ed25519(gateway_key, JCS(grant minus sig))) — the identical
// signing discipline Envelope uses (same Canonicalize, same Sign).
type Grant struct {
	V            int           `json:"v"`
	Typ          string        `json:"typ"` // "grant"
	GrantID      string        `json:"grant_id"`
	Member       string        `json:"member"`
	AppPubkey    string        `json:"app_pubkey"`
	Devices      []string      `json:"devices"`
	AccessPoints []string      `json:"access_points"`
	Windows      []GrantWindow `json:"windows"`
	IAT          int64         `json:"iat"`
	EXP          int64         `json:"exp"`
	Sig          string        `json:"sig,omitempty"`
}

// signable renders the grant minus sig as the JCS map the signature covers,
// per proto/grants.md's field list (v, typ, grant_id, member, app_pubkey,
// devices, access_points, windows, iat, exp) — verified byte-for-byte
// against proto/vectors/grants.json's "canonical" strings by
// keys/vectors_test.go.
func (g *Grant) signable() map[string]any {
	devices := make([]any, len(g.Devices))
	for i, d := range g.Devices {
		devices[i] = d
	}
	aps := make([]any, len(g.AccessPoints))
	for i, a := range g.AccessPoints {
		aps[i] = a
	}
	windows := make([]any, len(g.Windows))
	for i, w := range g.Windows {
		windows[i] = map[string]any{"days": w.Days, "from": w.From, "to": w.To}
	}
	return map[string]any{
		"v":             g.V,
		"typ":           g.Typ,
		"grant_id":      g.GrantID,
		"member":        g.Member,
		"app_pubkey":    g.AppPubkey,
		"devices":       devices,
		"access_points": aps,
		"windows":       windows,
		"iat":           g.IAT,
		"exp":           g.EXP,
	}
}

// SignGrant mints and signs an offline grant for member, binding the app's
// own keypair (appPubkey, base64url ed25519 — validated by the caller
// BEFORE this is reached; SignGrant trusts its inputs) to devices/
// accessPoints/windows. ttl is clamped to (0, DefaultGrantTTL] — callers
// that pass 0 or a longer TTL get the contract default, never more.
func (k *Keys) SignGrant(grantID, member, appPubkey string, devices, accessPoints []string, windows []GrantWindow, ttl time.Duration) (*Grant, error) {
	if ttl <= 0 || ttl > DefaultGrantTTL {
		ttl = DefaultGrantTTL
	}
	now := time.Now().Unix()
	g := &Grant{
		V: 0, Typ: "grant", GrantID: grantID, Member: member,
		AppPubkey: appPubkey, Devices: devices, AccessPoints: accessPoints,
		Windows: windows, IAT: now, EXP: now + int64(ttl/time.Second),
	}
	msg, err := Canonicalize(g.signable())
	if err != nil {
		return nil, err
	}
	g.Sig = k.Sign(msg)
	return g, nil
}
