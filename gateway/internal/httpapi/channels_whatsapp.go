package httpapi

// WhatsApp webhook — the full conversational contract from
// backend/src/routes/whatsapp.ts, ported onto the Go channel seam: GET verify
// challenge, POST with fail-closed HMAC, phone_number_id filtering, message-id
// dedupe, flood throttle (bot goes quiet, webhook still 200), interactive list
// picker for multiple access points, location select, welcome / linked
// locations, unlinked signup prompt, visitor grants, and honest denial
// replies. Opens run through the shared choke point (channels_open.go).

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/vul-os/lintel/gateway/internal/channels"
	"github.com/vul-os/lintel/gateway/internal/store"
)

// waPending is one rendered reply awaiting send (to = recipient wa id, no '+').
type waPending struct {
	to     string
	chatID string
	reply  channels.WAReply
}

// GET /webhooks/whatsapp — Meta's verification handshake.
func (s *Server) handleWhatsAppVerify(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if resp, ok := s.wa.VerifyChallenge(q.Get("hub.mode"), q.Get("hub.verify_token"), q.Get("hub.challenge")); ok {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(resp))
		return
	}
	writeErr(w, http.StatusForbidden, "verify_token_mismatch")
}

// POST /webhooks/whatsapp — the message pipeline.
func (s *Server) handleWhatsAppWebhook(w http.ResponseWriter, r *http.Request) {
	raw, ok := s.readWebhookBody(w, r)
	if !ok {
		return
	}
	if v := s.wa.Verify(r.Header, raw, time.Now().Unix()); !v.OK {
		writeErr(w, http.StatusForbidden, v.Reason)
		return
	}
	var payload channels.WAPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json")
		return
	}

	ctx := r.Context()
	ourPhoneID := s.cfg.Channels.WhatsAppPhoneNumberID
	var pending []waPending
	for _, entry := range payload.Entry {
		for _, change := range entry.Changes {
			val := change.Value
			// Meta delivers webhooks for every number on the WABA; drop changes
			// meant for a sibling project's bot.
			if ourPhoneID != "" && val.Metadata.PhoneNumberID != "" && val.Metadata.PhoneNumberID != ourPhoneID {
				continue
			}
			for i := range val.Messages {
				pending = append(pending, s.processWhatsAppMessage(ctx, &val.Messages[i])...)
			}
		}
	}

	// Send + persist outbound after processing (a slow Graph call must not hold
	// anything). The webhook always 200s.
	for _, p := range pending {
		s.sendWhatsAppReply(ctx, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) processWhatsAppMessage(ctx contextT, msg *channels.WAMessage) []waPending {
	from := "+" + msg.From
	chatID, err := s.store.UpsertChannelChat(ctx, channels.KindWhatsApp, from, "", from, nil)
	if err != nil {
		s.log.Error("wa upsert chat", "err", err)
		return nil
	}
	isNew, err := s.store.InsertInboundMessage(ctx, chatID, channels.KindWhatsApp, msg.Type, msg, msg.ID, parseUnix(msg.Timestamp))
	if err != nil {
		s.log.Error("wa log inbound", "err", err)
		return nil
	}
	if !isNew {
		return nil // redelivered webhook — already processed
	}
	// Flood throttle: past the per-minute cap the bot goes quiet (no reply) but
	// the webhook still 200s so Meta does not retry-amplify.
	if s.store.NoteChatMessage(ctx, s.cfg.RateLimits, "phone:"+from, time.Now().Unix()) {
		return nil
	}

	switch msg.Type {
	case "text":
		return s.waHandleText(ctx, msg, from, chatID)
	case "interactive":
		return s.waHandleInteractive(ctx, msg, from, chatID)
	}
	return nil
}

func (s *Server) waHandleText(ctx contextT, msg *channels.WAMessage, from, chatID string) []waPending {
	to := msg.From
	body := ""
	if msg.Text != nil {
		body = channels.NormalizeText(msg.Text.Body)
	}

	allGrants, err := s.store.AvailableAccessPointsByPhone(ctx, from, 0)
	if err != nil {
		s.log.Error("wa available", "err", err)
		return nil
	}
	var locations []store.LinkedLocation
	if len(allGrants) > 0 {
		locations = channels.UniqueLocations(allGrants)
	} else if locations, err = s.store.LinkedLocationsByPhone(ctx, from); err != nil {
		s.log.Error("wa linked locations", "err", err)
		return nil
	}

	if len(allGrants) == 0 {
		return s.waNoAccessReply(ctx, to, chatID, from, locations)
	}

	isClose := strings.Contains(body, "close")
	isOpen := strings.Contains(body, "open")
	isHelp := body == "hi" || body == "hello" || body == "help" || body == "menu"

	if (isOpen || isClose) && !isHelp {
		command := "open"
		if isClose {
			command = "close"
		}
		mentionedLoc, hasLoc := channels.FindMentionedLocation(body, locations)
		filtered := allGrants
		if hasLoc {
			filtered = filterByLocation(allGrants, mentionedLoc.ID)
		}
		target, hasTarget := channels.FindMentionedGate(body, filtered)
		if !hasTarget && hasLoc && len(filtered) == 1 {
			target, hasTarget = filtered[0], true
		} else if !hasTarget && len(locations) == 1 && len(allGrants) == 1 {
			target, hasTarget = allGrants[0], true
		}
		if hasTarget {
			return s.waAccessCommand(ctx, to, chatID, from, target.APID, target.APName, command)
		}
		if hasLoc {
			return one(to, chatID, channels.PushGateMenu(mentionedLoc.Name, filtered))
		}
		if len(locations) > 1 {
			return one(to, chatID, channels.PushLocationMenu(locations))
		}
		return one(to, chatID, channels.PushGateMenu(locations[0].Name, allGrants))
	}

	if isHelp {
		if len(locations) > 1 {
			return one(to, chatID, channels.PushLocationMenu(locations))
		}
		return one(to, chatID, channels.PushGateMenu(locations[0].Name, allGrants))
	}

	// Fallback: welcome menu.
	if len(locations) == 1 {
		return one(to, chatID, channels.PushGateMenu(locations[0].Name, allGrants))
	}
	return one(to, chatID, channels.PushLocationMenu(locations))
}

// waNoAccessReply mirrors the backend's honest copy when a number has no ready
// access points: disabled-account, unlinked-signup, no-location, or no-gates.
func (s *Server) waNoAccessReply(ctx contextT, to, chatID, from string, locations []store.LinkedLocation) []waPending {
	linked, active, err := s.store.PhoneLinkState(ctx, from)
	if err != nil {
		s.log.Error("wa link state", "err", err)
		return nil
	}
	base := trimURL(s.channelPublicURL())
	if linked && !active {
		return text(to, chatID, "This account is disabled — contact your admin.")
	}
	if !linked {
		return text(to, chatID, strings.Join([]string{
			"Hello! This WhatsApp number isn't linked to a lintel account yet.",
			"Create your account here: " + channels.SignupLinkForPhone(s.channelPublicURL(), from),
			"After signup, we'll ask if you want to connect this number.",
		}, "\n\n"))
	}
	if len(locations) == 0 {
		return text(to, chatID, strings.Join([]string{
			"Welcome to lintel. Your number is connected.",
			"You don't have a location set up yet. Open the dashboard to add Home, HQ, or your first site.",
			base + "/app",
		}, "\n\n"))
	}
	first := "lintel"
	second := fmt.Sprintf("I found %d locations, but none have active gates or doors ready yet.", len(locations))
	if len(locations) == 1 {
		first = locations[0].Name
		second = "No gates or doors are ready at this location yet."
	}
	return text(to, chatID, strings.Join([]string{
		"Welcome to " + first + ".",
		second,
		"Add an access point in the dashboard: " + base + "/app/access-points",
	}, "\n\n"))
}

func (s *Server) waHandleInteractive(ctx contextT, msg *channels.WAMessage, from, chatID string) []waPending {
	to := msg.From
	sel := msg.SelectedReply()
	if sel == nil {
		return nil
	}
	cmd, arg := channels.ParseSelection(sel.ID)
	if cmd == "select_loc" {
		allGrants, err := s.store.AvailableAccessPointsByPhone(ctx, from, 0)
		if err != nil {
			s.log.Error("wa available", "err", err)
			return nil
		}
		locGates := filterByLocation(allGrants, arg)
		if len(locGates) == 0 {
			return text(to, chatID, "That location has no active gates or doors ready yet.")
		}
		return one(to, chatID, channels.PushGateMenu(locGates[0].LocName, locGates))
	}
	command := "open"
	if strings.HasPrefix(cmd, "close") {
		command = "close"
	}
	apID := arg
	gateName := strings.TrimPrefix(strings.TrimPrefix(sel.Title, "Open "), "Close ")
	if allGrants, err := s.store.AvailableAccessPointsByPhone(ctx, from, 0); err == nil {
		for _, g := range allGrants {
			if g.APID == apID {
				gateName = g.APName
			}
		}
	}
	return s.waAccessCommand(ctx, to, chatID, from, apID, gateName, command)
}

// waAccessCommand runs one open/close through the shared choke point and
// renders the honest result — backend pushAccessCommandResult.
func (s *Server) waAccessCommand(ctx contextT, to, chatID, from, apID, gateName, command string) []waPending {
	had, v, err := s.phoneOpen(ctx, from, apID, command, channels.KindWhatsApp)
	if err != nil {
		s.log.Error("wa open", "err", err)
		return nil
	}
	if !had {
		return text(to, chatID, "Sorry, you no longer have access to this gate.")
	}
	if !v.Allowed {
		return text(to, chatID, channels.DenialMessage(v.Reason, v.RetryAfterS, s.channelPublicURL()))
	}
	verb := "Opening"
	if command == "close" {
		verb = "Closing"
	}
	out := text(to, chatID, verb+" "+gateName+"...")
	if command == "open" {
		out = append(out, waPending{to: to, chatID: chatID, reply: channels.PushCloseButton(apID, gateName)})
	}
	return out
}

// sendWhatsAppReply sends one reply via the Graph sender and logs the outbound row.
func (s *Server) sendWhatsAppReply(ctx contextT, p waPending) {
	var sent channels.SendResult
	var kind string
	var body any
	if p.reply.Interactive != nil {
		sent = s.waSend.SendInteractive(ctx, p.to, *p.reply.Interactive)
		kind, body = "interactive", p.reply.Interactive
	} else {
		sent = s.waSend.SendText(ctx, p.to, p.reply.Text)
		kind = "text"
		body = map[string]any{"text": map[string]any{"body": p.reply.Text}}
	}
	status := "sent"
	if !sent.OK {
		status = "failed:" + sent.Error
	}
	if err := s.store.InsertOutboundMessage(ctx, p.chatID, channels.KindWhatsApp, kind, body, sent.ProviderMessageID, status); err != nil {
		s.log.Error("wa log outbound", "err", err)
	}
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

func one(to, chatID string, r channels.WAReply) []waPending {
	return []waPending{{to: to, chatID: chatID, reply: r}}
}

func text(to, chatID, body string) []waPending {
	return one(to, chatID, channels.WAReply{Text: body})
}

func filterByLocation(gates []store.AvailableAP, locID string) []store.AvailableAP {
	out := make([]store.AvailableAP, 0, len(gates))
	for _, g := range gates {
		if g.LocID == locID {
			out = append(out, g)
		}
	}
	return out
}

func parseUnix(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}
