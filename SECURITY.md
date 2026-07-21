# Security policy

lintel opens **physical gates, doors and barriers**. A security bug here is not a
data leak — it can let someone through a gate they should never pass, or lock out
someone who must get in. Please treat disclosure accordingly.

## Reporting a vulnerability

**Report privately. Do not open a public issue for anything exploitable.**

- Email: **vulosorg@gmail.com** (maintainer: [imranparuk](https://github.com/imranparuk))
- Or use GitHub's private vulnerability reporting on
  [vul-os/lintel](https://github.com/vul-os/lintel/security/advisories/new)

Include what you can: affected component, reproduction steps, impact as you understand
it, and any suggested fix. You will get an acknowledgement, and we will work with you
on a fix and coordinated disclosure timeline. Given the physical-safety angle, please
allow reasonable time for operators to update before publishing details.

There is **no bug bounty** — this is an MIT-licensed open-source project with no
billing system and no revenue. What we offer is fast engagement and credit in the fix.

## Scope

In scope, roughly in order of severity:

1. **Controller protocol** ([`proto/`](proto/)) — anything that forges, replays or
   bypasses Ed25519-signed open commands, pairing, or offline grants (nonce reuse,
   expiry bypass, key-pinning escape, challenge-response weaknesses).
2. **Gateway / backend** ([`backend/`](backend/)) — authn/authz bypass, tenancy
   isolation escapes, rules-engine bypass (time windows, quotas), rate-limit evasion.
   (Geofencing is designed but not yet implemented in either the Go gateway or the
   reference backend — see the README's Features section for current status;
   there's nothing to bypass yet.)

   **Audit-log tampering, specifically:** the `access_logs` and `admin_audit_log`
   tables are hash-chained (migration `0007_audit_hash_chain.sql`) and the chain
   is walkable via `GET /v1/admin/audit/verify` or `gateway verify-audit`. A bug
   that lets an *authenticated request* forge, backdate or silently mutate an
   audit row without breaking that chain — or a bypass of the append-only DB
   triggers from application code — is in scope and worth a report. What is
   **not** a bug: someone with direct filesystem/DB access to the gateway editing
   `lintel.db` and recomputing every downstream hash. That was always the trust
   boundary of a self-hosted single-file database, the hash chain only turns
   *silent* tampering by that party into *detectable* tampering — it does not
   and cannot prevent it. Don't report "I have root on the box and can edit the
   database" as a finding; do report anything that achieves the same result
   through the running application instead.
3. **Chat webhooks** — signature-verification flaws on channel ingress (Meta HMAC,
   Slack signing secret, Telegram secret token), sender-identity spoofing that leads
   to an open.
4. **Portal / web** ([`src/`](src/), [`site/`](site/)) — XSS, CSRF, token handling.

Out of scope: vulnerabilities in Meta/Slack/Telegram themselves, self-inflicted
misconfiguration of a self-hosted gateway (e.g. publishing your `.env`), and
volumetric DoS.

## Physical safety vs. security

This policy is about *security* — code, protocol and cryptographic flaws that let
someone bypass or forge an open. **Physical installation safety** — fire-code egress
compliance, fail-safe wiring, why lintel must never be the only way out of a building —
is a separate, non-negotiable topic covered in [Safety](README.md#safety) in the main
README. It's an operator/compliance responsibility, not usually a code bug, but if
you believe this repo's own docs recommend something physically unsafe, report that
here too — that's a documentation defect worth fixing fast.

## Supported versions

The `main` branch is the supported line. The wire contracts in `proto/` are
versioned additive-only; security fixes that require breaking a contract will be
released as a new contract major version with migration notes.
