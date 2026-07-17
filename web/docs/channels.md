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
| Slack | member id | Shipped | Minutes — an app manifest + signing secret |
| Discord | user id | **Coming** | Minutes — a bot token |

## WhatsApp (Meta Cloud API)

The primary channel, and the hard one to self-host. The short version:

1. Verified Meta Business portfolio → WhatsApp Business Account (WABA) → registered
   phone number.
2. Point Meta's webhook at `https://your-gate.example/hooks/whatsapp` with your verify
   token; subscribe to `messages`.
3. Put the permanent token, app secret and phone-number id in the gateway's `.env`.

The gateway verifies Meta's HMAC signature on every webhook and drops anything that
fails. Replies use the Cloud API send endpoint — including interactive numbered lists
for gate pickers.

The full walkthrough, including number advice and failure modes, is in
[Linking WhatsApp](linking-whatsapp.md).

## Slack

The five-minute channel, and the recommended first channel for self-hosters:

1. Create a Slack app from a manifest at api.slack.com — the gateway repo ships a
   ready-made `slack.yml` that requests the message events and chat scopes.
2. Point the app's **Events API** request URL at
   `https://your-gate.example/hooks/slack`. Slack sends a challenge; the gateway
   answers it automatically.
3. Configure the gateway:

```sh
WACC_CHANNEL_SLACK_BOT_TOKEN=xoxb-…
WACC_CHANNEL_SLACK_SIGNING_SECRET=…
```

Every incoming event is verified against the signing secret (Slack's signed-request
scheme, timestamp-checked against replay); anything unverifiable is dropped and logged.

No public URL? Use **Socket Mode** instead of the Events API: the gateway dials out to
Slack over an outbound WebSocket, so a LAN-only gateway with no reachable address still
receives every message. Enable it in the app manifest and give the gateway the
app-level token (`WACC_CHANNEL_SLACK_APP_TOKEN`).

Residents then DM the app — or use a channel you allow — with `open`. Their Slack
member id is their identity; invite members from the portal's **Members** page by id or
with a one-time link. Workspaces map naturally onto complexes and offices, which makes
Slack a favourite for gated workplaces and co-working spaces.

Slack replies support the same numbered pickers and quota warnings as WhatsApp.

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
deliberately: an error would make Meta or Slack retry and amplify the flood. Going
quiet only silences replies; gate opens are governed separately by the open limits in
[Rate limits & quotas](limits.md), and denials of actual open attempts always get an
honest reply rather than silence.

## Writing a new channel

The seam is deliberately small: resolve sender → identity, message → intent, reply →
send. If you want Telegram or Signal or SMS, the Slack implementation is the reference
to copy. Contributions welcome — the gateway is MIT.
