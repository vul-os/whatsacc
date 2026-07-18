# Security policy

whatsacc opens **physical gates, doors and barriers**. A security bug here is not a
data leak — it can let someone through a gate they should never pass, or lock out
someone who must get in. Please treat disclosure accordingly.

## Reporting a vulnerability

**Report privately. Do not open a public issue for anything exploitable.**

- Email: **security@whatsacc.com** (maintainer: [imranparuk](https://github.com/imranparuk))
- Or use GitHub's private vulnerability reporting on
  [vul-os/whatsacc](https://github.com/vul-os/whatsacc/security/advisories/new)

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
   isolation escapes, rules-engine bypass (time windows, quotas, geofence),
   rate-limit evasion, audit-log tampering.
3. **Chat webhooks** — signature-verification flaws on channel ingress (Meta HMAC,
   Slack signing secret, Telegram secret token), sender-identity spoofing that leads
   to an open.
4. **Portal / web** ([`src/`](src/), [`site/`](site/)) — XSS, CSRF, token handling.

Out of scope: vulnerabilities in Meta/Slack/Telegram themselves, self-inflicted
misconfiguration of a self-hosted gateway (e.g. publishing your `.env`), and
volumetric DoS.

## Supported versions

The `main` branch is the supported line. The wire contracts in `proto/` are
versioned additive-only; security fixes that require breaking a contract will be
released as a new contract major version with migration notes.
