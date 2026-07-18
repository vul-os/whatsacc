# Linking WhatsApp

WhatsApp is whatsacc's primary channel — and the one with genuinely hard setup, because
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
through whatsacc. Slack takes minutes — see [Chat channels](channels.md) — and many
gateways run Slack-first, WhatsApp later or never.

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
