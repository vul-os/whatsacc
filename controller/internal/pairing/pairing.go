// Package pairing implements the controller side of proto/pairing.md: redeem
// a single-use claim token over HTTPS, receive {device_id, gateway_pubkey,
// ws_url, poll_interval}, and persist it with the gateway key PINNED. The
// redeem response is the ONLY moment a gateway key is accepted; thereafter
// only a `repair` command signed by the currently pinned key (or a physical
// factory reset) can change it — state.Store enforces that.
package pairing

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/vul-os/lintel/controller/internal/state"
)

// Redeem is the pair.redeem request body.
type Redeem struct {
	V             int    `json:"v"`
	Typ           string `json:"typ"` // "pair.redeem"
	ClaimToken    string `json:"claim_token"`
	ControllerPub string `json:"controller_pubkey"`
	HW            HW     `json:"hw"`
}

// HW describes this device.
type HW struct {
	Model  string   `json:"model"`
	FW     string   `json:"fw"`
	Ifaces []string `json:"ifaces"`
}

// Grant is the pair.grant response body.
type Grant struct {
	V             int    `json:"v"`
	Typ           string `json:"typ"` // "pair.grant"
	DeviceID      string `json:"device_id"`
	GatewayPubkey string `json:"gateway_pubkey"`
	WSURL         string `json:"ws_url"`
	PollInterval  int    `json:"poll_interval"`
}

// Client redeems claim tokens against a gateway.
type Client struct {
	HTTP *http.Client // nil = 15 s default
	// AllowInsecureWS permits ws:// in pair.grant (tests/dev only).
	AllowInsecureWS bool
}

// RedeemClaim POSTs {gateway}/pair/redeem and persists the result into st.
// If the controller is already paired to a DIFFERENT gateway key, the save
// is refused (state.ErrKeyChangeRefused) — a hostile or replaced gateway
// cannot rotate the pinned key through re-pairing.
func (c *Client) RedeemClaim(ctx context.Context, st *state.Store, gatewayURL, claimToken, controllerPubB64 string, hw HW) (*Grant, error) {
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 15 * time.Second}
	}
	base, err := url.Parse(gatewayURL)
	if err != nil {
		return nil, fmt.Errorf("pairing: bad gateway url: %w", err)
	}
	body, err := json.Marshal(&Redeem{
		V: 0, Typ: "pair.redeem",
		ClaimToken:    claimToken,
		ControllerPub: controllerPubB64,
		HW:            hw,
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		base.JoinPath("pair", "redeem").String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("pairing: redeem: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("pairing: redeem rejected: %s (%s)", resp.Status, strings.TrimSpace(string(raw)))
	}
	var g Grant
	if err := json.Unmarshal(raw, &g); err != nil {
		return nil, fmt.Errorf("pairing: malformed pair.grant: %w", err)
	}
	if g.Typ != "pair.grant" {
		return nil, fmt.Errorf("pairing: unexpected response typ %q", g.Typ)
	}
	if err := validateWSURL(g.WSURL, c.AllowInsecureWS); err != nil {
		return nil, err
	}
	if err := st.SavePairing(state.Pairing{
		DeviceID:      g.DeviceID,
		GatewayPubkey: g.GatewayPubkey,
		WSURL:         g.WSURL,
		PollInterval:  g.PollInterval,
	}); err != nil {
		return nil, err
	}
	return &g, nil
}

func validateWSURL(ws string, allowInsecure bool) error {
	u, err := url.Parse(ws)
	if err != nil {
		return fmt.Errorf("pairing: bad ws_url: %w", err)
	}
	if u.Scheme == "wss" || (allowInsecure && u.Scheme == "ws") {
		return nil
	}
	return fmt.Errorf("pairing: ws_url must be wss:// (got %q)", u.Scheme)
}
