#!/usr/bin/env node
// proto/vectors/verify.mjs — self-check for the lintel conformance vectors.
//
// For every vector it:
//   1. re-canonicalizes the wire object (minus sig) and byte-compares against
//      the stored "canonical" field;
//   2. re-signs the canonical bytes with the stated signer's test key and
//      byte-compares against "sig" (Ed25519 is deterministic, RFC 8032);
//   3. runs an independent implementation of the contract's verification rules
//      (commands.md / grants.md / events.md / pairing.md) and asserts the
//      outcome matches "expect" — and, for rejects, fails for the STATED reason.
//
// Exit code 0 = all vectors hold. Run: node proto/vectors/verify.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KEYS,
  b64u,
  fromB64u,
  jcs,
  canonicalMinusSig,
  signRaw,
  verifyObject,
} from './lib.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const SKEW = 90;
const MAX_CMD_WINDOW = 60;
const STALE_CLOCK_LIMIT = 1209600;

let checked = 0;
let failures = 0;
const fail = (name, msg) => {
  failures++;
  console.error(`FAIL ${name}: ${msg}`);
};

const load = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));

// --- structural checks on any {signer, object, canonical} entry --------------

const B64U_RE = /^[A-Za-z0-9_-]+$/;

function checkEntry(name, entry) {
  const { object, canonical, signer, unsigned } = entry;
  const expected = unsigned ? jcs(object) : canonicalMinusSig(object);
  if (canonical !== expected) {
    fail(name, 'stored canonical does not match re-canonicalized object');
    return;
  }
  if (unsigned) return;
  if (typeof object.sig !== 'string' || !B64U_RE.test(object.sig) || object.sig.length !== 86) {
    fail(name, 'sig is not 86-char unpadded base64url (64 bytes)');
    return;
  }
  if (signer) {
    const resigned = b64u(signRaw(KEYS[signer].priv, Buffer.from(canonical, 'utf8')));
    if (resigned !== object.sig) {
      fail(name, `re-signing with '${signer}' key does not reproduce sig (Ed25519 is deterministic)`);
    }
  }
}

// --- independent contract evaluators (fail-closed, first failure wins) -------

const rej = (reason) => ({ ok: false, reason });
const acc = () => ({ ok: true });

function evalCommand(env, check, nonceStore) {
  // commands.md "Verification" order
  if (!verifyObject(env, KEYS.gateway.pub)) return rej('badsig');
  if (env.device_id !== check.device_id) return rej('wrong_device');
  if (['open', 'hold', 'close'].includes(env.cmd)) {
    if (!env.access_point || !check.access_points.includes(env.access_point))
      return rej('wrong_access_point');
  }
  if (!(Number.isInteger(env.iat) && Number.isInteger(env.exp)) || env.iat > env.exp || env.exp - env.iat > MAX_CMD_WINDOW)
    return rej('window_too_long');
  if (check.now < env.iat - SKEW) return rej('not_yet_valid');
  if (check.now > env.exp + SKEW) return rej('expired');
  if (nonceStore.has(env.nonce)) return rej('replay');
  nonceStore.add(env.nonce);
  if (check.lockdown && !['lift', 'ping', 'config', 'repair'].includes(env.cmd))
    return rej('lockdown');
  return acc();
}

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const hm = (s) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

function inWindow(windows, ts) {
  const d = new Date(ts * 1000); // controller tz = UTC in these vectors
  const dayIdx = (d.getUTCDay() + 6) % 7; // mon=0 … sun=6
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  for (const w of windows) {
    const [a, b] = w.days.split('-');
    const ai = DAY_ORDER.indexOf(a);
    const bi = DAY_ORDER.indexOf(b ?? a);
    if (ai < 0 || bi < 0 || dayIdx < ai || dayIdx > bi) continue;
    const to = w.to === '24:00' ? 1440 : hm(w.to);
    if (minutes >= hm(w.from) && minutes < to) return true;
  }
  return false;
}

function evalGrantRedemption({ check, grant, open, challenge, proof }, usedCnonces) {
  // grants.md "Verification order"
  if (check.now - check.last_gateway_sync > STALE_CLOCK_LIMIT) return rej('stale_clock');
  if (check.lockdown) return rej('lockdown');
  if (!verifyObject(grant, KEYS.gateway.pub)) return rej('badsig');
  if (check.now < grant.iat - SKEW) return rej('not_yet_valid');
  if (check.now > grant.exp + SKEW) return rej('expired');
  if (!grant.devices.includes(check.device_id)) return rej('wrong_device');
  const ap = open.access_point;
  if (!grant.access_points.includes(ap) || proof.access_point !== ap)
    return rej('wrong_access_point');
  if (!inWindow(grant.windows, check.now)) return rej('window');
  if (proof.grant_id !== grant.grant_id) return rej('wrong_grant');
  if (!verifyObject(proof, fromB64u(grant.app_pubkey))) return rej('badsig');
  if (proof.cnonce !== challenge.cnonce) return rej('cnonce_unknown');
  if (check.now > challenge.exp) return rej('cnonce_expired');
  if (usedCnonces.has(proof.cnonce)) return rej('cnonce_replay');
  if (Math.abs(proof.ts - check.now) > SKEW)
    return rej(proof.ts < check.now ? 'expired' : 'not_yet_valid');
  usedCnonces.add(proof.cnonce);
  return acc();
}

function evalControllerSigned(obj, pub) {
  return verifyObject(obj, pub) ? acc() : rej('badsig');
}

function evalWsAuth(obj, check) {
  // pairing.md "WebSocket auth"
  if (!verifyObject(obj, KEYS.controller.pub)) return rej('badsig');
  if (obj.cnonce !== check.challenge.cnonce) return rej('cnonce_unknown');
  if (check.now > check.challenge.exp) return rej('cnonce_expired');
  if (Math.abs(obj.ts - check.now) > SKEW)
    return rej(obj.ts < check.now ? 'expired' : 'not_yet_valid');
  return acc();
}

// --- outcome assertion -------------------------------------------------------

function assertOutcome(name, expected, reason, actual) {
  checked++;
  if (expected === 'accept') {
    if (!actual.ok) fail(name, `expected accept, got reject(${actual.reason})`);
  } else {
    if (actual.ok) fail(name, `expected reject(${reason}), got accept`);
    else if (actual.reason !== reason)
      fail(name, `expected reject reason '${reason}', got '${actual.reason}'`);
  }
}

// --- keys.json consistency ---------------------------------------------------

{
  const doc = load('keys.json');
  for (const [name, k] of Object.entries(doc.keys)) {
    const derived = KEYS[name];
    checked++;
    if (!derived) fail(`keys.${name}`, 'unknown key');
    else if (
      k.private_seed_hex !== derived.seedHex ||
      k.public_key_hex !== derived.pubHex ||
      k.public_key_b64u !== derived.pubB64u
    )
      fail(`keys.${name}`, 'seed/public key mismatch vs lib.mjs constants');
  }
}

// --- pairing.json ------------------------------------------------------------

for (const v of load('pairing.json').vectors) {
  checkEntry(v.name, v);
  if (v.object.typ === 'ws.auth') {
    assertOutcome(v.name, v.expect, v.reason, evalWsAuth(v.object, v.check));
  } else {
    // unsigned structural vectors: canonical check above is the assertion
    checked++;
    if (v.expect !== 'accept') fail(v.name, 'unsigned vector must be accept');
  }
}

// --- commands.json -----------------------------------------------------------

for (const v of load('commands.json').vectors) {
  const nonceStore = new Set();
  const steps = v.steps ?? [v];
  for (const [i, s] of steps.entries()) {
    const n = v.steps ? `${v.name}[${i}]` : v.name;
    checkEntry(n, s);
    assertOutcome(n, s.expect, s.reason, evalCommand(s.object, v.check, nonceStore));
  }
}

// --- grants.json -------------------------------------------------------------

for (const v of load('grants.json').vectors) {
  checkEntry(`${v.name}.grant`, v.grant);
  checkEntry(`${v.name}.open`, v.transcript.open);
  const usedCnonces = new Set();
  const base = {
    check: v.check,
    grant: v.grant.object,
    open: v.transcript.open.object,
    challenge: v.transcript.challenge,
  };
  if (v.steps) {
    for (const [i, s] of v.steps.entries()) {
      const n = `${v.name}[${i}]`;
      checkEntry(`${n}.proof`, s.proof);
      assertOutcome(n, s.expect, s.reason, evalGrantRedemption({ ...base, proof: s.proof.object }, usedCnonces));
    }
  } else {
    checkEntry(`${v.name}.proof`, v.transcript.proof);
    assertOutcome(v.name, v.expect, v.reason, evalGrantRedemption({ ...base, proof: v.transcript.proof.object }, usedCnonces));
  }
}

// --- events.json / acks.json -------------------------------------------------

for (const f of ['events.json', 'acks.json']) {
  for (const v of load(f).vectors) {
    checkEntry(v.name, v);
    assertOutcome(v.name, v.expect, v.reason, evalControllerSigned(v.object, KEYS.controller.pub));
  }
}

// --- summary -----------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} failure(s) out of ${checked} checks.`);
  process.exit(1);
}
console.log(`OK — ${checked} checks passed across pairing/commands/grants/events/acks vectors.`);
