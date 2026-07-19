package httpapi

import (
	"net/http"
	"strings"
	"testing"

	"github.com/vul-os/whatsacc/gateway/internal/channels"
)

// waTextMsg builds a signed-friendly WhatsApp text webhook body.
func waTextMsg(from, id, text, phoneID string) []byte {
	return mustJSONBytes(map[string]any{
		"object": "whatsapp_business_account",
		"entry": []map[string]any{{
			"id": "WABA",
			"changes": []map[string]any{{
				"field": "messages",
				"value": map[string]any{
					"metadata": map[string]any{"phone_number_id": phoneID},
					"messages": []map[string]any{{
						"id": id, "from": from, "timestamp": "1700000000", "type": "text",
						"text": map[string]any{"body": text},
					}},
				},
			}},
		}},
	})
}

func waInteractiveMsg(from, id, replyID, title string) []byte {
	return mustJSONBytes(map[string]any{
		"object": "whatsapp_business_account",
		"entry": []map[string]any{{
			"id": "WABA",
			"changes": []map[string]any{{
				"field": "messages",
				"value": map[string]any{
					"metadata": map[string]any{"phone_number_id": waPhoneID},
					"messages": []map[string]any{{
						"id": id, "from": from, "timestamp": "1700000000", "type": "interactive",
						"interactive": map[string]any{
							"type":       "list_reply",
							"list_reply": map[string]any{"id": replyID, "title": title},
						},
					}},
				},
			}},
		}},
	})
}

func TestWhatsAppSignatureFailClosed(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	body := waTextMsg(testPhoneRaw, "wamid.sig", "hi", waPhoneID)

	// missing signature
	rec := rawPost(e.h, "/webhooks/whatsapp", body, map[string]string{"Content-Type": "application/json"})
	if rec.Code != http.StatusForbidden {
		t.Errorf("missing sig: %d", rec.Code)
	}
	// bad signature
	rec = rawPost(e.h, "/webhooks/whatsapp", body, map[string]string{"X-Hub-Signature-256": "sha256=deadbeef"})
	if rec.Code != http.StatusForbidden {
		t.Errorf("bad sig: %d", rec.Code)
	}
	// valid signature passes
	rec = waPost(e.h, body)
	if rec.Code != http.StatusOK {
		t.Errorf("valid sig: %d %s", rec.Code, rec.Body)
	}
	// GET verify challenge
	req, _ := http.NewRequest("GET", "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token="+waVerify+"&hub.challenge=CHAL", nil)
	rec2 := doRaw(e.h, req)
	if rec2.Code != 200 || rec2.Body.String() != "CHAL" {
		t.Errorf("verify challenge: %d %q", rec2.Code, rec2.Body.String())
	}
	req, _ = http.NewRequest("GET", "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHAL", nil)
	if rec3 := doRaw(e.h, req); rec3.Code != http.StatusForbidden {
		t.Errorf("bad verify token: %d", rec3.Code)
	}
}

func TestWhatsAppUnlinkedSignupPrompt(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	rec := waPost(e.h, waTextMsg("27009998888", "wamid.u1", "hi", waPhoneID))
	if rec.Code != 200 {
		t.Fatalf("code: %d", rec.Code)
	}
	sent := e.wa.all()
	if len(sent) != 1 || !strings.Contains(sent[0].body, "isn't linked") || !strings.Contains(sent[0].body, "/signup?") {
		t.Fatalf("unlinked prompt: %+v", sent)
	}
}

func TestWhatsAppHelpShowsGateMenu(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	rec := waPost(e.h, waTextMsg(testPhoneRaw, "wamid.h1", "hi", waPhoneID))
	if rec.Code != 200 {
		t.Fatalf("code: %d", rec.Code)
	}
	sent := e.wa.all()
	if len(sent) != 1 || sent[0].interactive == nil || sent[0].interactive.Type != "button" {
		t.Fatalf("help menu should be a single-gate button: %+v", sent)
	}
	if id := sent[0].interactive.Action.Buttons[0].Reply.ID; id != "open_ap:"+e.apID {
		t.Errorf("button id: %q", id)
	}
}

func TestWhatsAppDirectOpenReachesVerdict(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	rec := waPost(e.h, waTextMsg(testPhoneRaw, "wamid.o1", "open", waPhoneID))
	if rec.Code != 200 {
		t.Fatalf("code: %d", rec.Code)
	}
	if n := e.successOpens(t, channels.KindWhatsApp); n != 1 {
		t.Fatalf("open not audited: %d", n)
	}
	sent := e.wa.all()
	// "Opening Main gate..." text + a close-button interactive follow-up.
	if len(sent) != 2 || !strings.Contains(sent[0].body, "Opening Main gate") {
		t.Fatalf("open replies: %+v", sent)
	}
	if sent[1].interactive == nil || !strings.HasPrefix(sent[1].interactive.Action.Buttons[0].Reply.ID, "close_ap:") {
		t.Errorf("missing close button: %+v", sent[1])
	}
}

func TestWhatsAppPickerFlowMultipleGates(t *testing.T) {
	e := setupChannels(t, permissiveRL())
	ap2 := createAP(t, e.h, e.ownerA, e.loc, "Side door")

	// "open" with two gates in one location → a list picker (no open yet).
	rec := waPost(e.h, waTextMsg(testPhoneRaw, "wamid.p1", "open", waPhoneID))
	if rec.Code != 200 {
		t.Fatalf("code: %d", rec.Code)
	}
	sent := e.wa.all()
	if len(sent) != 1 || sent[0].interactive == nil || sent[0].interactive.Type != "list" {
		t.Fatalf("expected picker list: %+v", sent)
	}
	if len(sent[0].interactive.Action.Sections[0].Rows) != 2 {
		t.Fatalf("picker rows: %+v", sent[0].interactive.Action.Sections[0].Rows)
	}
	if n := e.successOpens(t, channels.KindWhatsApp); n != 0 {
		t.Fatalf("picker must not open yet: %d", n)
	}

	// user taps the second gate → open reaches the verdict.
	rec = waPost(e.h, waInteractiveMsg(testPhoneRaw, "wamid.p2", "open_ap:"+ap2, "Side door"))
	if rec.Code != 200 {
		t.Fatalf("selection code: %d", rec.Code)
	}
	if n := e.successOpens(t, channels.KindWhatsApp); n != 1 {
		t.Fatalf("selection open not audited: %d", n)
	}
}

func TestWhatsAppDedupeAndPhoneIDFilter(t *testing.T) {
	e := setupChannels(t, permissiveRL())

	// wrong phone_number_id → ignored, no reply, still 200.
	rec := waPost(e.h, waTextMsg(testPhoneRaw, "wamid.f1", "open", "OTHER_PHONE_ID"))
	if rec.Code != 200 || len(e.wa.all()) != 0 {
		t.Fatalf("phone id filter: %d %+v", rec.Code, e.wa.all())
	}

	// duplicate message id → processed once.
	body := waTextMsg(testPhoneRaw, "wamid.dup", "hi", waPhoneID)
	waPost(e.h, body)
	waPost(e.h, body)
	if len(e.wa.all()) != 1 {
		t.Fatalf("dedupe failed, replies: %d", len(e.wa.all()))
	}
}

func TestWhatsAppFloodThrottleGoesQuietStill200(t *testing.T) {
	rl := permissiveRL()
	rl.ChatMsgsPerMin = 2
	e := setupChannels(t, rl)

	// 3 distinct messages; past the cap the bot goes quiet but still 200s.
	for i, id := range []string{"wamid.t1", "wamid.t2", "wamid.t3"} {
		rec := waPost(e.h, waTextMsg(testPhoneRaw, id, "hi", waPhoneID))
		if rec.Code != 200 {
			t.Fatalf("msg %d code: %d", i, rec.Code)
		}
	}
	if got := len(e.wa.all()); got != 2 {
		t.Fatalf("throttle: want 2 replies (3rd quiet), got %d", got)
	}
}

func TestWhatsAppDeniedOpenIsHonest(t *testing.T) {
	rl := permissiveRL()
	rl.OpenCooldownS = 3600 // force the second open into cooldown
	e := setupChannels(t, rl)

	waPost(e.h, waTextMsg(testPhoneRaw, "wamid.d1", "open", waPhoneID)) // allowed
	e.wa.sent = nil
	waPost(e.h, waTextMsg(testPhoneRaw, "wamid.d2", "open", waPhoneID)) // denied by cooldown
	sent := e.wa.all()
	if len(sent) != 1 || !strings.Contains(sent[0].body, "Too many opens") {
		t.Fatalf("denied open must reply honestly: %+v", sent)
	}
}
