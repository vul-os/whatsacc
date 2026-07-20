package channels

// Outbound transport for each channel: the wire payload types plus HTTP
// implementations (Meta Graph, Slack chat.postMessage, Telegram sendMessage).
// Each sender is an interface so the httpapi channel handlers can inject a
// recording fake in tests; the real impls no-op (returning ok:false, an
// "…_unset" error) when their credentials are unconfigured — exactly the
// backend's behaviour, so a half-configured install logs replies without
// crashing.
//
// WhatsApp is pluggable behind two engines (WhatsAppEngine below): the
// official Meta Cloud API (HTTPWhatsAppSender, DEFAULT) and an opt-in
// self-hosted bridge (BridgeWhatsAppSender, target: Evolution API). Both
// implement the same WhatsAppSender interface, so nothing above the sender
// (the httpapi handlers, the reply rendering) knows or cares which is in use.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// SendResult mirrors the backend SendTextResult.
type SendResult struct {
	OK                bool
	ProviderMessageID string
	Error             string
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

// WhatsAppInteractive is the Meta interactive message (list or button),
// matching backend lib/whatsapp.ts WhatsAppInteractive.
type WhatsAppInteractive struct {
	Type   string         `json:"type"` // "list" | "button"
	Header *WAText        `json:"header,omitempty"`
	Body   WAText         `json:"body"`
	Footer *WAText        `json:"footer,omitempty"`
	Action WhatsAppAction `json:"action"`
}

type WAText struct {
	Type string `json:"type,omitempty"` // header uses {type:"text"}
	Text string `json:"text"`
}

type WhatsAppAction struct {
	Button   string            `json:"button,omitempty"`
	Sections []WhatsAppSection `json:"sections,omitempty"`
	Buttons  []WhatsAppButton  `json:"buttons,omitempty"`
}

type WhatsAppSection struct {
	Title string        `json:"title,omitempty"`
	Rows  []WhatsAppRow `json:"rows"`
}

type WhatsAppRow struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}

type WhatsAppButton struct {
	Type  string              `json:"type"` // "reply"
	Reply WhatsAppButtonReply `json:"reply"`
}

type WhatsAppButtonReply struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// WhatsAppSender sends text + interactive replies via the Meta Graph API.
type WhatsAppSender interface {
	SendText(ctx context.Context, toE164NoPlus, body string) SendResult
	SendInteractive(ctx context.Context, toE164NoPlus string, interactive WhatsAppInteractive) SendResult
}

// HTTPWhatsAppSender is the real Graph implementation.
type HTTPWhatsAppSender struct {
	AccessToken   string
	PhoneNumberID string
	GraphVersion  string // default v21.0
	Client        *http.Client
}

func (s *HTTPWhatsAppSender) graphURL() string {
	v := s.GraphVersion
	if v == "" {
		v = "v21.0"
	}
	return fmt.Sprintf("https://graph.facebook.com/%s/%s/messages", v, s.PhoneNumberID)
}

func (s *HTTPWhatsAppSender) send(ctx context.Context, payload map[string]any) SendResult {
	if s.AccessToken == "" || s.PhoneNumberID == "" {
		return SendResult{Error: "whatsapp_credentials_unset"}
	}
	return postGraph(ctx, s.client(), s.graphURL(), "Bearer "+s.AccessToken, payload)
}

func (s *HTTPWhatsAppSender) client() *http.Client { return orDefaultClient(s.Client) }

func (s *HTTPWhatsAppSender) SendText(ctx context.Context, to, body string) SendResult {
	return s.send(ctx, map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                to,
		"type":              "text",
		"text":              map[string]any{"preview_url": false, "body": body},
	})
}

func (s *HTTPWhatsAppSender) SendInteractive(ctx context.Context, to string, interactive WhatsAppInteractive) SendResult {
	return s.send(ctx, map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                to,
		"type":              "interactive",
		"interactive":       interactive,
	})
}

// postGraph POSTs JSON and decodes the {messages:[{id}], error:{message}}
// envelope Meta/graph returns.
func postGraph(ctx context.Context, client *http.Client, url, auth string, payload map[string]any) SendResult {
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return SendResult{Error: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", auth)
	res, err := client.Do(req)
	if err != nil {
		return SendResult{Error: err.Error()}
	}
	defer res.Body.Close()
	var out struct {
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if res.StatusCode/100 != 2 {
		if out.Error.Message != "" {
			return SendResult{Error: out.Error.Message}
		}
		return SendResult{Error: fmt.Sprintf("http_%d", res.StatusCode)}
	}
	var id string
	if len(out.Messages) > 0 {
		id = out.Messages[0].ID
	}
	return SendResult{OK: true, ProviderMessageID: id}
}

// ---------------------------------------------------------------------------
// WhatsApp engine selection — cloud (default) vs an opt-in self-hosted bridge
// ---------------------------------------------------------------------------
//
// NON-NEGOTIABLE HONESTY REQUIREMENT (not marketing copy, a safety property):
// a self-hosted bridge (Evolution API / OpenWA / MultiWA — anything fronting
// Baileys, an unofficial reverse-engineered WhatsApp Web client) carries a
// real account-ban risk. Meta actively hardened automated-client detection
// through 2025 and tightened its terms further on 2026-01-15; reported number
// survival on unofficial APIs is commonly WEEKS, not years. A banned number is
// a gate that silently stops responding on WhatsApp. So:
//   - WhatsAppEngineCloud is the default and the ONLY implicit choice —
//     ResolveWhatsAppEngine fails closed toward it for anything but the exact
//     opt-in string.
//   - Selecting the bridge engine MUST log WhatsAppBanRiskWarning at startup
//     (wired in httpapi.Server.New) — never a quiet switch.
//   - The offline LAN/BLE grant path (the app's emergency-access flow) is the
//     REQUIRED fallback whenever the bridge engine is in use. This is
//     documented, not enforced in code (the gateway cannot verify an operator
//     actually configured the fallback) — see site/docs/linking-whatsapp.md /
//     site/docs/emergency-access.md, which need an explicit callout (not
//     added here — this repo's channel-layer owner does not touch site/docs).

// WhatsAppEngine selects which implementation sends outbound WhatsApp
// messages.
type WhatsAppEngine string

const (
	// WhatsAppEngineCloud is Meta's official Cloud API (Graph, HTTPWhatsAppSender).
	// DEFAULT — the only engine ResolveWhatsAppEngine picks implicitly.
	WhatsAppEngineCloud WhatsAppEngine = "cloud"
	// WhatsAppEngineBridge is a self-hosted, UNOFFICIAL WhatsApp Web client
	// bridge (target: Evolution API, which fronts both Baileys and the
	// official Cloud API behind one interface — BridgeWhatsAppSender). OPT-IN
	// ONLY: see the ban-risk block above.
	WhatsAppEngineBridge WhatsAppEngine = "bridge"
)

// ResolveWhatsAppEngine turns the raw LINTEL_WHATSAPP_ENGINE env value into a
// WhatsAppEngine. Fail-closed toward the safe default: unset, empty,
// misspelled, or any value other than the exact opt-in string "bridge"
// (case-insensitive, trimmed) resolves to WhatsAppEngineCloud. There is no
// auto-detect and no implicit bridge path — selecting the unofficial engine
// requires spelling it out correctly.
func ResolveWhatsAppEngine(raw string) WhatsAppEngine {
	if strings.EqualFold(strings.TrimSpace(raw), string(WhatsAppEngineBridge)) {
		return WhatsAppEngineBridge
	}
	return WhatsAppEngineCloud
}

// WhatsAppBanRiskWarning is the exact operator-facing warning logged at
// startup whenever the bridge engine is selected (httpapi.Server.New). Not
// softened: this is the honesty requirement the task that added this engine
// was explicit must not be diluted.
const WhatsAppBanRiskWarning = "LINTEL_WHATSAPP_ENGINE=bridge selected: this uses an UNOFFICIAL WhatsApp Web " +
	"client (Baileys-based, e.g. Evolution API), NOT Meta's Cloud API. Meta actively detects and bans " +
	"automated clients, and tightened its terms further on 2026-01-15; reported number survival on " +
	"unofficial APIs is commonly WEEKS, not years. A ban means this gate silently stops responding on " +
	"WhatsApp. The offline LAN/BLE grant path is REQUIRED as a fallback whenever this engine is in use — " +
	"do not rely on WhatsApp as the only way to open a gate."

// NewWhatsAppSender builds the configured WhatsAppSender. Each concrete
// sender fails closed on its own missing credentials (returns an "…_unset"
// SendResult, never sends unauthenticated) — exactly HTTPWhatsAppSender's
// existing behaviour, extended to the bridge sender, so a bridge engine
// selected without its own URL/key/instance configured degrades the same
// honest way a half-configured cloud install already does, rather than
// silently falling back to a different engine than the one named.
func NewWhatsAppSender(engine WhatsAppEngine, ch Config) WhatsAppSender {
	if engine == WhatsAppEngineBridge {
		return &BridgeWhatsAppSender{
			BaseURL:  ch.WhatsAppBridgeURL,
			APIKey:   ch.WhatsAppBridgeAPIKey,
			Instance: ch.WhatsAppBridgeInstance,
		}
	}
	return &HTTPWhatsAppSender{
		AccessToken:   ch.WhatsAppAccessToken,
		PhoneNumberID: ch.WhatsAppPhoneNumberID,
		GraphVersion:  ch.WhatsAppGraphVersion,
	}
}

// BridgeWhatsAppSender is the opt-in engine: an HTTP client against a
// Baileys-based bridge exposing an Evolution-API-shaped surface
// (POST /message/sendText/{instance}, an `apikey` header) — Evolution API is
// the target because it fronts both Baileys and the official Cloud API behind
// one interface, so it is the single integration that covers the ecosystem.
//
// HONESTY NOTE: this targets Evolution API's documented v2 request shape
// (flat {"number","text"} body). It has not been exercised against a live
// Evolution API instance from this codebase — there is no network access in
// the environment this was written in, and no such instance to test against.
// The field names have shifted across Evolution API's own versions (v1 nested
// `textMessage.text`; v2 flat `text`), so treat this as a best-effort port
// against documented behaviour, same as every other provider client in this
// file, pending real-world verification against a running bridge.
//
// SendInteractive degrades to plain text: Baileys' list/button message
// support is inconsistent across bridge implementations and versions and is
// not part of any stable contract, so rather than guess at an
// instance-specific interactive shape that might silently fail on some
// deployments, every interactive reply is rendered as text (the interactive's
// body plus a numbered list of its row/button titles) and sent through the
// same text endpoint.
type BridgeWhatsAppSender struct {
	BaseURL  string // e.g. https://bridge.example.internal:8080 (Evolution API base URL)
	APIKey   string
	Instance string // the Evolution API instance name this number is bound to
	Client   *http.Client
}

func (s *BridgeWhatsAppSender) client() *http.Client { return orDefaultClient(s.Client) }

func (s *BridgeWhatsAppSender) SendText(ctx context.Context, to, body string) SendResult {
	return s.sendText(ctx, to, body)
}

func (s *BridgeWhatsAppSender) SendInteractive(ctx context.Context, to string, interactive WhatsAppInteractive) SendResult {
	return s.sendText(ctx, to, renderWhatsAppInteractiveAsText(interactive))
}

func (s *BridgeWhatsAppSender) sendText(ctx context.Context, to, body string) SendResult {
	if s.BaseURL == "" || s.APIKey == "" || s.Instance == "" {
		return SendResult{Error: "whatsapp_bridge_credentials_unset"}
	}
	url := strings.TrimRight(s.BaseURL, "/") + "/message/sendText/" + s.Instance
	payload, err := json.Marshal(map[string]any{"number": to, "text": body})
	if err != nil {
		return SendResult{Error: err.Error()}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return SendResult{Error: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apikey", s.APIKey)
	res, err := s.client().Do(req)
	if err != nil {
		return SendResult{Error: err.Error()}
	}
	defer res.Body.Close()
	var out struct {
		Key struct {
			ID string `json:"id"`
		} `json:"key"`
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if res.StatusCode/100 != 2 {
		if out.Error != "" {
			return SendResult{Error: out.Error}
		}
		if out.Message != "" {
			return SendResult{Error: out.Message}
		}
		return SendResult{Error: fmt.Sprintf("http_%d", res.StatusCode)}
	}
	return SendResult{OK: true, ProviderMessageID: out.Key.ID}
}

// renderWhatsAppInteractiveAsText flattens a Meta-shaped interactive message
// into plain text for the bridge engine (see the SendInteractive note above).
func renderWhatsAppInteractiveAsText(i WhatsAppInteractive) string {
	var b strings.Builder
	b.WriteString(i.Body.Text)
	n := 0
	for _, sec := range i.Action.Sections {
		for _, row := range sec.Rows {
			n++
			b.WriteString("\n")
			b.WriteString(itoa(int64(n)))
			b.WriteString(". ")
			b.WriteString(row.Title)
		}
	}
	for _, btn := range i.Action.Buttons {
		n++
		b.WriteString("\n")
		b.WriteString(itoa(int64(n)))
		b.WriteString(". ")
		b.WriteString(btn.Reply.Title)
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

// Block is a Slack Block Kit block (opaque JSON — we build sections + buttons).
type Block = map[string]any

// SlackSender posts text + blocks via chat.postMessage.
type SlackSender interface {
	SendText(ctx context.Context, channelID, text string) SendResult
	SendBlocks(ctx context.Context, channelID, text string, blocks []Block) SendResult
}

// HTTPSlackSender is the real chat.postMessage implementation.
type HTTPSlackSender struct {
	BotToken string
	Client   *http.Client
}

func (s *HTTPSlackSender) post(ctx context.Context, payload map[string]any) SendResult {
	if s.BotToken == "" {
		return SendResult{Error: "slack_token_unset"}
	}
	return postSlack(ctx, orDefaultClient(s.Client), "Bearer "+s.BotToken, payload)
}

func (s *HTTPSlackSender) SendText(ctx context.Context, channelID, text string) SendResult {
	return s.post(ctx, map[string]any{"channel": channelID, "text": text})
}

func (s *HTTPSlackSender) SendBlocks(ctx context.Context, channelID, text string, blocks []Block) SendResult {
	return s.post(ctx, map[string]any{"channel": channelID, "text": text, "blocks": blocks})
}

func postSlack(ctx context.Context, client *http.Client, auth string, payload map[string]any) SendResult {
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://slack.com/api/chat.postMessage", bytes.NewReader(body))
	if err != nil {
		return SendResult{Error: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", auth)
	res, err := client.Do(req)
	if err != nil {
		return SendResult{Error: err.Error()}
	}
	defer res.Body.Close()
	var out struct {
		OK    bool   `json:"ok"`
		TS    string `json:"ts"`
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if !out.OK {
		if out.Error != "" {
			return SendResult{Error: out.Error}
		}
		return SendResult{Error: fmt.Sprintf("http_%d", res.StatusCode)}
	}
	return SendResult{OK: true, ProviderMessageID: out.TS}
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

// InlineKeyboard is a Telegram inline keyboard (rows of callback buttons).
type InlineKeyboard struct {
	Rows [][]InlineButton
}

type InlineButton struct {
	Text         string
	CallbackData string
}

func (k InlineKeyboard) markup() map[string]any {
	rows := make([][]map[string]any, 0, len(k.Rows))
	for _, row := range k.Rows {
		out := make([]map[string]any, 0, len(row))
		for _, b := range row {
			out = append(out, map[string]any{"text": b.Text, "callback_data": b.CallbackData})
		}
		rows = append(rows, out)
	}
	return map[string]any{"inline_keyboard": rows}
}

// TelegramSender sends text + inline-keyboard replies via the Bot API.
type TelegramSender interface {
	SendText(ctx context.Context, chatID int64, body string) SendResult
	SendInlineKeyboard(ctx context.Context, chatID int64, body string, kb InlineKeyboard) SendResult
	// AnswerCallback dismisses the "loading" spinner on an inline-button tap.
	AnswerCallback(ctx context.Context, callbackID string) SendResult
}

// HTTPTelegramSender is the real Bot API implementation.
type HTTPTelegramSender struct {
	BotToken string
	Client   *http.Client
}

func (s *HTTPTelegramSender) method(ctx context.Context, method string, payload map[string]any) SendResult {
	if s.BotToken == "" {
		return SendResult{Error: "telegram_token_unset"}
	}
	url := fmt.Sprintf("https://api.telegram.org/bot%s/%s", s.BotToken, method)
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return SendResult{Error: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := orDefaultClient(s.Client).Do(req)
	if err != nil {
		return SendResult{Error: err.Error()}
	}
	defer res.Body.Close()
	var out struct {
		OK     bool `json:"ok"`
		Result struct {
			MessageID int64 `json:"message_id"`
		} `json:"result"`
		Description string `json:"description"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if !out.OK {
		if out.Description != "" {
			return SendResult{Error: out.Description}
		}
		return SendResult{Error: fmt.Sprintf("http_%d", res.StatusCode)}
	}
	id := ""
	if out.Result.MessageID != 0 {
		id = fmt.Sprintf("%d", out.Result.MessageID)
	}
	return SendResult{OK: true, ProviderMessageID: id}
}

func (s *HTTPTelegramSender) SendText(ctx context.Context, chatID int64, body string) SendResult {
	return s.method(ctx, "sendMessage", map[string]any{"chat_id": chatID, "text": body, "parse_mode": "HTML"})
}

func (s *HTTPTelegramSender) SendInlineKeyboard(ctx context.Context, chatID int64, body string, kb InlineKeyboard) SendResult {
	return s.method(ctx, "sendMessage", map[string]any{
		"chat_id": chatID, "text": body, "parse_mode": "HTML", "reply_markup": kb.markup(),
	})
}

func (s *HTTPTelegramSender) AnswerCallback(ctx context.Context, callbackID string) SendResult {
	return s.method(ctx, "answerCallbackQuery", map[string]any{"callback_query_id": callbackID})
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func orDefaultClient(c *http.Client) *http.Client {
	if c != nil {
		return c
	}
	return &http.Client{Timeout: 10 * time.Second}
}
