# Linking WhatsApp

WhatsApp is lintel's primary channel — and the one with genuinely hard setup, because
Meta gates it behind business verification. This chapter is what it takes to bring your
own number to your gateway. (If you want to be texting your gate *today*, start with
Slack — minutes, not days — and add WhatsApp when the WABA clears.)

Once linked, the flow is simple: residents text your number, Meta's Cloud API delivers
the webhook, and the gateway routes each message by its sender:

```
resident's message → Meta Cloud API → your gateway
                     └─ resolve (whatsapp, +27…) → memberships → location
```

Invite a member by phone number and they can text the gate immediately — WhatsApp is
their identity, not their configuration. The number residents should save is shown in
the portal under **Settings → Channels → WhatsApp**.

## Bring your own WABA

A gateway that wants a WhatsApp channel needs its own **Meta Cloud API** setup. This is
the high-friction channel — budget an afternoon and some patience:

1. **A Meta Business portfolio**, verified. Meta's business verification can take days
   and wants real documents.
2. **A WhatsApp Business Account (WABA)** inside it, created in the Meta developer
   console along with an app.
3. **A phone number** registered to the WABA. It must be able to receive a one-time
   verification call or SMS, and it stops working as a personal WhatsApp number.
4. **Webhook configuration** — point Meta at your gateway's public URL
   (`https://your-gate.example/webhooks/whatsapp`), set the verify token, and subscribe to
   the `messages` field.
5. **Credentials into the gateway** — the permanent access token, app secret and phone
   number id go in your gateway's `.env`. The gateway verifies every incoming webhook
   with Meta's HMAC signature; unsigned or mis-signed payloads are dropped.

One honest note for those who push through: Meta charges per-conversation fees on your
WABA and bills you directly — those costs are between you and Meta, never routed
through lintel. Slack takes minutes — see [Chat channels](channels.md) — and many
gateways run Slack-first, WhatsApp later or never.

## The alternative: a self-hosted bridge (opt-in, higher risk)

If the WABA process above is a dealbreaker, the gateway can instead talk to a
self-hosted, **unofficial** WhatsApp Web bridge (target: Evolution API, which fronts
Baileys) rather than Meta's Cloud API:

```sh
LINTEL_WHATSAPP_ENGINE=bridge
LINTEL_WHATSAPP_BRIDGE_URL=https://bridge.example.internal:8080
LINTEL_WHATSAPP_BRIDGE_API_KEY=…
LINTEL_WHATSAPP_BRIDGE_INSTANCE=…
```

This is opt-in only — leave `LINTEL_WHATSAPP_ENGINE` unset, misspell it, or use
anything but the exact string `bridge`, and the gateway falls back to the official
`cloud` engine. The reason it isn't the default: Meta actively detects and bans
automated/unofficial clients, and tightened its terms further on 2026-01-15 —
reported number survival on unofficial APIs is commonly **weeks, not years**.
Selecting `bridge` logs a startup warning naming this risk every time the gateway
starts.

**A banned number goes silent on WhatsApp, with no notice to residents.** The gateway
does not have a working offline fallback for that moment: the LAN/BLE emergency-grant
path described in [Emergency access](emergency-access.md) has real, conformance-tested
verification on both the controller side and the gateway's issuance side, but the app
doesn't hold or present a grant yet, so it is not what saves you here — don't rely on
it. What actually works today, right now:

- **The web portal** — unlimited opens through the gateway's own dashboard, no chat
  channel involved at all.
- **A second shipped chat channel** — Slack Socket Mode or Telegram (see
  [Chat channels](channels.md)) — so a WhatsApp ban doesn't mean *no way to text the
  gate*, just one fewer way.

Set one of those up and confirm it works **before** you turn `bridge` on. If neither is
acceptable, stick with the official Cloud API above, slow business-verification
process and all.

## Which number should residents see?

We recommend a **dedicated number** for the property rather
than someone's personal number: residents shouldn't see a personal profile photo and
status, and the number should survive a change of trustees.

## If the link fails

- **Webhook verification never completes** — Meta must be able to reach your gateway's
  public URL over HTTPS. If you're behind NAT, set up a tunnel first
  ([Run a gateway → Reachability](self-host.md)).
- **Messages arrive but are rejected** — check the app secret: the gateway fail-closes
  on webhook signature mismatch and logs `whatsapp: bad signature` to the audit log.
- **The number won't register** — numbers already bound to a personal WhatsApp account
  must be released first, and some virtual/VoIP numbers can't receive Meta's
  verification call. A cheap prepaid SIM is the boring, reliable answer.
