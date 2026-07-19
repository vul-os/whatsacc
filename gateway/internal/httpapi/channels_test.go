package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/vul-os/whatsacc/gateway/internal/channels"
	"github.com/vul-os/whatsacc/gateway/internal/keys"
	"github.com/vul-os/whatsacc/gateway/internal/store"
)

// ---------------------------------------------------------------------------
// Fake senders (record outbound; no network)
// ---------------------------------------------------------------------------

type waSent struct {
	to          string
	body        string
	interactive *channels.WhatsAppInteractive
}

type fakeWA struct {
	mu   sync.Mutex
	sent []waSent
}

func (f *fakeWA) SendText(_ context.Context, to, body string) channels.SendResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, waSent{to: to, body: body})
	return channels.SendResult{OK: true, ProviderMessageID: "wamid.out"}
}

func (f *fakeWA) SendInteractive(_ context.Context, to string, i channels.WhatsAppInteractive) channels.SendResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	ic := i
	f.sent = append(f.sent, waSent{to: to, interactive: &ic})
	return channels.SendResult{OK: true, ProviderMessageID: "wamid.out"}
}

func (f *fakeWA) all() []waSent {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]waSent(nil), f.sent...)
}

type slackSent struct {
	channel string
	text    string
	blocks  []channels.Block
}

type fakeSlack struct {
	mu   sync.Mutex
	sent []slackSent
}

func (f *fakeSlack) SendText(_ context.Context, ch, text string) channels.SendResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, slackSent{channel: ch, text: text})
	return channels.SendResult{OK: true, ProviderMessageID: "1.1"}
}

func (f *fakeSlack) SendBlocks(_ context.Context, ch, text string, blocks []channels.Block) channels.SendResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, slackSent{channel: ch, text: text, blocks: blocks})
	return channels.SendResult{OK: true, ProviderMessageID: "1.1"}
}

func (f *fakeSlack) all() []slackSent {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]slackSent(nil), f.sent...)
}

type tgSent struct {
	chat int64
	text string
	kb   *channels.InlineKeyboard
}

type fakeTG struct {
	mu        sync.Mutex
	sent      []tgSent
	callbacks int
}

func (f *fakeTG) SendText(_ context.Context, chat int64, body string) channels.SendResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, tgSent{chat: chat, text: body})
	return channels.SendResult{OK: true, ProviderMessageID: "42"}
}

func (f *fakeTG) SendInlineKeyboard(_ context.Context, chat int64, body string, kb channels.InlineKeyboard) channels.SendResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := kb
	f.sent = append(f.sent, tgSent{chat: chat, text: body, kb: &k})
	return channels.SendResult{OK: true, ProviderMessageID: "42"}
}

func (f *fakeTG) AnswerCallback(_ context.Context, _ string) channels.SendResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.callbacks++
	return channels.SendResult{OK: true}
}

func (f *fakeTG) all() []tgSent {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]tgSent(nil), f.sent...)
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const (
	waSecret    = "wa-app-secret"
	waVerify    = "wa-verify-token"
	waPhoneID   = "PHONE_ID_1"
	slackSecret = "slack-signing-secret"
	tgSecret    = "tg-webhook-secret"

	testPhone    = "+27821234567"
	testPhoneRaw = "27821234567"
	testSlackUID = "U0OWNER"
	testTGUID    = int64(55501)
	testTGChat   = int64(999001)
)

type chEnv struct {
	s      *Server
	h      http.Handler
	st     *store.Store
	wa     *fakeWA
	slack  *fakeSlack
	tg     *fakeTG
	ownerA string
	acct   string
	loc    string
	apID   string
	ownID  string
}

func permissiveRL() store.RateLimitConfig {
	return store.RateLimitConfig{OpenCooldownS: 0, OpensPerHour: 1000, ChatMsgsPerMin: 10, AccountOpensPerHour: 100000}
}

func setupChannels(t *testing.T, rl store.RateLimitConfig) *chEnv {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ks, err := keys.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	s := New(Config{
		Version:    "test",
		PublicURL:  "https://gate.example",
		JWTSecret:  []byte("0123456789abcdef0123456789abcdef"),
		RateLimits: rl,
		Channels: channels.Config{
			WhatsAppAppSecret:     waSecret,
			WhatsAppVerifyToken:   waVerify,
			WhatsAppPhoneNumberID: waPhoneID,
			SlackSigningSecret:    slackSecret,
			TelegramWebhookSecret: tgSecret,
			PublicURL:             "https://gate.example",
		},
	}, st, ks, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	fw, fs, ft := &fakeWA{}, &fakeSlack{}, &fakeTG{}
	s.waSend, s.slackSend, s.tgSend = fw, fs, ft
	h := s.Router()

	env := &chEnv{s: s, h: h, st: st, wa: fw, slack: fs, tg: ft}
	env.ownerA, _ = register(t, h, "owner@ch.com")
	env.acct, env.loc = tenantIDs(t, h, env.ownerA)
	env.apID = createAP(t, h, env.ownerA, env.loc, "Main gate")
	env.ownID = meID(t, h, env.ownerA)

	ctx := context.Background()
	if err := st.AddVerifiedPhone(ctx, env.ownID, testPhone); err != nil {
		t.Fatal(err)
	}
	if err := st.LinkChannelIdentity(ctx, channels.KindSlack, testSlackUID, env.ownID); err != nil {
		t.Fatal(err)
	}
	if err := st.LinkChannelIdentity(ctx, channels.KindTelegram, strconv.FormatInt(testTGUID, 10), env.ownID); err != nil {
		t.Fatal(err)
	}
	return env
}

func createAP(t *testing.T, h http.Handler, access, loc, name string) string {
	t.Helper()
	rec, out := doJSON(t, h, "POST", "/v1/access-points", access, map[string]any{
		"location_id": loc, "name": name, "kind": "gate",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("ap create: %d %s", rec.Code, rec.Body)
	}
	return out["id"].(string)
}

func meID(t *testing.T, h http.Handler, access string) string {
	t.Helper()
	_, out := doJSON(t, h, "GET", "/v1/auth/me", access, nil)
	return out["user"].(map[string]any)["id"].(string)
}

// ---------------------------------------------------------------------------
// Raw signed requests
// ---------------------------------------------------------------------------

func hmacHex(secret string, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

func rawPost(h http.Handler, path string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", path, bytes.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func waPost(h http.Handler, body []byte) *httptest.ResponseRecorder {
	return rawPost(h, "/webhooks/whatsapp", body, map[string]string{
		"Content-Type":        "application/json",
		"X-Hub-Signature-256": "sha256=" + hmacHex(waSecret, body),
	})
}

func slackPost(h http.Handler, path string, body []byte) *httptest.ResponseRecorder {
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	return rawPost(h, path, body, map[string]string{
		"X-Slack-Request-Timestamp": ts,
		"X-Slack-Signature":         "v0=" + hmacHex(slackSecret, []byte("v0:"+ts+":"+string(body))),
	})
}

func tgPost(h http.Handler, body []byte) *httptest.ResponseRecorder {
	return rawPost(h, "/webhooks/telegram", body, map[string]string{
		"Content-Type":                    "application/json",
		"X-Telegram-Bot-Api-Secret-Token": tgSecret,
	})
}

func doRaw(h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func mustJSONBytes(v any) []byte { b, _ := json.Marshal(v); return b }

// successOpens counts audited successful opens for an account+source.
func (e *chEnv) successOpens(t *testing.T, source string) int {
	t.Helper()
	logs, err := e.st.AccessLogsByAccount(context.Background(), e.acct, 100)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, l := range logs {
		if l.Success && l.Command == "open" && l.Source == source {
			n++
		}
	}
	return n
}

// ---------------------------------------------------------------------------
// Identity resolution + Socket Mode routing
// ---------------------------------------------------------------------------

func TestChannelSocketModeRoutesThroughSameHandler(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	ctx := context.Background()

	// events_api envelope: a linked Slack member's "open" → the SAME processing
	// as the webhook, so the fake sender receives the gate blocks.
	eventPayload := mustJSONBytes(map[string]any{
		"type":    "event_callback",
		"team_id": "T1",
		"event":   map[string]any{"type": "message", "user": testSlackUID, "channel": "C1", "text": "open", "ts": "1700000000.0001"},
	})
	e.s.handleSlackSocketEnvelope(ctx, "events_api", eventPayload)

	blocksSent := false
	for _, s := range e.slack.all() {
		if s.blocks != nil {
			blocksSent = true
		}
	}
	if !blocksSent {
		t.Fatalf("socket events_api did not yield gate blocks: %+v", e.slack.all())
	}

	// interactive envelope: block_actions open_gate → verdict + dispatch.
	interPayload := mustJSONBytes(map[string]any{
		"type":    "block_actions",
		"user":    map[string]any{"id": testSlackUID},
		"channel": map[string]any{"id": "C1"},
		"actions": []map[string]any{{"action_id": "open_gate:" + e.apID, "value": e.apID}},
	})
	e.s.handleSlackSocketEnvelope(ctx, "interactive", interPayload)
	if n := e.successOpens(t, channels.KindSlack); n != 1 {
		t.Fatalf("socket interactive open not audited: %d", n)
	}
}
