# Getting started

whatsacc gets you from "I'd like to text my gate open" to actually doing it in about an
evening, assuming the controller hardware is mounted. Everything runs on your own
gateway — there is no hosted service and nothing to sign up for. This chapter is the
short path; [Run a gateway](self-host.md) has the full install, reachability and backup
detail.

## What you'll need

- A gate, door or barrier with a **dry-contact relay input** (most motors have one).
- A whatsacc controller, or a supported Pi-class board running the controller agent.
- Somewhere for the gateway to live: a VPS, a Pi, any always-on box. Docker or a bare
  binary — your call.
- A chat channel to bring: a Slack workspace is the five-minute start; WhatsApp needs
  your own Meta business number (a WABA) — see [Chat channels](channels.md).
- Ten minutes of ladder time to wire the controller in parallel with your existing motor.

## The six steps

1. **Run the gateway.** One binary, one SQLite file, portal embedded:

   > **Status — gateway in development.** The single-binary Go gateway is in
   > development. Today the reference implementation runs as the Workers backend in
   > this repo (`backend/` — see the repo README for dev setup); the commands below
   > describe the target install experience and will go live with the gateway.

   ```sh
   docker run -d --name whatsacc \
     -p 8080:8080 -v whatsacc:/data \
     ghcr.io/vul-os/whatsacc-gateway
   ```

   Or grab the release binary — `./whatsacc-gateway --data /var/lib/whatsacc`. Details,
   reachability options and backups in [Run a gateway](self-host.md).
2. **Claim the admin account.** Open the portal and sign up — the first account you
   create is the owner account. If you're also the person *running* the gateway,
   claim the **instance admin** seat too: set `ADMIN_CLAIM_TOKEN` in the environment
   before first boot, then redeem it exactly once against `POST /admin/claim`, as
   described in [Instance admin](admin.md).
3. **Name your location** — house, complex, building or other. Give it a name residents
   will recognise, and optionally drop a map pin: that pin anchors the geofence if you
   enable it later. Then add an access point under **Access points → New** — main gate,
   pedestrian gate, parking barrier; each gets its own controller.
4. **Pair a controller.** Portal → **Devices → Pair new** creates a claim token; the
   controller redeems it and pins the gateway's signing key. Full walkthrough in
   [Controllers](controllers.md).
5. **Link a channel.** Slack first is the pragmatic order: an app manifest and a signing
   secret, minutes not days ([Chat channels](channels.md)). WhatsApp when your WABA is
   ready ([Linking WhatsApp](linking-whatsapp.md)).
6. **Invite yourself as a member** under **Members**, then send your first `open` to
   your gateway's number or Slack app. The reply tells you what happened, in plain
   language.

## Members and roles

Members are people whose chat identity can text the gate. An identity is a
`(channel, external id)` pair — a WhatsApp phone number, a Slack member id — so one
person can be reachable on more than one channel.

- **Owner** — the account holder. Account and danger-zone settings.
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

- [Run a gateway](self-host.md) — install options, reachability, backup and restore.
- [Chat channels](channels.md) — Slack in minutes, the channel seam, Discord roadmap.
- [Linking WhatsApp](linking-whatsapp.md) — bringing your own number and WABA.
- [Controllers](controllers.md) — wiring and pairing.
