package httpapi

// Telegram webhook — fail-closed secret-token check, inbound dedupe, and (this
// EXCEEDS the backend stub, which only logged + replied "success"/"failed") a
// REAL open channel: a linked user's "open" runs the shared verdict → sign →
// dispatch choke point, with an inline-keyboard picker when several gates are
// available. Callback taps re-enter the same open path.

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/vul-os/lintel/gateway/internal/channels"
)

var tgHelpWords = map[string]bool{
	"hi": true, "hello": true, "help": true, "menu": true, "start": true, "/start": true,
}

// POST /webhooks/telegram
func (s *Server) handleTelegramWebhook(w http.ResponseWriter, r *http.Request) {
	raw, ok := s.readWebhookBody(w, r)
	if !ok {
		return
	}
	if v := s.tg.Verify(r.Header, raw, time.Now().Unix()); !v.OK {
		writeErr(w, http.StatusForbidden, v.Reason)
		return
	}
	update, err := channels.ParseTGUpdate(raw)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json")
		return
	}
	ctx := r.Context()
	switch {
	case update.CallbackQuery != nil:
		s.processTGCallback(ctx, update.CallbackQuery)
	case update.Message != nil && update.Message.From != nil && !update.Message.From.IsBot:
		s.processTGMessage(ctx, update.Message)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) processTGMessage(ctx contextT, msg *channels.TGMessage) {
	externalKey := strconv.FormatInt(msg.Chat.ID, 10)
	userKey := strconv.FormatInt(msg.From.ID, 10)
	profileID, _ := s.store.ResolveChannelIdentity(ctx, channels.KindTelegram, userKey)
	displayName, _ := s.store.ChannelIdentityDisplayName(ctx, channels.KindTelegram, userKey)

	meta := map[string]any{"username": msg.Chat.Username, "first_name": msg.Chat.FirstName, "last_name": msg.Chat.LastName}
	chatID, err := s.store.UpsertChannelChat(ctx, channels.KindTelegram, externalKey, profileID, "", meta)
	if err != nil {
		s.log.Error("tg upsert chat", "err", err)
		return
	}
	kind := "text"
	if msg.Text == "" {
		kind = "system"
	}
	isNew, err := s.store.InsertInboundMessage(ctx, chatID, channels.KindTelegram, kind, msg, strconv.FormatInt(msg.MessageID, 10), msg.Date)
	if err != nil || !isNew {
		return
	}
	if s.store.NoteChatMessage(ctx, s.cfg.RateLimits, "tg:"+externalKey, time.Now().Unix()) {
		return // quiet
	}
	if msg.Text == "" {
		return
	}
	txt := channels.NormalizeText(msg.Text)

	if profileID == "" {
		s.tgSendText(ctx, msg.Chat.ID, chatID, strings.Join([]string{
			"This Telegram account isn't linked to a lintel member yet.",
			"Ask your admin to add Telegram id " + userKey + " in the dashboard, then send \"menu\".",
		}, "\n"))
		return
	}

	switch {
	case txt == "open" || txt == "gates":
		gates, err := s.store.AvailableAccessPointsByProfile(ctx, profileID)
		if err != nil {
			s.log.Error("tg available", "err", err)
			return
		}
		switch len(gates) {
		case 0:
			s.tgSendText(ctx, msg.Chat.ID, chatID, "You don't have any active gate access. Please contact the administrator.")
		case 1:
			s.tgAccessCommand(ctx, msg.Chat.ID, chatID, profileID, gates[0].APID, gates[0].APName)
		default:
			s.tgSendKeyboard(ctx, msg.Chat.ID, chatID, "Which gate would you like to open?", channels.TelegramGateKeyboard(gates))
		}
	case tgHelpWords[txt]:
		s.tgSendText(ctx, msg.Chat.ID, chatID, channels.TelegramMenu(displayName))
	default:
		s.tgSendText(ctx, msg.Chat.ID, chatID, channels.TelegramMenu(displayName))
	}
}

func (s *Server) processTGCallback(ctx contextT, cq *channels.TGCallbackQuery) {
	// Always dismiss the button spinner, even on a no-op.
	s.tgSend.AnswerCallback(ctx, cq.ID)
	cmd, apID := channels.ParseSelection(cq.Data)
	if cmd != "open_ap" || apID == "" {
		return
	}
	userKey := strconv.FormatInt(cq.From.ID, 10)
	profileID, err := s.store.ResolveChannelIdentity(ctx, channels.KindTelegram, userKey)
	if err != nil {
		return // unlinked: no actuation
	}
	var chatNum int64
	if cq.Message != nil {
		chatNum = cq.Message.Chat.ID
	} else {
		chatNum = cq.From.ID
	}
	chatID, _ := s.store.UpsertChannelChat(ctx, channels.KindTelegram, strconv.FormatInt(chatNum, 10), profileID, "", nil)

	gateName := ""
	if gates, err := s.store.AvailableAccessPointsByProfile(ctx, profileID); err == nil {
		for _, g := range gates {
			if g.APID == apID {
				gateName = g.APName
			}
		}
	}
	s.tgAccessCommand(ctx, chatNum, chatID, profileID, apID, gateName)
}

// tgAccessCommand runs one open through the shared choke point and replies.
func (s *Server) tgAccessCommand(ctx contextT, chatNum int64, chatID, profileID, apID, gateName string) {
	had, v, err := s.profileOpen(ctx, profileID, apID, "open", channels.KindTelegram)
	if err != nil {
		s.log.Error("tg open", "err", err)
		return
	}
	if !had {
		s.tgSendText(ctx, chatNum, chatID, "Sorry, you no longer have access to this gate.")
		return
	}
	if !v.Allowed {
		s.tgSendText(ctx, chatNum, chatID, channels.DenialMessage(v.Reason, v.RetryAfterS, s.channelPublicURL()))
		return
	}
	if gateName == "" {
		gateName = "the gate"
	}
	s.tgSendText(ctx, chatNum, chatID, "Opening "+gateName+"...")
}

func (s *Server) tgSendText(ctx contextT, chatNum int64, chatID, body string) {
	sent := s.tgSend.SendText(ctx, chatNum, body)
	s.tgLog(ctx, chatID, "text", map[string]any{"text": body}, sent)
}

func (s *Server) tgSendKeyboard(ctx contextT, chatNum int64, chatID, body string, kb channels.InlineKeyboard) {
	sent := s.tgSend.SendInlineKeyboard(ctx, chatNum, body, kb)
	s.tgLog(ctx, chatID, "interactive", map[string]any{"text": body}, sent)
}

func (s *Server) tgLog(ctx contextT, chatID, kind string, body any, sent channels.SendResult) {
	status := "sent"
	if !sent.OK {
		status = "failed:" + sent.Error
	}
	if err := s.store.InsertOutboundMessage(ctx, chatID, channels.KindTelegram, kind, body, sent.ProviderMessageID, status); err != nil {
		s.log.Error("tg log outbound", "err", err)
	}
}
