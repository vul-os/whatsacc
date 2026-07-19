// Package channels is the gateway's chat-channel seam: the per-provider parts
// of "resolve sender → identity, message → intent, reply → send" that are
// genuinely provider-specific — fail-closed webhook authentication, inbound
// wire parsing, and reply rendering (WhatsApp interactive lists, Slack blocks,
// Telegram inline keyboards). The conversational contract and the
// authorization it gates are NOT here: every open funnels through the shared
// open-path choke point (store.LogAccess → sign → hub dispatch) the HTTP open
// route uses, driven by the httpapi channel handlers. A channel decides how to
// ask and how to reply; it never decides whether the gate may open.
//
// Design (ARCHITECTURE §3a / §4): one small Channel interface authenticates
// and names the identity space; Socket Mode (this package) lets a LAN-only
// gateway with no public URL still run Slack fully by dialing out to Slack.
package channels

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
)

// Kind constants — the identity space / source tag per channel (also the
// access_logs.source value and the channel_* tables' channel column).
const (
	KindWhatsApp = "whatsapp"
	KindSlack    = "slack"
	KindTelegram = "telegram"
)

// SlackReplayWindowS is Slack's standard signed-request replay window: reject
// a (validly signed) request whose timestamp is more than this far from now.
const SlackReplayWindowS = 300

// VerifyResult is the outcome of authenticating an inbound webhook. Reason is
// the fail-closed rejection code (logged, mirrors the backend vocabulary):
// e.g. slack_not_configured, bad_signature, missing_signature, bad_secret_token.
type VerifyResult struct {
	OK     bool
	Reason string
}

func ok() VerifyResult             { return VerifyResult{OK: true} }
func reject(r string) VerifyResult { return VerifyResult{OK: false, Reason: r} }

// Channel is the per-provider seam. It authenticates an inbound webhook
// (fail-closed) and names its identity space. Everything else a channel does
// is exposed as concrete rendering/parsing helpers used by the httpapi
// handlers, which own the shared conversational + open pipeline.
type Channel interface {
	Kind() string
	Verify(headers http.Header, body []byte, now int64) VerifyResult
}

// Config holds the channel credentials, sourced from env in main. All fields
// optional: a channel with no secret configured refuses its webhook
// (fail-closed) and its sender is a config-unset no-op — exactly the backend's
// behaviour.
type Config struct {
	// WhatsApp (Meta Cloud API)
	WhatsAppAppSecret     string
	WhatsAppVerifyToken   string
	WhatsAppAccessToken   string
	WhatsAppPhoneNumberID string
	WhatsAppGraphVersion  string

	// Slack (Events API webhook + Socket Mode)
	SlackSigningSecret string
	SlackBotToken      string
	SlackAppToken      string // xapp-… → Socket Mode (zero public URL)

	// Telegram (Bot API webhook)
	TelegramBotToken      string
	TelegramWebhookSecret string

	// PublicURL is the gateway's external base URL, for signup/dashboard links.
	PublicURL string
}

// FromEnv builds a Config from a getenv func (os.Getenv in production, a map
// in tests). Env var names match the Workers backend (the behavioral spec).
func FromEnv(getenv func(string) string, publicURL string) Config {
	return Config{
		WhatsAppAppSecret:     getenv("WHATSAPP_APP_SECRET"),
		WhatsAppVerifyToken:   getenv("WHATSAPP_VERIFY_TOKEN"),
		WhatsAppAccessToken:   getenv("WHATSAPP_ACCESS_TOKEN"),
		WhatsAppPhoneNumberID: getenv("WHATSAPP_PHONE_NUMBER_ID"),
		WhatsAppGraphVersion:  getenv("WHATSAPP_GRAPH_VERSION"),
		SlackSigningSecret:    getenv("SLACK_SIGNING_SECRET"),
		SlackBotToken:         getenv("SLACK_BOT_TOKEN"),
		SlackAppToken:         getenv("SLACK_APP_TOKEN"),
		TelegramBotToken:      getenv("TELEGRAM_BOT_TOKEN"),
		TelegramWebhookSecret: getenv("TELEGRAM_WEBHOOK_SECRET"),
		PublicURL:             publicURL,
	}
}

// ---------------------------------------------------------------------------
// Signature primitives (fail-closed; constant-time compares)
// ---------------------------------------------------------------------------

func hmacHex(secret, message string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(message))
	return hex.EncodeToString(m.Sum(nil))
}

// constEq is a length-checked constant-time string compare.
func constEq(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// verifyWhatsAppSig checks Meta's X-Hub-Signature-256 (sha256=<hex hmac of the
// raw body under the app secret>). Fail-closed: unset secret / missing / bad →
// reject.
func verifyWhatsAppSig(appSecret string, headers http.Header, body []byte) VerifyResult {
	if appSecret == "" {
		return reject("webhook_secret_unset")
	}
	sig := headers.Get("X-Hub-Signature-256")
	if sig == "" || !strings.HasPrefix(sig, "sha256=") {
		return reject("missing_signature")
	}
	expected := "sha256=" + hmacHex(appSecret, string(body))
	if !constEq(expected, sig) {
		return reject("bad_signature")
	}
	return ok()
}

// verifySlackSig mirrors the backend's hardened check: signing secret REQUIRED
// (unset → slack_not_configured), timestamp + signature headers required,
// stale timestamp (outside the 300s replay window) rejected, then the v0 HMAC.
// Omitting the headers must never skip verification.
func verifySlackSig(signingSecret string, headers http.Header, body []byte, now int64) VerifyResult {
	if signingSecret == "" {
		return reject("slack_not_configured")
	}
	ts := headers.Get("X-Slack-Request-Timestamp")
	sig := headers.Get("X-Slack-Signature")
	if ts == "" || sig == "" {
		return reject("bad_signature")
	}
	tsN, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return reject("bad_signature")
	}
	if diff := now - tsN; diff > SlackReplayWindowS || diff < -SlackReplayWindowS {
		return reject("bad_signature")
	}
	expected := "v0=" + hmacHex(signingSecret, "v0:"+ts+":"+string(body))
	if !constEq(expected, sig) {
		return reject("bad_signature")
	}
	return ok()
}

// verifyTelegramSecret checks the X-Telegram-Bot-Api-Secret-Token header
// against the configured webhook secret. Fail-closed: unset → refuse entirely.
func verifyTelegramSecret(webhookSecret string, headers http.Header) VerifyResult {
	if webhookSecret == "" {
		return reject("telegram_not_configured")
	}
	if !constEq(webhookSecret, headers.Get("X-Telegram-Bot-Api-Secret-Token")) {
		return reject("bad_secret_token")
	}
	return ok()
}

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

// NormalizeText lower-cases and trims an inbound body (WhatsApp/Telegram).
func NormalizeText(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// NormalizeSlackText additionally strips <@U…> mention tokens (Slack wraps the
// bot mention in app_mention events).
func NormalizeSlackText(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		if s[i] == '<' {
			if j := strings.IndexByte(s[i:], '>'); j >= 0 && strings.HasPrefix(s[i:], "<@") {
				i += j + 1
				continue
			}
		}
		b.WriteByte(s[i])
		i++
	}
	return NormalizeText(b.String())
}

// textIncludesName reports whether a normalized body mentions a name (used to
// disambiguate "open the side gate" against the member's gates/locations).
func textIncludesName(body, name string) bool {
	n := strings.TrimSpace(strings.ToLower(name))
	return n != "" && strings.Contains(body, n)
}
