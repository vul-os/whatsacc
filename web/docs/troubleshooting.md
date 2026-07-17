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

**The bot says "Too many opens — try again in ~2 min."**
You hit a built-in rate limit: the per-access-point cooldown (default 10 s between
opens) or the hourly cap (default 30 opens/member, 500/account). These protect
against runaway scripts, not people — waiting the stated time always clears it. The
gateway operator tunes them via the `RATE_*` env vars; see
[Rate limits & quotas](limits.md).

**The bot says "Daily limit reached for this location."**
An admin set a per-member or per-location daily quota (UTC day) on that location.
This applies to every channel — chat, portal and API alike — so switching channels
won't help. Ask an admin: they can raise or clear it under the location's **Limits**
page, and admins themselves are exempt from quotas, so they can always let you in.

**I sent several messages and the bot just went quiet.**
The chat flood throttle (default 10 messages/min per sender). It resets within a
minute; slow down. Gate state was never touched — this only silences replies.

## Webhooks

**Meta webhook verification never completes.**
Meta must reach your URL over valid HTTPS. Check the verify token matches your `.env`,
and that the tunnel/proxy passes `GET` challenges through untouched.

**Events arrive but the audit log shows `bad signature`.**
Your app secret / signing secret is wrong or rotated. The gateway fail-closes on
signature mismatch by design. Paste the current secret into `.env` and restart.

## API

**The API returns `429 Too Many Requests`.**
Your call was denied by a rate limit (`rate_limited`) or an admin-set daily quota
(`quota_exceeded`) — the body carries the reason and the `Retry-After` header says
how many seconds until a retry can succeed; honour it instead of hammering. The
attempt was audit-logged, and a denied open never consumes quota or a visitor-pass
use. Persistent 429s from an integration usually mean the account ceiling
(`RATE_ACCOUNT_OPENS_PER_HOUR`, default 500) needs raising, or a quota needs a
second look on the location's **Limits** page — see
[Rate limits & quotas](limits.md).

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
