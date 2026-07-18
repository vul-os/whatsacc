# whatsacc conformance vectors — v0

Executable, deterministic test vectors for the four wire contracts in
[`proto/`](../README.md). The Go gateway, controller firmware and the app verify
against these fixed bytes instead of re-interpreting the prose. An implementation
that disagrees with a vector is wrong (or the vector is — fix it here first, then
the code).

**ALL KEYS IN THIS DIRECTORY ARE PUBLIC TEST CONSTANTS.** The private seeds are
printed in `keys.json` and in `lib.mjs`. Never use them, or anything derived from
them, outside conformance tests.

## Files

| File | Contract | Contents |
| --- | --- | --- |
| `keys.json` | — | fixed Ed25519 test keypairs (raw 32-byte seed + public key, hex and base64url) |
| `pairing.json` | [pairing.md](../pairing.md) | pair.redeem / pair.grant objects (unsigned), ws.challenge, ws.auth accept + 4 rejects |
| `commands.json` | [commands.md](../commands.md) | valid signed envelope per command; rejects: badsig, tampered, wrong_device, wrong_access_point, expired, not_yet_valid, window_too_long, replay (2-step), lockdown matrix; one exact skew-boundary accept |
| `grants.json` | [grants.md](../grants.md) | full offline-redemption transcripts (grant + open + challenge + proof); rejects: stale_clock, lockdown, badsig (grant & proof), expired, wrong_device, wrong_access_point, window, wrong_grant, cnonce_expired, cnonce_replay (2-step), stale proof ts; one in-window accept |
| `events.json` | [events.md](../events.md) | valid signed event per kind (all 10), badsig + tampered rejects |
| `acks.json` | [commands.md §Acknowledgement](../commands.md) | success / denied / hw-error acks, badsig reject |
| `generate.mjs` | — | deterministic generator (node builtins only); re-running produces byte-identical JSON |
| `verify.mjs` | — | self-check: re-canonicalizes, re-signs, and re-runs each contract's verification rules; exit 0 = all hold |
| `lib.mjs` | — | shared JCS + Ed25519 helpers and the test-key constants |

Run: `node proto/vectors/generate.mjs` (regenerate) · `node proto/vectors/verify.mjs` (must exit 0).

## Vector shape

```jsonc
{
  "name": "cmd-open-valid",
  "desc": "…",
  "expect": "accept",            // or "reject"
  "reason": "expired",           // rejects only — MUST be the reason your implementation reports
  "check": { "now": 1789000010, "device_id": "…", "lockdown": false, "…": "…" },
  "signer": "gateway",           // which test key produced sig (null for unsigned/tampered)
  "object": { "…wire object incl. sig…": "" },
  "canonical": "{\"access_point\":\"main\",…}"   // exact JCS bytes that sig covers
}
```

- `object` is the wire message exactly as transmitted.
- `canonical` is the exact UTF-8 string that was signed: JCS (RFC 8785) of
  `object` with the top-level `sig` member removed (for unsigned objects it is
  simply JCS of the whole object, provided for byte-comparison practice).
  **Byte-compare your canonicalizer's output against this field** — that catches
  key-ordering, whitespace and number-formatting bugs before any crypto runs.
- `check` is the verifier-side context: the verification-time clock (`now`,
  unix seconds), the controller's own `device_id` and served `access_points`,
  `lockdown` state, `last_gateway_sync`, or the issued `challenge` — everything
  a stateless test needs to reproduce the decision.
- Multi-message flows use `steps` (replay / cnonce-reuse: the same signed object
  presented twice — step 0 accepts, step 1 must reject) and, in `grants.json`, a
  `transcript` object holding `open` / `challenge` / `proof`.
- Reject vectors are single-fault: exactly one rule fails, so the `reason` is
  unambiguous regardless of minor ordering differences — but the normative check
  order is written in commands.md and grants.md and `verify.mjs` follows it.

## Key format

Raw Ed25519 (RFC 8032). `private_seed_hex` is the 32-byte private seed;
`public_key_hex` / `public_key_b64u` the raw 32-byte public key. No PEM, DER,
JWK or multibase framing anywhere on the wire — `*_pubkey` fields and `sig`
(64 bytes) are base64url **without padding**.

- **Go**: `ed25519.NewKeyFromSeed(seed)` / `ed25519.Verify(pub, canonical, sig)`.
- **Rust** (`ed25519-dalek`): `SigningKey::from_bytes(&seed)` /
  `VerifyingKey::from_bytes(&pub)`.
- **C** (monocypher/libsodium): `crypto_sign_seed_keypair` (note libsodium's
  64-byte "secret key" = seed ‖ public key; the vectors store only the seed);
  sign/verify detached over the canonical bytes.

Consume by byte-comparing in three layers: (1) your JCS output == `canonical`;
(2) your signature over `canonical` with the signer's seed == `object.sig`
(Ed25519 is deterministic, so signing must reproduce it exactly);
(3) your full envelope verifier applied with `check` context == `expect`/`reason`.

## JCS subset used (honesty section)

`lib.mjs` implements the RFC 8785 subset these contracts actually exercise:

- **Object keys** sorted by UTF-16 code units (JS `Array.sort()` on strings is
  exactly this) — all keys in these contracts are ASCII, where UTF-16 order ==
  byte order, so a plain `strcmp` sort is sufficient in C/Go/Rust.
- **No insignificant whitespace.**
- **Numbers**: serialized with ECMAScript `Number::toString` (what RFC 8785
  §3.2.2.3 specifies verbatim; `JSON.stringify` in JS). Every number in these
  contracts is a **small non-negative integer** (unix seconds, counts, rssi is
  the one negative), so any implementation that prints integers in the shortest
  decimal form with no exponent, no `.0`, and no `-0` matches. Do not put
  non-integer numbers into signed envelopes without revisiting this.
- **Strings**: `JSON.stringify` escaping — two-char escapes (`\" \\ \b \f \n
  \r \t`), `\u00xx` lowercase hex for remaining control chars, everything else
  literal UTF-8. All strings in these vectors are printable ASCII.
- **Not implemented / not exercised**: lone-surrogate handling, non-finite
  numbers (rejected), extreme-magnitude doubles. If a future contract field
  needs them, extend `lib.mjs` to full RFC 8785 first and add vectors.

Signing rule (proto/README.md): remove `sig`, JCS-serialize, sign the UTF-8
bytes; optional fields are omitted entirely when absent (never `null`) and are
covered by the signature when present.

## Fixed constants baked into the vectors

| Constant | Value |
| --- | --- |
| base time `T0` | `1789000000` (2026-09-10T00:26:40Z, a Thursday) |
| clock skew | ±90 s, both bounds (commands, grant iat/exp, proof/auth `ts`) |
| max command window `exp − iat` | 60 s |
| grant.challenge / ws.challenge cnonce validity | 30 s |
| stale-clock refusal | offline > 1 209 600 s (14 d = 2 × default grant TTL) |
| grant TTL in vectors | 604 800 s (7 d) |
| controller timezone for `windows` | UTC |
| test seeds | sha256(`"whatsacc-test-vector:<name>"`), hardcoded in `lib.mjs` |
