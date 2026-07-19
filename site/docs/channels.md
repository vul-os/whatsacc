# Chat channels

Chat is the product. The gateway exposes a **channel seam** — a small interface that
resolves a sender to an identity, turns a message into an intent (`open`, a picker
reply, a visitor-pass request), and sends replies. Everything behind the seam (rules,
signing, audit) is channel-agnostic.

Identity is keyed on `(channel, external id)` — not phone-number-only — so one person
can be reachable on WhatsApp and Slack at once without being two people in your
records.

| Channel | Identity | Status | Self-host friction |
| --- | --- | --- | --- |
| WhatsApp | phone number | Shipped | **High** — verified Meta business + WABA + number |
| Slack | member id | Shipped — Events API **and Socket Mode** | Minutes — an app manifest + signing secret |
| Telegram | chat id | Shipped — opens wired through the shared pipeline | Minutes — a BotFather token + webhook secret |
| Discord | user id | **Coming** | Minutes — a bot token |

## WhatsApp (Meta Cloud API)

The primary channel, and the hard one to self-host. The short version:

1. Verified Meta Business portfolio → WhatsApp Business Account (WABA) → registered
   phone number.
2. Point Meta's webhook at `https://your-gate.example/webhooks/whatsapp` with your verify
   token; subscribe to `messages`.
3. Put the permanent token, app secret and phone-number id in the gateway's `.env`.

The gateway verifies Meta's HMAC signature on every webhook and drops anything that
fails. Replies use the Cloud API send endpoint — including interactive numbered lists
for gate pickers.

The full walkthrough, including number advice and failure modes, is in
[Linking WhatsApp](linking-whatsapp.md). WhatsApp is the one channel that always needs
a public HTTPS endpoint — Meta's Cloud API only speaks webhooks, there is no
alternative — see [Ingress & reachability](ingress.md) for the honest options (public
bind, any tunnel including a self-hosted `vulos-relayd`, or the paid Vulos Relay
convenience).

## Slack

The five-minute channel, and the recommended first channel for self-hosters:

1. Create a Slack app from a manifest at api.slack.com. This one requests exactly
   what the gateway uses — message events, mentions, interactivity for the gate
   buttons, and `chat:write` for replies (substitute your gateway's URL):

   ```yaml
   display_information:
     name: whatsacc
     description: Text your gate open
   features:
     bot_user:
       display_name: whatsacc
       always_online: true
     shortcuts:
       - name: Open a gate
         type: global
         callback_id: open_gates_shortcut
         description: Pick one of your gates to open
   oauth_config:
     scopes:
       bot:
         - chat:write
         - im:history
         - channels:history
         - app_mentions:read
   settings:
     event_subscriptions:
       request_url: https://your-gate.example/webhooks/slack
       bot_events:
         - message.im
         - message.channels
         - app_mention
     interactivity:
       is_enabled: true
       request_url: https://your-gate.example/webhooks/slack/interactions
   ```

2. The **Events API** request URL is `https://your-gate.example/webhooks/slack`
   (interactive button clicks arrive at `/webhooks/slack/interactions`). Slack
   sends a challenge; the gateway answers it automatically.
3. Configure the gateway:

```sh
SLACK_BOT_TOKEN=xoxb-…
SLACK_SIGNING_SECRET=…
```

Every incoming event is verified against the signing secret (Slack's signed-request
scheme, timestamp-checked against replay, with a 300 s window; requests missing the
signature or timestamp headers are never skipped); anything unverifiable is dropped
and logged.

### Socket Mode — the zero-URL install

**Socket Mode is shipped.** Set `SLACK_APP_TOKEN` to an app-level token (`xapp-…`) and
the gateway **dials out** to Slack over a single outbound WebSocket
(`apps.connections.open` → `wss://…`) instead of receiving webhooks — it acks each
envelope and feeds the payload through the *same* handlers the Events API webhook uses.
A gateway on a LAN with **no public URL at all** runs Slack fully: this is what makes
"a Pi on the estate LAN is a complete installation" real. Enable Socket Mode in the app
manifest, mint the app-level token, and set:

```sh
SLACK_APP_TOKEN=xapp-…   # optional — presence enables Socket Mode (no public URL needed)
```

With no `SLACK_APP_TOKEN`, the gateway stays on the Events API webhook
(`/webhooks/slack`), which needs a reachable URL. Either mode works; Socket Mode is the
one that needs zero ingress — see [Ingress & reachability](ingress.md).

Residents then DM the app — or use a channel you allow — with `open`. Their Slack
member id is their identity; invite members from the portal's **Members** page by id or
with a one-time link. Workspaces map naturally onto complexes and offices, which makes
Slack a favourite for gated workplaces and co-working spaces.

Slack replies support the same numbered pickers and quota warnings as WhatsApp.

## Telegram

Telegram is wired to the **real open path** in the Go gateway — it exceeds the older
Workers backend, where Telegram was an honest stub that only logged and acknowledged:

- **What works now** — the gateway receives updates on `/webhooks/telegram`,
  verifying the `X-Telegram-Bot-Api-Secret-Token` header against your configured
  webhook secret (mismatches are rejected). A linked user texting `open` runs the
  **same rules-and-signing pipeline** as every other channel: identity resolution,
  time windows, quotas, then the Ed25519-signed command to the controller. When several
  gates are available the reply is an **inline-keyboard picker**, and tapping a button
  re-enters the same verdict path. Every chat and message is recorded and the shared
  per-sender flood throttle applies.

Long-polling (`getUpdates`) — an entirely outbound alternative that needs **no public
URL at all** — is on the roadmap for this channel; today's wiring is the webhook path
below, so Telegram currently needs a reachable URL. See
[Ingress & reachability](ingress.md).

Setup:

1. Create a bot with **@BotFather** and keep the bot token.
2. Register the webhook with a secret:
   `https://api.telegram.org/bot<token>/setWebhook?url=https://your-gate.example/webhooks/telegram&secret_token=<secret>`.
3. Configure the gateway:

```sh
TELEGRAM_BOT_TOKEN=123456:ABC-…
TELEGRAM_WEBHOOK_SECRET=…   # must match the secret_token you registered
```

## Discord — coming

The Discord channel (bot token, identity by user id) is designed into the channel seam
but **not shipped yet**. It is roadmap, not vaporware-in-fine-print: when it lands,
setup will be a bot token and an invite link, mirroring Slack's minutes-not-days flow.
Track progress on [GitHub](https://github.com/vul-os/whatsacc).

## Trigger words and pickers

- Default trigger: `open`. Per-location allow-lists accept any phrase — *oop*,
  *hey gate*, 👍.
- One access point → the gate just opens.
- Several access points → the reply is a numbered picker; the member answers `1`/`2`/`3`.
- Quota warnings appear when an admin has set a daily open quota on the location;
  denials say so honestly and link to the web portal — see
  [Rate limits & quotas](limits.md).

## Flood protection

Every channel shares one throttle: past 10 inbound messages per minute from the same
sender (tunable via `RATE_CHAT_MSGS_PER_MIN`), **the bot goes quiet** — it stops
replying until the minute window rolls over. The webhook itself still answers `200`,
deliberately: an error would make Meta, Slack or Telegram retry and amplify the flood.
Going
quiet only silences replies; gate opens are governed separately by the open limits in
[Rate limits & quotas](limits.md), and denials of actual open attempts always get an
honest reply rather than silence.

## Writing a new channel

The seam is deliberately small: resolve sender → identity, message → intent, reply →
send. Every open on every channel funnels through the one open-path choke point — a
channel decides how to ask and how to reply, never whether the gate may open. If you
want Signal or SMS, the three shipped channels (WhatsApp, Slack, Telegram) are the
reference to copy. Contributions welcome — the gateway is MIT.
