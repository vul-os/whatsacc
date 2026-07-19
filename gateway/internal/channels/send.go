package channels

// Outbound transport for each channel: the wire payload types plus HTTP
// implementations (Meta Graph, Slack chat.postMessage, Telegram sendMessage).
// Each sender is an interface so the httpapi channel handlers can inject a
// recording fake in tests; the real impls no-op (returning ok:false, an
// "…_unset" error) when their credentials are unconfigured — exactly the
// backend's behaviour, so a half-configured install logs replies without
// crashing.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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
