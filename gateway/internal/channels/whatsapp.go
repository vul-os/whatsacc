package channels

// WhatsApp (Meta Cloud API) — the primary channel and the full conversational
// contract from backend/src/routes/whatsapp.ts: interactive list picker for
// multiple access points, location select, welcome / linked-locations,
// unlinked signup prompt, visitor grants, honest denial replies, message-id
// dedupe and phone_number_id filtering. This file owns the provider-specific
// parts (verify, wire parse, reply rendering); the httpapi handler drives the
// flow through the shared open-path choke point.

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/vul-os/whatsacc/gateway/internal/store"
)

// WhatsApp is the channel value (holds only what Verify needs; the rest is
// pure functions/rendering).
type WhatsApp struct {
	AppSecret   string
	VerifyToken string
	PublicURL   string
}

func (WhatsApp) Kind() string { return KindWhatsApp }

func (c WhatsApp) Verify(headers http.Header, body []byte, now int64) VerifyResult {
	return verifyWhatsAppSig(c.AppSecret, headers, body)
}

// VerifyChallenge answers Meta's GET handshake (hub.mode=subscribe): returns
// the challenge to echo + ok, else ok=false → 403. The verify token is
// plaintext and DISTINCT from the app secret used to HMAC POSTs.
func (c WhatsApp) VerifyChallenge(mode, token, challenge string) (string, bool) {
	if mode == "subscribe" && token != "" && c.VerifyToken != "" && constEq(token, c.VerifyToken) {
		return challenge, true
	}
	return "", false
}

// ---------------------------------------------------------------------------
// Inbound wire (backend WhatsAppPayload)
// ---------------------------------------------------------------------------

type WAPayload struct {
	Object string    `json:"object"`
	Entry  []WAEntry `json:"entry"`
}

type WAEntry struct {
	ID      string     `json:"id"`
	Changes []WAChange `json:"changes"`
}

type WAChange struct {
	Field string  `json:"field"`
	Value WAValue `json:"value"`
}

type WAValue struct {
	MessagingProduct string `json:"messaging_product"`
	Metadata         struct {
		DisplayPhoneNumber string `json:"display_phone_number"`
		PhoneNumberID      string `json:"phone_number_id"`
	} `json:"metadata"`
	Contacts []struct {
		WaID    string `json:"wa_id"`
		Profile struct {
			Name string `json:"name"`
		} `json:"profile"`
	} `json:"contacts"`
	Messages []WAMessage `json:"messages"`
	Statuses []struct {
		ID string `json:"id"`
	} `json:"statuses"`
}

type WAMessage struct {
	ID          string         `json:"id"`
	From        string         `json:"from"`
	Timestamp   string         `json:"timestamp"`
	Type        string         `json:"type"`
	Text        *WATextBody    `json:"text"`
	Interactive *WAInteractive `json:"interactive"`
}

type WATextBody struct {
	Body string `json:"body"`
}

type WAInteractive struct {
	Type        string       `json:"type"` // list_reply | button_reply
	ListReply   *WAReplyItem `json:"list_reply"`
	ButtonReply *WAReplyItem `json:"button_reply"`
}

type WAReplyItem struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

// SelectedReply returns the tapped list/button item (or nil).
func (m *WAMessage) SelectedReply() *WAReplyItem {
	if m.Interactive == nil {
		return nil
	}
	if m.Interactive.ListReply != nil {
		return m.Interactive.ListReply
	}
	return m.Interactive.ButtonReply
}

// ---------------------------------------------------------------------------
// Outbound reply model (a WhatsApp reply is text OR interactive)
// ---------------------------------------------------------------------------

// WAReply is one queued reply; exactly one field is set.
type WAReply struct {
	Text        string
	Interactive *WhatsAppInteractive
}

func waInteractiveReply(i WhatsAppInteractive) WAReply { return WAReply{Interactive: &i} }

// waTitle truncates to WhatsApp's row/button title limits (default 24), adding
// an ellipsis. Backend waTitle().
func waTitle(v string, max int) string {
	if max <= 0 {
		max = 24
	}
	clean := strings.TrimSpace(v)
	r := []rune(clean)
	if len(r) <= max {
		return clean
	}
	cut := max - 1
	if cut < 1 {
		cut = 1
	}
	return strings.TrimRight(string(r[:cut]), " ") + "…"
}

// SignupLinkForPhone builds the signup deep-link the unlinked nudge sends.
func SignupLinkForPhone(publicURL, phoneE164 string) string {
	base := trimURL(publicURL)
	q := url.Values{"wa_phone": {phoneE164}}
	return base + "/signup?" + q.Encode()
}

func gateFooter(g store.AvailableAP) (string, bool) {
	if g.Type != store.APVisitor {
		return "", false
	}
	remaining := "unlimited"
	if g.MaxUses.Valid {
		rem := g.MaxUses.Int64 - g.UsesCount
		if rem < 0 {
			rem = 0
		}
		remaining = itoa(rem)
	}
	return "You have " + remaining + " uses remaining.", true
}

// PushGateMenu renders the gate picker for one location (button when a single
// gate, list otherwise) — backend pushGateMenu.
func PushGateMenu(locationName string, gates []store.AvailableAP) WAReply {
	if len(gates) == 1 {
		g := gates[0]
		i := WhatsAppInteractive{
			Type: "button",
			Body: WAText{Text: `Welcome to ` + locationName + `. Message "open" any time, or tap below to open ` + g.APName + `.`},
			Action: WhatsAppAction{
				Buttons: []WhatsAppButton{{
					Type:  "reply",
					Reply: WhatsAppButtonReply{ID: "open_ap:" + g.APID, Title: waTitle("Open "+g.APName, 20)},
				}},
			},
		}
		if f, ok := gateFooter(g); ok {
			i.Footer = &WAText{Text: f}
		}
		return waInteractiveReply(i)
	}
	rows := make([]WhatsAppRow, 0, 10)
	for _, g := range gates {
		if len(rows) == 10 {
			break
		}
		rows = append(rows, WhatsAppRow{
			ID:          "open_ap:" + g.APID,
			Title:       waTitle(g.APName, 24),
			Description: waTitle(g.LocName, 72),
		})
	}
	i := WhatsAppInteractive{
		Type:   "list",
		Header: &WAText{Type: "text", Text: locationName},
		Body:   WAText{Text: "Welcome to " + locationName + ". Which gate would you like to open?"},
		Action: WhatsAppAction{Button: "Select gate", Sections: []WhatsAppSection{{Title: "Available gates", Rows: rows}}},
	}
	if len(gates) > 0 {
		if f, ok := gateFooter(gates[0]); ok {
			i.Footer = &WAText{Text: f}
		}
	}
	return waInteractiveReply(i)
}

// PushLocationMenu renders the "which location" list — backend pushLocationMenu.
func PushLocationMenu(locations []store.LinkedLocation) WAReply {
	rows := make([]WhatsAppRow, 0, 10)
	for _, l := range locations {
		if len(rows) == 10 {
			break
		}
		rows = append(rows, WhatsAppRow{ID: "select_loc:" + l.ID, Title: waTitle(l.Name, 24)})
	}
	return waInteractiveReply(WhatsAppInteractive{
		Type:   "list",
		Header: &WAText{Type: "text", Text: "Locations"},
		Body:   WAText{Text: "Welcome back. Which location do you want to use?"},
		Action: WhatsAppAction{Button: "Choose location", Sections: []WhatsAppSection{{Title: "Your locations", Rows: rows}}},
	})
}

// PushCloseButton renders the "Would you like to close X?" follow-up after a
// successful open — backend's post-open close button.
func PushCloseButton(accessPointID, gateName string) WAReply {
	return waInteractiveReply(WhatsAppInteractive{
		Type: "button",
		Body: WAText{Text: "Would you like to close " + gateName + "?"},
		Action: WhatsAppAction{Buttons: []WhatsAppButton{{
			Type:  "reply",
			Reply: WhatsAppButtonReply{ID: "close_ap:" + accessPointID, Title: waTitle("Close "+gateName, 20)},
		}}},
	})
}

// UniqueLocations collapses available APs to their distinct locations, order
// preserved — backend uniqueLocations.
func UniqueLocations(gates []store.AvailableAP) []store.LinkedLocation {
	seen := map[string]bool{}
	out := make([]store.LinkedLocation, 0, len(gates))
	for _, g := range gates {
		if seen[g.LocID] {
			continue
		}
		seen[g.LocID] = true
		out = append(out, store.LinkedLocation{ID: g.LocID, Name: g.LocName})
	}
	return out
}

// FindMentionedLocation / FindMentionedGate resolve a free-text mention ("open
// the side gate") to a target — backend findMentionedLocation/findMentionedGate.
func FindMentionedLocation(body string, locations []store.LinkedLocation) (store.LinkedLocation, bool) {
	for _, l := range locations {
		if textIncludesName(body, l.Name) {
			return l, true
		}
	}
	return store.LinkedLocation{}, false
}

func FindMentionedGate(body string, gates []store.AvailableAP) (store.AvailableAP, bool) {
	for _, g := range gates {
		if textIncludesName(body, g.APName) {
			return g, true
		}
	}
	return store.AvailableAP{}, false
}

// ParseSelection splits an interactive reply id "cmd:arg" (backend split(':')).
func ParseSelection(id string) (cmd, arg string) {
	if i := strings.IndexByte(id, ':'); i >= 0 {
		return id[:i], id[i+1:]
	}
	return "open", id
}
