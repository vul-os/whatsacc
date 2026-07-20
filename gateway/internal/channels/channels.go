// Package channels is the gateway's chat-channel seam: the per-provider parts
// of "resolve sender → identity, message → intent, reply → send" that are
// genuinely provider-specific — fail-closed webhook authentication (or, for a
// dial-out provider, connection-native authentication), inbound wire parsing,
// and reply rendering (WhatsApp interactive lists, Slack blocks, Telegram
// inline keyboards). The conversational contract and the authorization it
// gates are NOT here: every open funnels through the shared open-path choke
// point (store.LogAccess → sign → hub dispatch) the HTTP open route uses,
// driven by the httpapi channel handlers. A channel decides how to ask and how
// to reply; it NEVER decides whether the gate may open — dial-out channels are
// held to exactly the same rule (see DialChannel).
//
// Design (ARCHITECTURE §3a / §4): two small interfaces cover the two shapes a
// channel comes in.
//
//   - Channel is webhook-shaped (WhatsApp, Slack Events API, Telegram): the
//     provider POSTs to us; Verify fail-closed-authenticates the request.
//   - DialChannel is subscribe-shaped: the gateway dials OUT to (or otherwise
//     maintains a live session with) the provider instead of receiving
//     webhooks, so a LAN-only gateway with no public URL can still run it
//     fully. Slack Socket Mode (socketmode.go) is the original precedent;
//     DMTAP (dmtap.go) is the second implementation, generalizing the
//     precedent into a proper seam instead of a Slack-specific special case.
//
// Both funnel into the SAME httpapi handler code path and the SAME choke
// point — a dial-out channel differs from a webhook channel only in how it
// receives bytes, never in what it is allowed to do with them.
package channels

import (
	"context"
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
	KindDMTAP    = "dmtap" // scaffold only — see dmtap.go for exactly what is real
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

// Channel is the per-provider seam for a WEBHOOK-shaped provider. It
// authenticates an inbound webhook (fail-closed) and names its identity
// space. Everything else a channel does is exposed as concrete
// rendering/parsing helpers used by the httpapi handlers, which own the
// shared conversational + open pipeline.
type Channel interface {
	Kind() string
	Verify(headers http.Header, body []byte, now int64) VerifyResult
}

// DialChannel is the per-provider seam for a SUBSCRIBE-shaped provider: one
// that has no webhook to receive because the gateway dials OUT to it (or
// otherwise holds a live, provider-authenticated session) instead. This is
// the generalized precedent set by Slack Socket Mode (socketmode.go) — a
// LAN-only gateway with no public URL can still run the channel fully — made
// into a proper seam so a subscribe-style provider (DMTAP: dmtap.go) is a
// first-class channel rather than a Slack-specific special case.
//
// There is no separate Verify: the connection itself IS the authentication
// (Slack's app-level token proves the workspace install; DMTAP's MLS group
// membership proves the sender). What Verify's fail-closed contract becomes
// here is Enabled — Run must never be invoked, and StartChannels must never
// launch it, unless the provider is genuinely configured; an unset credential
// means "this channel does not run", never "this channel runs unauthenticated".
//
// Same authorization contract as Channel: whatever Run receives from the
// provider, it may only hand to its own Handle-style callback, which funnels
// through the SAME store.LogAccess → sign → hub dispatch choke point every
// webhook channel uses (via the httpapi handlers). A dial-out channel may
// deliver an intent; it never decides whether the gate may open.
type DialChannel interface {
	Kind() string
	// Enabled reports whether this channel is configured to dial out (e.g. an
	// app/session token or identity key is set). Fail-closed: the zero value
	// of a DialChannel implementation must report false.
	Enabled() bool
	// Run dials out (or opens/maintains the subscribed session) and serves it
	// until ctx is cancelled, reconnecting with backoff on a recoverable
	// error. Intended to be launched in its own goroutine; must not be called
	// unless Enabled() is true.
	Run(ctx context.Context)
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
	// WhatsAppEngine is the raw LINTEL_WHATSAPP_ENGINE value — "cloud"
	// (default; also anything unset/misspelled) or the opt-in "bridge".
	// Resolve with ResolveWhatsAppEngine (send.go); build the sender with
	// NewWhatsAppSender. See send.go's "WhatsApp engine selection" section
	// for the ban-risk requirement this exists to enforce.
	WhatsAppEngine string
	// WhatsAppBridgeURL / WhatsAppBridgeAPIKey / WhatsAppBridgeInstance
	// configure the opt-in self-hosted bridge engine (target: Evolution
	// API). Only consulted when WhatsAppEngine resolves to
	// WhatsAppEngineBridge; unset means BridgeWhatsAppSender fails closed.
	WhatsAppBridgeURL      string
	WhatsAppBridgeAPIKey   string
	WhatsAppBridgeInstance string

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
// in tests). Provider CREDENTIAL env var names match the Workers backend (the
// behavioral spec: WHATSAPP_*, SLACK_*, TELEGRAM_*, no LINTEL_ prefix — kept
// for parity with a backend that predates and has no counterpart for them).
// Config that is genuinely new to the Go gateway, with no backend precedent —
// the WhatsApp engine selection and bridge config — uses the LINTEL_* prefix,
// consistent with the gateway's own infra config (LINTEL_DATA_DIR,
// LINTEL_LISTEN, …).
func FromEnv(getenv func(string) string, publicURL string) Config {
	return Config{
		WhatsAppAppSecret:      getenv("WHATSAPP_APP_SECRET"),
		WhatsAppVerifyToken:    getenv("WHATSAPP_VERIFY_TOKEN"),
		WhatsAppAccessToken:    getenv("WHATSAPP_ACCESS_TOKEN"),
		WhatsAppPhoneNumberID:  getenv("WHATSAPP_PHONE_NUMBER_ID"),
		WhatsAppGraphVersion:   getenv("WHATSAPP_GRAPH_VERSION"),
		WhatsAppEngine:         getenv("LINTEL_WHATSAPP_ENGINE"),
		WhatsAppBridgeURL:      getenv("LINTEL_WHATSAPP_BRIDGE_URL"),
		WhatsAppBridgeAPIKey:   getenv("LINTEL_WHATSAPP_BRIDGE_API_KEY"),
		WhatsAppBridgeInstance: getenv("LINTEL_WHATSAPP_BRIDGE_INSTANCE"),
		SlackSigningSecret:     getenv("SLACK_SIGNING_SECRET"),
		SlackBotToken:          getenv("SLACK_BOT_TOKEN"),
		SlackAppToken:          getenv("SLACK_APP_TOKEN"),
		TelegramBotToken:       getenv("TELEGRAM_BOT_TOKEN"),
		TelegramWebhookSecret:  getenv("TELEGRAM_WEBHOOK_SECRET"),
		PublicURL:              publicURL,
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
