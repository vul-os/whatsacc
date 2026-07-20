# lintel wire contracts

These are the contracts that outlive binaries. Controllers get installed at physical
gates and stay there for years; the app ends up on phones we don't control. Everything
in this directory is **versioned, additive-only**: a field can be added, a message can
be added, nothing can be removed or change meaning within a major version.

| Contract | File | Parties |
| --- | --- | --- |
| Pairing | [pairing.md](pairing.md) | gateway ⇄ controller |
| Signed commands | [commands.md](commands.md) | gateway → controller |
| Offline grants | [grants.md](grants.md) | gateway → app → controller |
| Controller events | [events.md](events.md) | controller → gateway |

Status: **v0 draft** — to be implemented by the Go gateway port. v1 freezes when the
first third-party controller firmware ships.

## Conventions

- All signatures are **Ed25519** over canonical JSON (JCS, RFC 8785) unless stated.
- All binary values are base64url without padding. All timestamps are Unix seconds (UTC).
- Every signed envelope carries `v` (contract major version) and `typ`.
- Controllers **pin the gateway's public key at pairing** and reject anything else,
  regardless of transport. TLS is transport privacy; Ed25519 is the authority.
- Nonces are single-use per controller; controllers keep a small replay window and
  reject reused or expired material fail-closed.
- The signing rule, everywhere: remove the `sig` member, serialize the remaining
  object with JCS (RFC 8785), sign the resulting UTF-8 bytes; `sig` is the
  base64url (no padding) of the 64-byte Ed25519 signature. Optional members are
  **omitted entirely** when absent (never `null`) and are covered by the signature
  when present.
- Public keys on the wire are the raw 32-byte Ed25519 public key, base64url, no
  padding (no PEM/DER/multibase framing).
- Executable conformance vectors (fixed test keys, canonical bytes, accept/reject
  cases) live in [vectors/](vectors/) — implementations must pass them before
  claiming v0 conformance.
