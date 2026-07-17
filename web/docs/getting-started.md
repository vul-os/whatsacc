# Getting started

This chapter walks the **hosted flagship** path: your gate on whatsacc.com, residents
texting our WhatsApp number, nothing for you to deploy. If you'd rather run your own
gateway, jump to [Run a gateway](self-host.md) — the concepts below still apply.

whatsacc gets you from "I'd like to text my gate open" to actually doing it in about an
evening, assuming the controller hardware is mounted.

## What you'll need

- A gate, door or barrier with a **dry-contact relay input** (most motors have one).
- A whatsacc controller, or a supported Pi-class board running the controller agent.
- A phone with WhatsApp — the flagship's primary channel. Slack works too.
- Ten minutes of ladder time to wire the controller in parallel with your existing motor.

You do **not** need your own WhatsApp business number on the flagship. That's the point
of the flagship: residents text *whatsacc's* number, and the gateway routes by sender.

## The five steps

1. **Create an account** at the [portal](https://whatsacc.com/portal). The free tier is
   real — one location, one controller, a monthly cap on opens, no credit card.
2. **Name your location** during onboarding — house, complex, building or other. Give it
   a name residents will recognise, and optionally drop a map pin: that pin anchors the
   geofence if you enable it later.
3. **Add an access point** under **Access points → New**. Main gate, pedestrian gate,
   parking barrier — each is a separate access point, and each gets its own controller.
4. **Pair a controller.** Portal → **Devices → Pair new** creates a claim token; the
   controller redeems it and pins the gateway's signing key. Full walkthrough in
   [Controllers](controllers.md).
5. **Invite yourself as a member** under **Members**, then send your first `open` to
   the flagship number shown in the portal. The reply tells you what happened, in plain
   language.

## Members and roles

Members are people whose chat identity can text the gate. An identity is a
`(channel, external id)` pair — a WhatsApp phone number, a Slack member id — so one
person can be reachable on more than one channel.

- **Owner** — the account holder. Billing and danger-zone settings.
- **Admin** — manages devices, members and policies for assigned locations.
- **Member** — can open what they've been given. Can't change settings.
- **Guest** — like a member, but time-bound. Contractors and weekend visitors live under
  **Temp access** in the portal, and their access expires on its own.

A role on a complex applies to all access points within it unless overridden. Revoking is
immediate: open the member, hit revoke, and the next message they send is declined. The
audit log keeps the history — revocation is not deletion.

## A note on trigger words

The default trigger is `open`, but the gateway accepts any phrase you configure per
location. People text things like *oop*, *hey gate*, *buzz me in*, or a single 👍. If
it's on your allow-list, it works. When a member has access to several access points,
the reply is a numbered picker — they answer `1`, `2` or `3`.

## Next

- [Linking WhatsApp](linking-whatsapp.md) — how numbers, identities and the flagship
  number fit together (and what changes when you self-host).
- [Controllers](controllers.md) — wiring and pairing.
- [Billing & tiers](billing.md) — what the free tier caps, what Pro adds.
