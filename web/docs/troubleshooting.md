# Troubleshooting

The short list of things that actually go wrong, and what to do about each.

## Chat

**I text `open` and get no reply at all.**
The gateway never got the message. First check you're texting the number (or Slack app)
shown in the portal under **Settings → Channels**. Then check the channel is actually
reaching your gateway — verify your public URL is up
(`curl https://your-gate.example/healthz`), and re-check the webhook URL in the
Meta/Slack console. Tunnel users: is the tunnel actually connected? Slack Socket Mode
users: does the gateway log show the socket connected?

**I get "I don't recognise this number/account".**
Your chat identity isn't a member anywhere on this gateway. An admin adds you under
**Members** — for WhatsApp by phone number (exact international format, `+27…`), for
Slack by member id or invite link.

**Replies arrive but the gate doesn't move.**
Look at the reply — whatsacc always says why. `outside geofence (4.2 km)` means the
geofence declined you; share your live location or get closer. `outside your access
window` is a time-window rule. If it says *opened* and nothing moved, it's a wiring or
controller issue — see below.

**"You have 0 opens left this month."**
An admin set a per-member open quota on your membership (an access rule, like time
windows). The web portal keeps working (it is never quota-limited), or ask an admin to
raise the quota under **Members**.

## Webhooks

**Meta webhook verification never completes.**
Meta must reach your URL over valid HTTPS. Check the verify token matches your `.env`,
and that the tunnel/proxy passes `GET` challenges through untouched.

**Events arrive but the audit log shows `bad signature`.**
Your app secret / signing secret is wrong or rotated. The gateway fail-closes on
signature mismatch by design. Paste the current secret into `.env` and restart.

## Controllers

**LED pulsing orange forever.**
The controller can't reach the gateway: wrong Wi-Fi credentials, dead SIM, or the
gateway URL from pairing is unreachable. It dials out on 443 — most networks just work;
captive-portal Wi-Fi doesn't.

**LED red.**
Signature verification failure — the controller is refusing commands. This happens
when a gateway was restored **without** its original keys ([see backup
notes](self-host.md)). Re-pair the controller with a fresh claim.

**Test pulse works, the remote-style open doesn't (or vice versa).**
Wiring. The controller relay must sit in parallel with the receiver relay on the same
`COM`/`NO` pair — see [Controllers](controllers.md).

**Controller shows offline in the portal but the gate still opens locally.**
Expected: your existing remotes and the app's emergency path don't need the gateway.
Fix the connectivity at the gate (Wi-Fi signal at the motor is the usual suspect).

## The app

**Emergency screen says "no controller in range".**
BLE range is tens of meters — stand at the gate. On LAN discovery, phone and controller
must be on the same network. Also confirm the controller was paired to the gateway your
app is signed into.

**"Grant expired."**
Grants are short-lived on purpose. Open the app anywhere with connectivity and it
refreshes silently; then the offline path works again.

## Gateway

**It won't start after an upgrade.**
Read the first log lines — schema migrations run at boot and say what they did.
Downgrades aren't supported; restore your pre-upgrade backup of the data directory
instead.

**I restored a backup and every controller went red.**
The backup didn't include the key material next to `whatsacc.db`. Restore the full
data directory, or re-pair each controller.

Still stuck? Open a [GitHub issue](https://github.com/vul-os/whatsacc) — or mail
hello@whatsacc.com.
