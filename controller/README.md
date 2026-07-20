# lintel controller — reference implementation

The reference controller agent: it runs on a Raspberry Pi (or any Linux box)
at a physical gate, is owned by exactly one gateway, and drives a gate relay.
Everything it actuates is a signed command from its paired gateway; it also
opens the gate **offline** (no internet, no gateway, no Meta) by verifying
pre-issued grants against its pinned gateway key.

> **Status: reference implementation. GPIO and BLE radio are stubbed** — see
> [What is real vs stubbed](#what-is-real-vs-stubbed). The protocol logic
> (verification, framing, offline grants, event queue, transport) is real and
> conformance-tested against `proto/vectors/`.

This is its **own Go module** (`github.com/vul-os/lintel/controller`) so it
can be vendored onto devices without dragging in the gateway. It deliberately
**copies** the small JCS + Ed25519 verify code from `gateway/internal/keys`
rather than importing it — see [Code duplication](#code-duplication).

Std-lib first, no CGO. The only third-party dependency is
`tinygo.org/x/bluetooth`, and it is compiled in **only** under `-tags ble`;
default builds have zero external dependencies.

## Layout

```
controller/
  go.mod                         # module github.com/vul-os/lintel/controller (Go 1.22+)
  cmd/
    controller/                  # the agent binary
    controller-sim/              # interactive/scriptable simulator + demos
  internal/
    jcs/                         # RFC 8785 canonical JSON (copied+adapted from gateway)
    wire/                        # v0 wire types + signing rule (Sign/Verify/VerifyRaw), ws.auth
    identity/                    # Ed25519 device key, generated first boot, 0600
    state/                       # durable pairing (PINNED gateway key), lockdown, config, last-sync
    clock/                       # gateway-synced, monotonic-advanced clock
    noncestore/                  # persistent, bounded (1024) replay store, fail-closed
    relay/                       # actuation seam: Relay/Sensors iface, Mock + gpio build-tag stub
    command/                     # fail-closed command verification + actuation + cmd.ack + events
    grants/                      # offline-grant verification core (11-step, shared by LAN + BLE)
    framing/                     # BLE 4-byte LE length-prefix chunker/reassembler (8 KiB cap)
    blesession/                  # open→challenge→proof→result sequencing over framing + grants
    bleperiph/                   # BLE GATT peripheral (real glue behind `-tags ble` on Linux)
    lanserver/                   # LAN HTTP grant transport + mDNS advertise
    mdns/                        # minimal std-lib _lintel._tcp responder
    events/                      # durable event queue (JSONL ring, reserved grant partition) + Recorder
    transport/                   # RFC 6455 WSS client, ws.auth, backoff, long-poll fallback, runner
    pairing/                     # claim-token redeem client (pins gateway key)
    agent/                       # wires it all together (used by both binaries)
    vectorfile/                  # loads proto/vectors/*.json (tests + sim demos)
```

## What is real vs stubbed

| Area | Status |
| --- | --- |
| Command verification (sig, addressing, window±skew, nonce replay, lockdown matrix) | **Real**, conformance-tested |
| cmd.ack / event signing (JCS + Ed25519) | **Real**, reproduces vector signatures byte-for-byte |
| Offline grant verification (11-step, stale-clock, windows, cnonce single-use) | **Real**, conformance-tested |
| Pairing redeem + gateway-key pinning + repair rotation | **Real**, tested against an httptest fake gateway |
| Durable event queue (ring + reserved grant partition, crash-safe) | **Real**, kill/reload tested |
| WSS transport (RFC 6455 client, challenge/auth, backoff, long-poll) | **Real**, tested against a fake WS gateway |
| mDNS `_lintel._tcp` advertise + LAN HTTP grant transport | **Real** |
| BLE **framing codec + session + verification** | **Real**, unit-tested at MTUs 23/185/512 |
| BLE **radio** (GATT peripheral) | **Stub** — real BlueZ glue under `-tags ble` on Linux, **not hardware-validated**; `ErrUnsupported` elsewhere |
| **GPIO relay driver** | **Stub** — `-tags gpio` scaffold that panics; default build uses the mock relay and logs actuations |
| Position/tamper **sensors** | **Stub** — `Sensors` iface returns static values; wire real debounced GPIO inputs |

The long-poll fallback endpoint shape (`/poll`) is a documented convention
(see `internal/transport/runner.go`) pending the gateway freezing it; the WSS
path is the specified one.

## Wiring

Physical wiring (relay board, normally-open contact, position sensor, power)
lives with the hardware/enclosure docs under the project `site/`. On a real
Pi you implement `internal/relay` behind `-tags gpio`:

- honor `pulse_ms` / `hold_max` / `sensor_debounce_ms` from the config store,
- drive a normally-open relay on one output line (active high),
- **fail-safe**: on process exit or panic the line must drop (gate closed).

Build with `-tags gpio` once implemented; without it the agent uses the mock
relay. See `internal/relay/gpio.go`.

## Running

### The agent

First run pairs with a single-use claim token (from the portal) and persists
the result, pinning the gateway's public key:

```
go run ./cmd/controller \
  --state /var/lib/lintel \
  --gateway https://gate.example.com \
  --claim-token <TOKEN> \
  --access-points main,pedestrian
```

Subsequent runs need only `--state`; pairing is durable. `--lan :8737`
serves offline grants on the LAN (default on); `--ble` enables the BLE
peripheral (requires a `-tags ble` Linux build); `--insecure` permits
`ws://`/`http://` for dev.

### The simulator

Runs the **real** agent assembly with the mock relay, or replays the
conformance fixtures with no gateway at all:

```
# Live agent against a dev gateway (mock relay; prints state transitions).
# stdin accepts: status | lockdown | lift | quit
go run ./cmd/controller-sim --gateway http://localhost:8080 --claim-token <TOKEN>

# Offline grant flow: replays every proto/vectors grant transcript through the
# shared verification core, then does a live LAN open with a fresh random cnonce.
go run ./cmd/controller-sim --offline-demo

# BLE emergency transport: drives grant.open→challenge→proof→result through the
# framing codec + session core in memory at ATT MTUs 23/185/512 (no radio).
go run ./cmd/controller-sim --ble-demo
```

## Tests

```
go build ./...                 # default (no external deps)
go build -tags ble ./...       # with the BLE radio glue (Linux/BlueZ real; stub elsewhere)
go vet ./... && gofmt -l .     # clean
go test ./...                  # all green
```

Every `proto/vectors/` file is consumed by the suite:

- **jcs** — byte-compares our canonicalizer against every `canonical` field
  across all 5 vector files (61 vectors).
- **wire** — reproduces every vector signature byte-for-byte; runs the
  `ws.auth` accept/reject matrix; proves our ack/event builders match.
- **command** — the full accept/reject matrix (23 command vectors) through the
  real pipeline (durable nonce store + state store + fake clock), plus
  lockdown state machine, repair key-rotation, and nonce-store-full fail-closed.
- **grants** — every offline transcript (14 vectors) through the shared
  `Exchange`, window evaluation (incl. timezone), stale-clock boundary.
- **framing** — round-trips at MTUs 23/185/512, header-split, back-to-back
  frames, abort-on-new-frame, frame_too_large, zero-length.
- **blesession** — full open→challenge→proof→result over the framing codec.
- **events** — durability across kill/reload, torn-tail truncation, ring
  drop-oldest, grant partition never dropped, compaction.
- **pairing** — redeem happy path + token burn, tampered gateway-key-change
  rejection, insecure ws_url refusal.
- **transport** — full WSS session against a fake gateway (challenge → signed
  ws.auth → event drain → command → signed ack).

## Code duplication

`internal/jcs` and the `Sign`/`Verify`/`VerifyRaw` helpers in `internal/wire`
are **intentionally copied and adapted** from `gateway/internal/keys`
(`jcs.go`, `keys.go`, `envelope.go`). The controller is a standalone module so
it can be vendored onto devices without the gateway; importing the gateway
module would pull in its whole dependency tree. The duplicated surface is
small (~170 lines of JCS plus a handful of crypto wrappers). **The vectors in
`proto/vectors/` are the arbiter** — if a canonicalization or signing bug is
found, fix it in *both* modules and re-run each one's conformance tests.
