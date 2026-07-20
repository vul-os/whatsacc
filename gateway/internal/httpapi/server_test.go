package httpapi

// Server-construction wiring tests for the pluggable WhatsApp engine
// (channels.WhatsAppEngine / channels.NewWhatsAppSender): proves the choice
// made in New() — not just the standalone channels-package helpers — matches
// the non-negotiable honesty requirement (cloud by default, bridge only on
// explicit opt-in, a loud startup warning when it is chosen).

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	"github.com/vul-os/lintel/gateway/internal/channels"
	"github.com/vul-os/lintel/gateway/internal/keys"
	"github.com/vul-os/lintel/gateway/internal/store"
)

func newEngineTestServer(t *testing.T, chCfg channels.Config, logBuf *bytes.Buffer) *Server {
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
	var handler slog.Handler
	if logBuf != nil {
		handler = slog.NewTextHandler(logBuf, nil)
	} else {
		handler = slog.NewTextHandler(&bytes.Buffer{}, nil)
	}
	return New(Config{
		Version:   "test",
		JWTSecret: []byte("0123456789abcdef0123456789abcdef"),
		Channels:  chCfg,
	}, st, ks, slog.New(handler))
}

// TestServerDefaultsToCloudWhatsAppEngineNoWarning proves an entirely unset
// WhatsApp engine config builds the official Cloud API sender and logs no
// ban-risk warning.
func TestServerDefaultsToCloudWhatsAppEngineNoWarning(t *testing.T) {
	var logBuf bytes.Buffer
	s := newEngineTestServer(t, channels.Config{}, &logBuf)
	if _, ok := s.waSend.(*channels.HTTPWhatsAppSender); !ok {
		t.Fatalf("default engine must be the Cloud API sender, got %T", s.waSend)
	}
	if strings.Contains(logBuf.String(), "UNOFFICIAL") {
		t.Errorf("no ban-risk warning should be logged for the default engine: %s", logBuf.String())
	}
}

// TestServerBridgeEngineOptInLogsBanRiskWarning proves selecting the bridge
// engine (a) actually builds the bridge sender and (b) logs the exact
// ban-risk warning at startup — the non-negotiable honesty requirement.
func TestServerBridgeEngineOptInLogsBanRiskWarning(t *testing.T) {
	var logBuf bytes.Buffer
	s := newEngineTestServer(t, channels.Config{
		WhatsAppEngine:         "bridge",
		WhatsAppBridgeURL:      "http://bridge.internal:8080",
		WhatsAppBridgeAPIKey:   "key",
		WhatsAppBridgeInstance: "inst1",
	}, &logBuf)
	bs, ok := s.waSend.(*channels.BridgeWhatsAppSender)
	if !ok {
		t.Fatalf("bridge engine must build BridgeWhatsAppSender, got %T", s.waSend)
	}
	if bs.BaseURL != "http://bridge.internal:8080" || bs.APIKey != "key" || bs.Instance != "inst1" {
		t.Errorf("bridge sender not configured from Config: %+v", bs)
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "UNOFFICIAL") || !strings.Contains(logged, "LAN/BLE") {
		t.Fatalf("bridge opt-in must log the ban-risk warning, got: %s", logged)
	}
}

// TestServerEngineTypoStillDefaultsToCloud proves a misspelled engine value
// never falls through to the risky one — fail-closed toward the safe default.
func TestServerEngineTypoStillDefaultsToCloud(t *testing.T) {
	var logBuf bytes.Buffer
	s := newEngineTestServer(t, channels.Config{WhatsAppEngine: "bridg"}, &logBuf)
	if _, ok := s.waSend.(*channels.HTTPWhatsAppSender); !ok {
		t.Fatalf("a misspelled engine value must fail closed to Cloud API, got %T", s.waSend)
	}
	if strings.Contains(logBuf.String(), "UNOFFICIAL") {
		t.Errorf("a misspelled engine value must not trigger the bridge warning: %s", logBuf.String())
	}
}
