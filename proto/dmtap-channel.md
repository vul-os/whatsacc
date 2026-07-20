# DMTAP channel binding — v0 DRAFT, NOT IMPLEMENTED

> **Status: draft.** This contract describes what a real DMTAP dial-out channel
> binding would look like. **No implementation exists.** The gateway ships a
> structurally complete scaffold for it (`gateway/internal/channels/dmtap.go`,
> `channels.DialChannel` + `channels.DMTAPTransport`) with exactly one
> `DMTAPTransport`: `NotImplementedTransport`, which always fails closed. This
> file is a proposal for the shape a real transport would speak, written down
> so it can be reviewed and revised before code is built against it — not a
> record of something running. Do not treat anything below as available in the
> gateway today.

## Why this exists

DMTAP ([spec](https://github.com/vul-os/dmtap), [reference implementation](https://github.com/vul-os/envoir))
is attractive as a lintel channel because a MOTE is MLS-authenticated end to
end: an "open" command signed by the member's own DMTAP identity key, with no
third party in the delivery path and none of WhatsApp Cloud API's per-message
cost or 24-hour-window / template restrictions on gateway-initiated replies.

## What actually exists today (investigated 2026-07-20)

The Go binding at `github.com/vul-os/envoir/bindings/go` (wazero/wasm, no
cgo) wraps **only** the `dmtap-sync` crate: the CRDT sync algebra (HLC
clocks, the six-kind op algebra, COSE_Sign1 signing/verification, observable
state, snapshots, version vectors, range-Merkle reconciliation). Its own
README says so; its exported API (`bindings/go/api.go`) confirms it — every
method is `Value`/`Op`/`Clock`/`Engine`/`Snapshot`/`FastJoin`/`Reconcile`
shaped. There is no MOTE construction, no MLS group session, no identity
resolution, and no network I/O of any kind in that package — the wasm module
itself imports nothing (no WASI, no clock, no filesystem, no randomness),
which is a deliberate, tested security property of that package, not a gap
to fill.

The pieces a real channel would need exist only in Rust, with no Go binding:

- **MOTE construction + HPKE sealing** — `envoir/crates/dmtap-core`.
- **MLS group sessions** (where a signed member-authenticated command would
  come from) — `envoir/crates/dmtap-mls`.
- **A running node's HTTP surface** — `envoir/node/src/{send_api,jmap_api}.rs`.
  `send_api.rs` is a Resend-style outbound **mail** send (`POST /v1/send`,
  subject + body to a resolved recipient address), not a group-chat/command
  protocol, and has no Go client in this repo either. `jmap_api.rs` exposes
  JMAP, which is a mail-sync protocol, not group messaging.

Neither `dmtap-mls` group commands nor a chat-style push/pull surface for
group messages currently exists in a form this gateway (or any Go process)
can call.

## Two integration shapes, either would work, neither started

1. **A second wazero binding** alongside `bindings/go`, exposing MOTE
   construction/sealing and MLS group operations the same in-process,
   no-cgo way `dmtap-sync` is exposed today. Keeps the gateway dependency-free
   (pure Go, single static binary) at the cost of building and maintaining
   that binding.
2. **An HTTP client dialing a locally-run `envoir-node` daemon.** The same
   shape `HTTPWhatsAppSender` / `HTTPSlackSender` / `HTTPTelegramSender`
   already use for their providers (`gateway/internal/channels/send.go`):
   the gateway process talks to a sidecar it does not embed. Requires the
   operator to also run `envoir-node`, and requires a poll or push
   subscription for inbound (no such endpoint exists on the node today), plus
   a real mapping from "a MOTE arrived in an access-control group" to "a
   signed open command" — DMTAP is generic end-to-end messaging today, not a
   gate-command protocol, so that mapping is itself unspecified.

This document assumes shape (2) for concreteness (an HTTP transport is the
easier one to keep the gateway's no-cgo, single-binary property), but nothing
here is settled.

## Proposed wire shapes (NOT IMPLEMENTED)

### Inbound: an intent the transport hands to `DMTAP.Handle`

Maps directly onto `channels.DMTAPIntent` (`gateway/internal/channels/dmtap.go`):

```json
{
  "member_key_name": "correct-horse-battery-staple-...",
  "group_id": "grp_...",
  "body": "open",
  "intent_id": "mote_<content-address>",
  "ts_ms": 1789000000000
}
```

- `member_key_name` is the DMTAP 8-word key-name (spec §3.9.1) the MLS session
  has already authenticated as the sender — the transport's job, not this
  gateway's, exactly as `Verify` authenticates a WhatsApp/Slack/Telegram
  webhook before its body is trusted.
- `intent_id` SHOULD be the MOTE's content address (spec §2.2), so
  redelivery dedupes the same way `wamid`/Telegram `message_id` already do
  (`store.InsertInboundMessage`'s unique index).
- The gateway never sees DMTAP ciphertext or key material — only the
  MLS-decrypted plaintext body, matching the transport-owns-crypto boundary
  the `dmtap-sync` Go binding's own signer contract already draws (no entry
  point there accepts key material either).

### Outbound: a reply the gateway asks the transport to send

Maps onto `channels.DMTAPReply`:

```json
{ "text": "Opening Main gate..." }
```

Sent via `DMTAPTransport.Reply(ctx, group_id, reply)`. DMTAP has no
interactive-UI concept in the spec today (unlike WhatsApp lists / Slack
blocks / Telegram inline keyboards) — plaintext only, one MOTE per reply,
sealed to the group under the transport's own session.

### Signed-command `cause` (existing contract, additive)

[`commands.md`](commands.md)'s `cmd` envelope already carries
`cause.channel` as a free string (`"whatsapp"`, `"slack"`, `"telegram"` are
the values in use today; no schema change needed). Once a real DMTAP
transport exists, `"dmtap"` is the value it would use — the gateway already
has the constant (`channels.KindDMTAP`) and the audit-log/chat-log storage
for it (`gateway/internal/store/migrations/0005_channels.sql`'s `channel`
columns are unconstrained `TEXT`, not an enum), so nothing in the store or
the signed-command contract needs to change to onboard it. What is missing is
entirely the transport in the two paragraphs above.

## Non-goals of this draft

- **Not** a DMTAP protocol specification — the normative spec is
  [`../dmtap`](https://github.com/vul-os/dmtap) (see spec §2 MOTE, §5
  messaging). This file only describes the gateway-side binding contract.
- **Not** a commitment to shape (1) vs (2) above.
- **Not** a claim that `dmtap-mls` group semantics map cleanly onto "an
  access-control command" — that mapping needs its own design pass (likely a
  spec addition) before either integration shape is worth building.
