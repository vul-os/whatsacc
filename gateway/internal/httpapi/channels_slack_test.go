package httpapi

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vul-os/lintel/gateway/internal/channels"
)

func slackEvent(user, text, ts string) []byte {
	return mustJSONBytes(map[string]any{
		"type":    "event_callback",
		"team_id": "T1",
		"event":   map[string]any{"type": "message", "user": user, "channel": "C1", "text": text, "ts": ts},
	})
}

func slackInteraction(user, apID string) []byte {
	payload := mustJSONBytes(map[string]any{
		"type":    "block_actions",
		"user":    map[string]any{"id": user},
		"channel": map[string]any{"id": "C1"},
		"actions": []map[string]any{{"action_id": "open_gate:" + apID, "value": apID}},
	})
	return []byte(url.Values{"payload": {string(payload)}}.Encode())
}

func TestSlackSignatureFailClosed(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	body := slackEvent(testSlackUID, "open", "1700000000.0001")

	// missing headers never skip verification
	if rec := rawPost(e.h, "/webhooks/slack", body, nil); rec.Code != http.StatusForbidden {
		t.Errorf("missing headers: %d", rec.Code)
	}
	// stale timestamp rejected
	staleTS := strconv.FormatInt(time.Now().Unix()-1000, 10)
	rec := rawPost(e.h, "/webhooks/slack", body, map[string]string{
		"X-Slack-Request-Timestamp": staleTS,
		"X-Slack-Signature":         "v0=" + hmacHex(slackSecret, []byte("v0:"+staleTS+":"+string(body))),
	})
	if rec.Code != http.StatusForbidden {
		t.Errorf("stale ts: %d", rec.Code)
	}
	// bad signature rejected
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	rec = rawPost(e.h, "/webhooks/slack", body, map[string]string{
		"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": "v0=bad",
	})
	if rec.Code != http.StatusForbidden {
		t.Errorf("bad sig: %d", rec.Code)
	}
	// valid passes
	if rec := slackPost(e.h, "/webhooks/slack", body); rec.Code != 200 {
		t.Errorf("valid: %d %s", rec.Code, rec.Body)
	}
}

func TestSlackURLVerificationChallenge(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	body := mustJSONBytes(map[string]any{"type": "url_verification", "challenge": "abc123"})
	rec := slackPost(e.h, "/webhooks/slack", body)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "abc123") {
		t.Fatalf("challenge echo: %d %s", rec.Code, rec.Body)
	}
}

func TestSlackHelpAndOpenBlocks(t *testing.T) {
	e := setupChannels(t, permissiveRL())

	// help word → menu text
	slackPost(e.h, "/webhooks/slack", slackEvent(testSlackUID, "hi", "1700000000.1"))
	sent := e.slack.all()
	if len(sent) != 1 || !strings.Contains(sent[0].text, "open your linked gates") {
		t.Fatalf("help menu: %+v", sent)
	}

	// "open" → gate blocks (no actuation yet)
	e.slack.sent = nil
	slackPost(e.h, "/webhooks/slack", slackEvent(testSlackUID, "open", "1700000000.2"))
	sent = e.slack.all()
	if len(sent) != 1 || sent[0].blocks == nil {
		t.Fatalf("open should render blocks: %+v", sent)
	}
	if n := e.successOpens(t, channels.KindSlack); n != 0 {
		t.Fatalf("blocks render must not open: %d", n)
	}
}

func TestSlackUnlinkedUser(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	slackPost(e.h, "/webhooks/slack", slackEvent("U-STRANGER", "open", "1700000000.3"))
	sent := e.slack.all()
	if len(sent) != 1 || !strings.Contains(sent[0].text, "don't know which lintel profile") {
		t.Fatalf("unlinked slack: %+v", sent)
	}
}

func TestSlackInteractionOpensAndAudits(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	rec := slackPost(e.h, "/webhooks/slack/interactions", slackInteraction(testSlackUID, e.apID))
	if rec.Code != 200 {
		t.Fatalf("interaction code: %d", rec.Code)
	}
	if n := e.successOpens(t, channels.KindSlack); n != 1 {
		t.Fatalf("interaction open not audited: %d", n)
	}
	sent := e.slack.all()
	if len(sent) != 1 || !strings.Contains(sent[0].text, "Opening gate") {
		t.Fatalf("interaction reply: %+v", sent)
	}
}

func TestSlackInteractionUnlinkedNoActuation(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	slackPost(e.h, "/webhooks/slack/interactions", slackInteraction("U-STRANGER", e.apID))
	if n := e.successOpens(t, channels.KindSlack); n != 0 {
		t.Fatalf("unlinked interaction must not open: %d", n)
	}
}
