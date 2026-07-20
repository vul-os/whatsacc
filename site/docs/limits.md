# Rate limits & quotas

A gate that opens on a text message needs a speed limit. This chapter covers the two
layers that provide one: **rate limits** (always on, operator-tunable) and **quotas**
(off by default, set per location by admins). One honest line first: these exist for
abuse protection — a runaway script, a stolen phone, a flood of webhooks — and for
nothing else. lintel has no billing, so no limit here is ever about money.

## The two layers

1. **Rate limits** protect the *system*: cooldowns and hourly ceilings that stop any
   one identity — or the whole account — from hammering the gate. Always on, tuned by
   the gateway operator.
2. **Quotas** express *policy*: "the cleaner can open four times a day." Optional,
   per-location, set by admins in the portal. Off until you set one.

Both are enforced at a single choke point that every open path funnels through —
portal, API, WhatsApp, Slack, Telegram — so picking a different channel never bypasses
them.
`close` commands are **never** limited: closing a gate is the safe direction and is
never refused.

## Built-in rate limits

| Limit | Env var | Default | What it protects against |
| --- | --- | --- | --- |
| Open cooldown | `RATE_OPEN_COOLDOWN_S` | 10 s | Double-taps and jittery scripts: minimum gap between successful opens by the same person at the same access point |
| Opens per member | `RATE_OPENS_PER_HOUR` | 30 / hour | One identity gone runaway — a looping automation on a member's token or number |
| Opens per account | `RATE_ACCOUNT_OPENS_PER_HOUR` | 500 / hour | A runaway integration: ceiling across the whole account, all members combined |
| Chat flood | `RATE_CHAT_MSGS_PER_MIN` | 10 / min | A sender flooding the bot: past this, the bot goes quiet for the rest of the minute (see [Chat channels](channels.md)) |

Semantics worth knowing:

- **Zero is meaningful.** `RATE_OPEN_COOLDOWN_S=0` disables the cooldown. On the
  caps, `0` blocks everything — a deliberate kill switch if an account is misbehaving.
  A missing or malformed value falls back to the default; a limit can never be
  accidentally unset by a typo.
- Hourly and daily windows are fixed, UTC-aligned windows. A denial always says how
  long until a retry can succeed.
- The operator can also override any of these at runtime through the gateway's admin
  limits endpoint; resolution is *runtime override → env var → built-in default*.

## Admin quotas

Quotas live per location, under the location's **Limits** page in the portal. There are
exactly two:

- **Opens per member per day** — each member (or visitor phone number) at this
  location, per UTC day.
- **Opens per location per day** — total across the whole location, per UTC day.

Leave either blank for unlimited; both are off by default. The rules, all deliberate:

- Quotas apply to **every** open path — chat, portal, API — for consistency.
- **Account owners and admins are exempt from quotas, but not from rate limits.** An
  admin can always let the plumber in; a runaway admin script still hits the cooldown
  and hourly caps.
- Admin opens still count toward the location's daily total — they are real gate
  movements — they just cannot be *denied* by a quota.
- Only **successful** opens consume a counter. Denied attempts count nothing, so the
  numbers the portal shows ("3 of 4 opens used", with a per-member breakdown for
  admins) are honest usage figures, and match exactly what the limiter enforces.

## What a denied person sees

Denials are honest, everywhere:

- **In chat**, the bot says why: *"Too many opens — try again in ~2 min."* for a rate
  limit, or *"Daily limit reached for this location — contact your admin."* with a
  portal link for a quota. No silent drops.
- **On the API**, the request gets `429 Too Many Requests` with a `Retry-After`
  header (seconds) and a reason of `rate_limited` or `quota_exceeded`.
- **Every denial is written to the audit log** — same transaction as the decision,
  with the reason — so admins can see who was bounced and when.
- **Visitor passes are refunded**: if a visitor's grant use is consumed and the open
  is then denied by a limit, the use is given back. A denied attempt never burns a
  visitor's pass.

## When the counter store fails

If the limiter's counter store errors, the open is **allowed**, and the success entry
in the audit log is tagged `rate_limit_check_failed`. This is a deliberate design
choice, stated plainly: a gate is physical access, and locking residents out because a
bookkeeping table hiccuped is the worse failure. Availability wins for *enforcement*;
*visibility* is preserved — the tag makes every degraded decision findable in the
audit log. (Contrast with webhook signature checks, which fail closed: a forged
command is worse than a missed rate limit.)

## Tuning for your property

- **Estates and complexes**: the defaults fit. A busy visitor gate is the one thing to
  watch — visitor opens count against the *location* daily quota if you set one, so
  either leave that quota off or size it for your gate's real traffic. A per-member
  daily quota of 4–10 is a common policy for domestic staff and contractors.
- **Offices and co-working**: the 9 a.m. rush is fine — the cooldown is per person,
  per access point, so forty people opening one door in ten minutes never collide.
  Large workspaces on one account should raise `RATE_ACCOUNT_OPENS_PER_HOUR` before
  they hit the 500/hour ceiling.
- **Integrations**: anything scripted (a bookings system opening for arrivals) counts
  against the account ceiling — budget for it, and give the script its own identity so
  its per-member cap is tuned independently.
- **Emergencies**: to freeze opens entirely, set a cap to `0` (kill switch). To loosen
  in a hurry, the runtime override applies without a restart.
