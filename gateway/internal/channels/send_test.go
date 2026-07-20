package channels

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestResolveWhatsAppEngineFailsClosedToCloud covers the safety property:
// only the exact opt-in string "bridge" (trimmed, case-insensitive) selects
// the unofficial engine; everything else — including plausible typos — must
// resolve to the official default, never silently to the risky one.
func TestResolveWhatsAppEngineFailsClosedToCloud(t *testing.T) {
	cases := []struct {
		raw  string
		want WhatsAppEngine
	}{
		{"", WhatsAppEngineCloud},
		{"cloud", WhatsAppEngineCloud},
		{"CLOUD", WhatsAppEngineCloud},
		{"brige", WhatsAppEngineCloud},  // typo must NOT fall through to bridge
		{"Bridge ", WhatsAppEngineBridge}, // exact word, case/whitespace-insensitive
		{"bridge", WhatsAppEngineBridge},
		{"BRIDGE", WhatsAppEngineBridge},
		{"unofficial", WhatsAppEngineCloud},
		{"baileys", WhatsAppEngineCloud},
	}
	for _, tc := range cases {
		if got := ResolveWhatsAppEngine(tc.raw); got != tc.want {
			t.Errorf("ResolveWhatsAppEngine(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

// TestNewWhatsAppSenderDefaultsToCloud proves the zero-value engine (an
// entirely unset Config) yields the official cloud sender, never the bridge.
func TestNewWhatsAppSenderDefaultsToCloud(t *testing.T) {
	s := NewWhatsAppSender(ResolveWhatsAppEngine(""), Config{})
	if _, ok := s.(*HTTPWhatsAppSender); !ok {
		t.Fatalf("default engine must be the official Cloud API sender, got %T", s)
	}
}

// TestNewWhatsAppSenderBridgeRequiresExplicitOptIn proves selecting "bridge"
// yields the bridge sender only, and that sender fails closed without its own
// credentials — mirrors HTTPWhatsAppSender's existing unset-credential contract.
func TestNewWhatsAppSenderBridgeRequiresExplicitOptIn(t *testing.T) {
	s := NewWhatsAppSender(WhatsAppEngineBridge, Config{})
	bs, ok := s.(*BridgeWhatsAppSender)
	if !ok {
		t.Fatalf("bridge engine must yield BridgeWhatsAppSender, got %T", s)
	}
	res := bs.SendText(context.Background(), "27821234567", "hi")
	if res.OK || res.Error != "whatsapp_bridge_credentials_unset" {
		t.Fatalf("unset bridge credentials must fail closed, got %+v", res)
	}
}

// TestBridgeWhatsAppSenderSendsRealHTTPRequest proves the wire shape against a
// fake Evolution-API-shaped server: correct path, apikey header, JSON body,
// and successful id extraction.
func TestBridgeWhatsAppSenderSendsRealHTTPRequest(t *testing.T) {
	var gotPath, gotAPIKey string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAPIKey = r.Header.Get("apikey")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"key": map[string]string{"id": "bridge-msg-1"}})
	}))
	defer srv.Close()

	s := &BridgeWhatsAppSender{BaseURL: srv.URL, APIKey: "sekret", Instance: "inst1"}
	res := s.SendText(context.Background(), "27821234567", "hello")
	if !res.OK || res.ProviderMessageID != "bridge-msg-1" {
		t.Fatalf("send failed: %+v", res)
	}
	if gotPath != "/message/sendText/inst1" {
		t.Errorf("path: %q", gotPath)
	}
	if gotAPIKey != "sekret" {
		t.Errorf("apikey header: %q", gotAPIKey)
	}
	if gotBody["number"] != "27821234567" || gotBody["text"] != "hello" {
		t.Errorf("body: %+v", gotBody)
	}
}

// TestBridgeWhatsAppSenderPropagatesProviderError proves a non-2xx response
// is reported as a failure, never silently treated as sent.
func TestBridgeWhatsAppSenderPropagatesProviderError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"message": "invalid apikey"})
	}))
	defer srv.Close()

	s := &BridgeWhatsAppSender{BaseURL: srv.URL, APIKey: "bad", Instance: "inst1"}
	res := s.SendText(context.Background(), "27821234567", "hi")
	if res.OK || res.Error != "invalid apikey" {
		t.Fatalf("expected propagated provider error, got %+v", res)
	}
}

// TestBridgeWhatsAppSenderInteractiveDegradesToText proves SendInteractive
// never guesses at a bridge-specific interactive shape — it always renders
// text and reuses the text endpoint.
func TestBridgeWhatsAppSenderInteractiveDegradesToText(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{"key": map[string]string{"id": "m1"}})
	}))
	defer srv.Close()

	s := &BridgeWhatsAppSender{BaseURL: srv.URL, APIKey: "k", Instance: "i1"}
	interactive := WhatsAppInteractive{
		Type: "list",
		Body: WAText{Text: "Which gate?"},
		Action: WhatsAppAction{
			Sections: []WhatsAppSection{{Rows: []WhatsAppRow{{Title: "Main gate"}, {Title: "Side door"}}}},
		},
	}
	res := s.SendInteractive(context.Background(), "27821234567", interactive)
	if !res.OK {
		t.Fatalf("send failed: %+v", res)
	}
	if gotPath != "/message/sendText/i1" {
		t.Errorf("interactive must reuse the text endpoint, got path %q", gotPath)
	}
	text, _ := gotBody["text"].(string)
	if !strings.Contains(text, "Which gate?") || !strings.Contains(text, "1. Main gate") || !strings.Contains(text, "2. Side door") {
		t.Fatalf("interactive not rendered as text: %q", text)
	}
}

// TestWhatsAppBanRiskWarningNamesTheRisk is a content guard: the warning
// string must actually name the ban risk and a fallback that genuinely works,
// not be softened into something vague in a later edit — and it must NOT
// point operators at the offline LAN/BLE grant path as if that path ran
// end to end. Gateway-side issuance is real now (POST /v1/offline-grants,
// see gateway/internal/httpapi/offline_grants.go), but the app still doesn't
// request, store or present a grant (site/docs/emergency-access.md), so the
// path still doesn't run end to end for a resident. Claiming otherwise would
// ship a false promise: "fall back to offline grants" when nothing on a
// resident's phone can present one.
func TestWhatsAppBanRiskWarningNamesTheRisk(t *testing.T) {
	w := WhatsAppBanRiskWarning
	for _, must := range []string{"UNOFFICIAL", "ban", "REQUIRED", "web portal", "Slack Socket Mode", "Telegram"} {
		if !strings.Contains(w, must) {
			t.Errorf("ban-risk warning must mention %q: %q", must, w)
		}
	}
	if !strings.Contains(w, "LAN/BLE") || !strings.Contains(w, "NOT a working fallback") {
		t.Errorf("ban-risk warning must explicitly disclaim the LAN/BLE grant path as broken, not silently drop it: %q", w)
	}
}
