// Data file for scripts/check-feature-claims.mjs — see that file's header for
// the full design rationale and honesty caveats before trusting anything in
// here. This file is just the list of claims; it has no logic of its own.
//
// Each entry is one feature CLAIM as it currently reads in the docs (README's
// status table, ARCHITECTURE.md's §8 roadmap, site/index.html's `.soon`
// badges, or an explicit "Status:" line in a doc). `docStatus` records what
// the docs say TODAY:
//
//   'shipped' — the docs claim this exists and works (no 🔨/soon/"designed,
//               not implemented" marker attached). Evidence MUST be found,
//               or the check fails ("documented feature, zero code" — the
//               2026-07-20 audit's failure mode, nine times over).
//   'planned' — the docs explicitly mark this not-yet-real (🔨, `.soon`,
//               "designed, not implemented", "coming", "not started", a
//               stub/panic notice, etc). Evidence MUST NOT be found, or the
//               check fails the other direction — something shipped and the
//               docs are now stale and undersell it (which is exactly how
//               Slack Socket Mode, Telegram and the Go gateway's product-core
//               status went unnoticed until today).
//
// `evidence` is a list of checks that ALL must pass for the feature to count
// as "implemented" (AND across the list). Each item may itself be an array,
// meaning "at least one of these" (OR within that slot). An item is one of:
//
//   { file, pattern }         — file must exist AND its content must match
//                                the regex `pattern` (source string, 'm' flag).
//   { file, patternAbsent }   — file must exist AND its content must NOT
//                                match `patternAbsent`. Used for "the real
//                                thing replaced the stub" checks (e.g. the
//                                GPIO panic placeholder is gone).
//   { file }                  — file or directory must merely exist.
//   { root, pattern }         — at least one file somewhere under `root`
//                                (walked recursively, skipping the usual
//                                junk — see WALK_EXCLUDES in the checker)
//                                matches `pattern`.
//
// Evidence roots are deliberately restricted to IMPLEMENTATION code —
// gateway/, backend/src/, controller/, proto/, src-tauri/ config — never
// src/ (the React portal's UI copy) or site/ (marketing). Scanning UI copy
// for evidence would be circular: it's the exact layer that lies. See the
// checker's header for what that means this tool cannot catch.

export const FEATURES = [
  // ── planned / not implemented — the nine (ten, by plain count) 2026-07-20
  // overclaims, now correctly marked in the docs. This check's job is to
  // make sure nobody re-overclaims them by accident, and to catch the day
  // any of them actually ships (evidence appears → docs must be updated).
  {
    id: 'geofencing',
    label: 'Geofencing (block opens outside a per-location radius)',
    docStatus: 'planned',
    docRefs: [
      'README.md — "Geofencing ... isn\'t implemented in either the Go gateway or the reference backend yet (🔨)"',
      'ARCHITECTURE.md §8 Feature roadmap',
      'site/index.html — "Geofence safety <span class=soon>planned</span>"',
      'site/docs/security.md — "Status: designed, not implemented"',
    ],
    evidence: [{ root: 'gateway/internal', pattern: 'geofenc', flags: 'i' }],
  },
  // ── offline-grant issuance is the 2026-07-20 evening's headline ship: the
  // gateway side is now real, but the third leg (the app holding/presenting
  // a grant) still is not — see proto/grants.md § "Implementation status"
  // for the full three-of-four picture. A single shipped/planned binary
  // entry can't say "some of this is real, some isn't" honestly, so this is
  // split into the two claims the docs now actually make.
  {
    id: 'offline-grant-issuance',
    label: 'Gateway-side minting/issuance of offline LAN/BLE grants (POST /v1/offline-grants)',
    docStatus: 'shipped',
    docRefs: [
      'README.md resilience note — "both the controller side and the gateway\'s issuance side are real and conformance-tested"',
      'site/docs/emergency-access.md — "Gateway-side issuance is now real"',
      'proto/grants.md "Implementation status" — "gateway side ... is also real and conformance-tested"',
      'gateway/internal/channels/send.go — ban-risk warning names the app, not the gateway, as the missing half',
    ],
    // Deliberately narrow: "offline" alone appears constantly in this
    // codebase for unrelated things (the HTTPS long-poll device queue,
    // comments explaining this exact gap). Look for the specific route this
    // half of proto/grants.md would need to land on.
    evidence: [{ root: 'gateway/internal', pattern: '"POST /v1/offline-grants"|handleOfflineGrantIssue', flags: 'i' }],
  },
  {
    id: 'offline-grant-app-client',
    label: 'App (Tauri) client that requests, stores and presents an offline LAN/BLE grant to a controller',
    docStatus: 'planned',
    docRefs: [
      'README.md resilience note — "not built yet is the app side (🔨)"',
      'site/docs/emergency-access.md — "What is still not built: the app"',
      'proto/grants.md "Implementation status" — "app client unbuilt"',
      'gateway/internal/channels/send.go — "the app doesn\'t hold or present a grant yet"',
    ],
    // The app is src/ + src-tauri/ (React 19 + Tauri v2). src/ is
    // deliberately never used as an evidence root (see this file's header —
    // it's UI copy, the exact layer that lied nine times already), so this
    // checks the one implementation-code root the app actually has today:
    // the Rust shell in src-tauri/ (excluding target/, walked out by
    // WALK_EXCLUDES). A real grant-request/store/present flow would show up
    // here as new Rust or Tauri-command surface; today src-tauri/src/main.rs
    // is a 12-line gateway-picker shell with none of it.
    evidence: [{ root: 'src-tauri', pattern: 'offline.?grant|grant_id|presentGrant|requestOfflineGrant|mDNS|_lintel\\._tcp', flags: 'i' }],
  },
  {
    id: 'hardware-failsafe-gpio',
    label: 'Hardware-validated GPIO relay fail-safe driver (`-tags gpio`)',
    docStatus: 'planned',
    docRefs: [
      'controller/README.md — "Status: reference implementation. GPIO and BLE radio are stubbed"',
      'README.md Safety — "the -tags gpio driver shipped in this repo is a documented scaffold that panics, not a hardware-validated implementation"',
    ],
    // Real evidence would be the panic placeholders gone, replaced by an
    // actual gpiochip driver.
    evidence: [{ file: 'controller/internal/relay/gpio.go', patternAbsent: 'panic\\(' }],
  },
  {
    id: 'recurring-time-windows',
    label: 'Recurring per-location access windows (e.g. "every Tuesday 08:00-12:00")',
    docStatus: 'planned',
    docRefs: [
      'README.md — "Recurring per-location time windows ... designed, not started (🔨)"',
      'ARCHITECTURE.md §8 — "Designed, not started: ... recurring access windows"',
      'site/index.html — "Time windows <span class=soon>planned</span>"',
    ],
    evidence: [{ root: 'gateway/internal', pattern: 'recurring|RRULE|rrule', flags: 'i' }],
  },
  {
    id: 'discord-channel',
    label: 'Discord as a working chat channel',
    docStatus: 'planned',
    docRefs: [
      'README.md — "Discord next" / "Planned, not shipped: Discord is next up"',
      'site/index.html — "Discord <span class=soon>soon</span>"',
    ],
    evidence: [{ root: 'gateway/internal/channels', pattern: 'KindDiscord|type Discord struct', flags: 'i' }],
  },
  {
    id: 'tauri-mobile',
    label: 'Tauri iOS/Android app targets',
    docStatus: 'planned',
    docRefs: [
      'README.md dev table — "app/ ... Desktop, iOS, Android" is the TARGET, not what ships (`src/` + `src-tauri/` ships desktop only)',
    ],
    // A generated mobile target leaves `gen/apple` or `gen/android` behind
    // (`tauri ios init` / `tauri android init`); today gen/ only has the
    // desktop schemas.
    evidence: [[{ file: 'src-tauri/gen/apple' }, { file: 'src-tauri/gen/android' }]],
  },
  {
    id: 'outbound-webhooks',
    label: 'Outbound webhooks (third-party integrations subscribing to gateway events)',
    docStatus: 'planned',
    docRefs: ['No doc claims this ships; verified absent to guard against re-introduction of the claim.'],
    evidence: [[
      { root: 'gateway/internal', pattern: 'WebhookSubscription|OutboundWebhook|webhook_subscriptions', flags: 'i' },
      { root: 'backend/src', pattern: 'WebhookSubscription|OutboundWebhook|webhook_subscriptions', flags: 'i' },
    ]],
  },
  {
    id: 'gateway-analytics',
    label: 'Analytics endpoints in the Go gateway (backend/ Workers reference still has these; gateway defers them)',
    docStatus: 'planned',
    docRefs: [
      'README.md — "still ahead on a few deferred surfaces: OTP verify, analytics, OAuth, meters"',
      'site/docs/self-host.md — "Still deferred ... analytics endpoints"',
    ],
    evidence: [{ root: 'gateway/internal', pattern: '/v1/analytics|handleAnalytics', flags: 'i' }],
  },
  {
    id: '2fa',
    label: 'Two-factor authentication',
    docStatus: 'planned',
    docRefs: ['site/docs/troubleshooting.md — "there is no 2FA to lose — lintel doesn\'t have it"'],
    evidence: [[
      { root: 'gateway/internal', pattern: 'TOTP|totp|two.?factor|MFA\\b', flags: 'i' },
      { root: 'backend/src', pattern: 'TOTP|totp|two.?factor|MFA\\b', flags: 'i' },
    ]],
  },
  {
    id: 'csv-export',
    label: 'CSV export of the audit log',
    docStatus: 'planned',
    docRefs: ['No current README/ARCHITECTURE/site claim ships this; verified absent to guard against re-introduction.'],
    evidence: [[
      { root: 'gateway/internal', pattern: 'text/csv|ExportCSV|\\.csv"', flags: 'i' },
      { root: 'backend/src', pattern: 'text/csv|ExportCSV|\\.csv"', flags: 'i' },
    ]],
  },

  // ── shipped — genuinely real today. Encoded so a regression (someone
  // rips the code out but the docs keep bragging) fails loudly, same as a
  // false "shipped" claim would.
  {
    id: 'ed25519-signed-commands',
    label: 'Ed25519-signed device commands',
    docStatus: 'shipped',
    docRefs: ['README.md Wire contracts — "Ed25519 over canonical JSON (JCS, RFC 8785)"'],
    evidence: [{ file: 'gateway/internal/keys/keys.go', pattern: 'ed25519\\.Sign\\(' }],
  },
  {
    id: 'controller-key-pinning',
    label: 'Controller pins its paired gateway\'s public key',
    docStatus: 'shipped',
    docRefs: ['README.md dev table — controller row: "key pinning"', 'controller/internal/state/state.go'],
    evidence: [{ file: 'controller/internal/state/state.go', pattern: 'ErrKeyChangeRefused' }],
  },
  {
    id: 'claim-token-pairing',
    label: 'Claim-token controller pairing',
    docStatus: 'shipped',
    docRefs: ['README.md — "claim-token controller pairing"'],
    evidence: [{ file: 'gateway/internal/store/devices.go', pattern: 'claim_token_hash' }],
  },
  {
    id: 'append-only-audit-log',
    label: 'Append-only audit log',
    docStatus: 'shipped',
    docRefs: ['README.md — "an append-only audit log"'],
    evidence: [{ file: 'gateway/internal/store/admin.go', pattern: 'admin_audit_log' }],
  },
  {
    id: 'rate-limits',
    label: 'The four configurable rate limits',
    docStatus: 'shipped',
    docRefs: ['README.md — "all four rate limits"'],
    evidence: [
      { file: 'gateway/internal/store/ratelimit.go', pattern: 'RATE_OPEN_COOLDOWN_S' },
      { file: 'gateway/internal/store/ratelimit.go', pattern: 'RATE_OPENS_PER_HOUR' },
      { file: 'gateway/internal/store/ratelimit.go', pattern: 'RATE_ACCOUNT_OPENS_PER_HOUR' },
      { file: 'gateway/internal/store/ratelimit.go', pattern: 'RATE_CHAT_MSGS_PER_MIN' },
    ],
  },
  {
    id: 'per-location-daily-quotas',
    label: 'Per-location daily quotas (owner/admin exempt)',
    docStatus: 'shipped',
    docRefs: ['README.md — "per-location daily quotas (owner/admin exempt)"'],
    evidence: [{ file: 'gateway/internal/store/locations.go', pattern: 'LocationQuotas' }],
  },
  {
    id: 'one-off-visitor-grants',
    label: 'One-off dated temporary access grants (phone-bound, POST/GET /v1/grants)',
    docStatus: 'shipped',
    docRefs: ['README.md — "one-off dated temporary access grants ... (POST/GET /v1/grants, portal page)"'],
    evidence: [
      { file: 'gateway/internal/store/grants.go', pattern: 'phone_e164' },
      { file: 'gateway/internal/httpapi/server.go', pattern: '"POST /v1/grants"' },
    ],
  },
  {
    id: 'whatsapp-channel',
    label: 'WhatsApp channel',
    docStatus: 'shipped',
    docRefs: ['README.md — "the WhatsApp / Slack ... / Telegram channels"'],
    evidence: [{ file: 'gateway/internal/channels/whatsapp.go', pattern: 'func \\(WhatsApp\\) Kind\\(\\)' }],
  },
  {
    id: 'slack-channel',
    label: 'Slack channel (Events API)',
    docStatus: 'shipped',
    docRefs: ['README.md — "Slack (Events API + Socket Mode)"'],
    evidence: [{ file: 'gateway/internal/channels/slack.go', pattern: 'func \\(Slack\\) Kind\\(\\)' }],
  },
  {
    id: 'telegram-channel',
    label: 'Telegram channel',
    docStatus: 'shipped',
    docRefs: ['README.md — "the WhatsApp / Slack ... / Telegram channels"'],
    evidence: [{ file: 'gateway/internal/channels/telegram.go', pattern: 'func \\(Telegram\\) Kind\\(\\)' }],
  },
  {
    id: 'slack-socket-mode',
    label: 'Slack Socket Mode (outbound WSS, zero ingress)',
    docStatus: 'shipped',
    docRefs: ['README.md — "Slack (Events API + Socket Mode)"', 'gateway/internal/channels/socketmode.go'],
    evidence: [{ file: 'gateway/internal/channels/socketmode.go', pattern: 'type SocketMode struct' }],
  },
  {
    id: 'go-gateway-product-core',
    label: 'The Go gateway runs the product core (not just a skeleton/spec)',
    docStatus: 'shipped',
    docRefs: [
      'README.md — "The Go gateway ... now runs the product core"',
      'README.md dev table — gateway row: "🟢 runs the product core"',
    ],
    evidence: [
      { file: 'gateway/internal/httpapi/server.go', pattern: 'func \\(s \\*Server\\) Router\\(\\)' },
      { file: 'gateway/cmd/gateway/main.go' },
    ],
  },

  // ── 2026-07-20 hardening wave: the docs UNDER-claimed these (opposite
  // failure mode from the nine above) until this pass. Encoded here so a
  // future regression — code ripped out, docs still bragging — fails loudly,
  // the same way a false "shipped" claim would.
  {
    id: 'audit-hash-chain',
    label: 'Tamper-evident hash chain for access_logs/admin_audit_log + append-only DB triggers, verifiable via GET /v1/admin/audit/verify or `gateway verify-audit` against a cold backup',
    docStatus: 'shipped',
    docRefs: [
      'gateway/README.md — "Tamper-evident audit log"',
      'site/docs/security.md — "Tamper-evident audit log"',
      'site/docs/self-host.md — "Checking the audit log hasn\'t been tampered with"',
      'site/docs/admin.md — "The audit trail" (three views)',
      'site/docs/api.md — audit section',
    ],
    // NOTE: this only proves the mechanism exists, not that it's a
    // prevention control — the honest ceiling (a fully re-hashed tamper
    // verifies clean) is load-bearing prose, not something a regex can
    // check; see gateway/internal/store/audithash_test.go's
    // TestHashChainTamperRecomputingDownstreamIsUndetected.
    evidence: [
      { file: 'gateway/internal/store/audithash.go', pattern: 'func \\(s \\*Store\\) VerifyAccessLogHashChain' },
      { file: 'gateway/internal/store/migrations/0007_audit_hash_chain.sql' },
      { file: 'gateway/internal/httpapi/server.go', pattern: '"GET /v1/admin/audit/verify"' },
      { file: 'gateway/cmd/gateway/main.go', pattern: 'verify-audit' },
    ],
  },
  {
    id: 'login-brute-force-rate-limiting',
    label: 'Per-IP (hard) + per-account (soft, failures-only, fixed non-compounding window) brute-force throttles on login/register/refresh/admin-claim, fail-closed on a counter-store error',
    docStatus: 'shipped',
    docRefs: [
      'gateway/README.md — "Auth & session security"',
      'site/docs/security.md — "Login & session security"',
      'site/docs/self-host.md — Configuration (RATE_LOGIN_IP_PER_5MIN etc.)',
      'site/docs/api.md — Authentication section',
    ],
    evidence: [
      { file: 'gateway/internal/store/authratelimit.go', pattern: 'RATE_LOGIN_IP_PER_5MIN' },
      { file: 'gateway/internal/store/authratelimit.go', pattern: 'RATE_LOGIN_ACCOUNT_PER_5MIN' },
      { file: 'gateway/internal/httpapi/auth.go', pattern: 'authIPGate' },
    ],
  },
  {
    id: 'logout-all',
    label: '"Log out everywhere" — POST /v1/auth/logout-all revokes every refresh-token family for the calling user',
    docStatus: 'shipped',
    docRefs: [
      'gateway/README.md — "Auth & session security"',
      'site/docs/security.md — "Login & session security"',
      'site/docs/api.md — Authentication section',
    ],
    evidence: [
      { file: 'gateway/internal/httpapi/server.go', pattern: '"POST /v1/auth/logout-all"' },
      { file: 'gateway/internal/store/users.go', pattern: 'func \\(s \\*Store\\) RevokeAllRefreshTokensForUser' },
    ],
  },
  {
    id: 'live-session-revocation-all-requests',
    label: 'requireAuth re-reads the live user row on every authenticated request (not just admin routes) — a disabled user is cut off on their next request, not at token TTL expiry',
    docStatus: 'shipped',
    docRefs: [
      'gateway/README.md — "Auth & session security"',
      'site/docs/security.md — "Login & session security"',
    ],
    evidence: [
      { file: 'gateway/internal/httpapi/server.go', pattern: 'func \\(s \\*Server\\) requireAuth' },
      { file: 'gateway/internal/httpapi/server.go', pattern: 'u\\.Status != "active"' },
    ],
  },
  {
    id: 'public-bind-refusal',
    label: 'Gateway refuses to start when -listen resolves to a non-loopback address unless -behind-proxy/LINTEL_BEHIND_PROXY is set',
    docStatus: 'shipped',
    docRefs: [
      'gateway/README.md — "Deployment & TLS"',
      'site/docs/self-host.md — "Reachability"',
    ],
    evidence: [
      { file: 'gateway/cmd/gateway/main.go', pattern: 'func checkListenAddr' },
      { file: 'gateway/cmd/gateway/main.go', pattern: 'LINTEL_BEHIND_PROXY' },
      { file: 'gateway/Dockerfile', pattern: 'LINTEL_BEHIND_PROXY=1' },
    ],
  },
];
