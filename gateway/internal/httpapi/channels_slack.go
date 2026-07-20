package httpapi

// Slack — Events API webhook (+ interactions) AND Socket Mode share this one
// code path: handleSlackSocketEnvelope feeds Socket Mode frames into the same
// processSlackEvent / processSlackInteraction the webhooks use. Port of
// backend/src/routes/slack.ts (hardened signature check, block_actions
// open_gate → verdict), with the open running through the shared choke point.

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/vul-os/lintel/gateway/internal/channels"
)

var slackHelpWords = map[string]bool{
	"hi": true, "hello": true, "hey": true, "help": true, "menu": true, "start": true,
}

// POST /webhooks/slack — Events API.
func (s *Server) handleSlackEvents(w http.ResponseWriter, r *http.Request) {
	raw, ok := s.readWebhookBody(w, r)
	if !ok {
		return
	}
	if v := s.slack.Verify(r.Header, raw, time.Now().Unix()); !v.OK {
		writeErr(w, http.StatusForbidden, v.Reason)
		return
	}
	env, err := channels.ParseSlackEnvelope(raw)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json")
		return
	}
	if env.Type == "url_verification" {
		writeJSON(w, http.StatusOK, map[string]any{"challenge": env.Challenge})
		return
	}
	if env.Type == "event_callback" && env.Event != nil {
		s.processSlackEvent(r.Context(), env.TeamID, env.Event)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// POST /webhooks/slack/interactions — button clicks (block_actions).
func (s *Server) handleSlackInteractions(w http.ResponseWriter, r *http.Request) {
	raw, ok := s.readWebhookBody(w, r)
	if !ok {
		return
	}
	// Authenticate BEFORE parsing anything attacker-controlled.
	if v := s.slack.Verify(r.Header, raw, time.Now().Unix()); !v.OK {
		writeErr(w, http.StatusForbidden, v.Reason)
		return
	}
	values, err := url.ParseQuery(string(raw))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json")
		return
	}
	payloadStr := values.Get("payload")
	if payloadStr == "" {
		writeErr(w, http.StatusBadRequest, "missing_payload")
		return
	}
	var inter channels.SlackInteraction
	if err := json.Unmarshal([]byte(payloadStr), &inter); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json")
		return
	}
	s.processSlackInteraction(r.Context(), &inter)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleSlackSocketEnvelope is the Socket Mode entry point (channels.SocketMode
// Handle): the SAME processing as the webhooks, so a LAN-only gateway with no
// public URL runs Slack fully over the outbound WebSocket.
func (s *Server) handleSlackSocketEnvelope(ctx contextT, envType string, payload json.RawMessage) {
	switch envType {
	case "events_api":
		env, err := channels.ParseSlackEnvelope(payload)
		if err != nil {
			return
		}
		if env.Type == "event_callback" && env.Event != nil {
			s.processSlackEvent(ctx, env.TeamID, env.Event)
		}
	case "interactive":
		var inter channels.SlackInteraction
		if err := json.Unmarshal(payload, &inter); err != nil {
			return
		}
		s.processSlackInteraction(ctx, &inter)
	}
}

func (s *Server) processSlackEvent(ctx contextT, teamID string, ev *channels.SlackEvent) {
	if ev.BotID != "" || (ev.Type != "message" && ev.Type != "app_mention") {
		return
	}
	channelID := ev.Channel
	profileID, _ := s.store.ResolveChannelIdentity(ctx, channels.KindSlack, ev.User) // "" if unlinked
	displayName, _ := s.store.ChannelIdentityDisplayName(ctx, channels.KindSlack, ev.User)

	meta := map[string]any{"team_id": teamID}
	chatID, err := s.store.UpsertChannelChat(ctx, channels.KindSlack, channelID, profileID, "", meta)
	if err != nil {
		s.log.Error("slack upsert chat", "err", err)
		return
	}
	kind := "text"
	if ev.Text == "" {
		kind = "system"
	}
	isNew, err := s.store.InsertInboundMessage(ctx, chatID, channels.KindSlack, kind, ev, ev.TS, parseSlackTS(ev.TS))
	if err != nil || !isNew {
		return
	}
	if s.store.NoteChatMessage(ctx, s.cfg.RateLimits, "slack:"+ev.User, time.Now().Unix()) {
		return // quiet
	}

	txt := channels.NormalizeSlackText(ev.Text)
	if txt == "" {
		return
	}
	switch {
	case slackHelpWords[txt]:
		s.slackReply(ctx, chatID, channelID, channels.SlackMenu(displayName), nil)
	case profileID == "":
		s.slackReply(ctx, chatID, channelID, strings.Join([]string{
			"I don't know which lintel profile this Slack user belongs to yet.",
			"Add Slack user ID " + ev.User + " in the web dashboard, then send \"menu\".",
		}, "\n"), nil)
	case txt == "open" || txt == "gates":
		gates, err := s.store.AvailableAccessPointsByProfile(ctx, profileID)
		if err != nil {
			s.log.Error("slack available", "err", err)
			return
		}
		if len(gates) == 0 {
			s.slackReply(ctx, chatID, channelID, "You don't have any active gate access. Please contact the administrator.", nil)
			return
		}
		s.slackReply(ctx, chatID, channelID, "Select a gate to open", channels.AccessBlocks(displayName, gates))
	default:
		s.slackReply(ctx, chatID, channelID, channels.SlackMenu(displayName), nil)
	}
}

func (s *Server) processSlackInteraction(ctx contextT, inter *channels.SlackInteraction) {
	if inter.Type != "block_actions" || len(inter.Actions) == 0 {
		return
	}
	act := inter.Actions[0]
	if !strings.HasPrefix(act.ActionID, "open_gate:") {
		return
	}
	apID := act.Value
	channelID := inter.Channel.ID
	profileID, err := s.store.ResolveChannelIdentity(ctx, channels.KindSlack, inter.User.ID)
	if err != nil {
		return // unlinked user: no actuation
	}
	chatID, _ := s.store.UpsertChannelChat(ctx, channels.KindSlack, channelID, profileID, "", nil)
	had, v, err := s.profileOpen(ctx, profileID, apID, "open", channels.KindSlack)
	if err != nil {
		s.log.Error("slack open", "err", err)
		return
	}
	if !had {
		s.slackReply(ctx, chatID, channelID, "❌ Sorry, you no longer have access to this gate.", nil)
		return
	}
	if !v.Allowed {
		s.slackReply(ctx, chatID, channelID, channels.DenialMessage(v.Reason, v.RetryAfterS, s.channelPublicURL()), nil)
		return
	}
	s.slackReply(ctx, chatID, channelID, "✅ Opening gate...", nil)
}

// slackReply sends a text or blocks reply and logs the outbound row.
func (s *Server) slackReply(ctx contextT, chatID, channelID, text string, blocks []channels.Block) {
	var sent channels.SendResult
	var kind string
	var body any
	if blocks != nil {
		sent = s.slackSend.SendBlocks(ctx, channelID, text, blocks)
		kind, body = "interactive", map[string]any{"blocks": blocks}
	} else {
		sent = s.slackSend.SendText(ctx, channelID, text)
		kind, body = "text", map[string]any{"text": text}
	}
	status := "sent"
	if !sent.OK {
		status = "failed:" + sent.Error
	}
	if err := s.store.InsertOutboundMessage(ctx, chatID, channels.KindSlack, kind, body, sent.ProviderMessageID, status); err != nil {
		s.log.Error("slack log outbound", "err", err)
	}
}

// parseSlackTS turns Slack's "1623456789.000200" ts into a unix second.
func parseSlackTS(ts string) int64 {
	if f, err := strconv.ParseFloat(ts, 64); err == nil {
		return int64(f)
	}
	return 0
}
