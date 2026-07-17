# Tunnel attach — v0

How a gateway behind NAT gets a public URL, without whatsacc depending on any single
provider. The gateway core is transport-agnostic: it binds a listener, full stop.
Reachability layers on top, in one of three ways.

## 1. Direct (default)

Public VPS / IP. The gateway does ACME itself (HTTP-01 or TLS-ALPN-01) for its
configured domain. No tunnel, no dependency.

## 2. External tunnel (zero code)

cloudflared, frp, Tailscale Funnel, anything that forwards HTTP(S) to a local port.
Runs beside the binary; whatsacc neither knows nor cares. Documented, not implemented.

## 3. Built-in driver

```toml
# gateway.toml
[tunnel]
driver   = "vulos-relay"           # reference driver
endpoint = "wss://relay.vulos.org"
token    = "…"                      # provider account token
hostname = "silveroaks.gw.example"  # assigned or requested
```

Driver interface (Go):

```go
type TunnelDriver interface {
    // Attach dials out, keeps the tunnel alive (reconnect w/ backoff),
    // and forwards raw TCP streams for our hostname to the local listener.
    Attach(ctx context.Context, cfg TunnelConfig, forwardTo net.Addr) (TunnelStatus, error)
}
```

## Content-blindness requirement

A tunnel provider must never need our plaintext. Drivers therefore forward **raw TLS**
(SNI-routed passthrough) whenever the provider supports it, with the gateway terminating
TLS itself — the provider sees hostnames and byte counts, nothing else. Where a provider
is L7-only (today's vulos-relay default), the driver works but the gateway marks the
deployment `reachability: content-visible` in the portal's security panel — operators
deserve the honest label. ACME flows through the tunnel like any other traffic, so
hostname certs work identically in every mode.

## Meta webhook note

WhatsApp requires a publicly-trusted HTTPS endpoint — any of the three modes satisfies
it. Discord uses an outbound bot gateway (no inbound needed at all); Slack Events API
needs the public URL like Meta.
