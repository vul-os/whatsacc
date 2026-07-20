// proto/vectors/lib.mjs — shared helpers for the lintel conformance vectors.
// Node builtins only (node:crypto). No external dependencies.
//
// ############################################################################
// ##  TEST KEYS ONLY.  The Ed25519 seeds below are PUBLIC, deterministic     ##
// ##  test constants (sha256 of a label string). They exist so conformance  ##
// ##  vectors are reproducible byte-for-byte. NEVER use them, or anything   ##
// ##  derived from them, in a real gateway, controller or app.              ##
// ############################################################################

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64u = (s) => Buffer.from(s, 'base64url');

// --- Ed25519 over raw 32-byte keys ------------------------------------------
// Node only speaks DER, so we wrap/unwrap the raw keys with the fixed
// PKCS#8 / SPKI prefixes for Ed25519 (RFC 8410).

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function keyFromSeedHex(seedHex) {
  const seed = Buffer.from(seedHex, 'hex');
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  const pub = Buffer.from(spki.subarray(spki.length - 32)); // raw 32-byte public key
  return { seedHex, priv, pub, pubHex: pub.toString('hex'), pubB64u: b64u(pub) };
}

export function signRaw(privKeyObj, bytes) {
  return cryptoSign(null, bytes, privKeyObj); // Ed25519: algorithm must be null
}

export function verifyRaw(pub32, bytes, sig) {
  const key = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(pub32)]),
    format: 'der',
    type: 'spki',
  });
  return cryptoVerify(null, bytes, key, sig);
}

// --- Minimal JCS (RFC 8785) canonicalization --------------------------------
// Subset notes (documented in README.md):
//  * Object keys sorted by UTF-16 code units — exactly what Array.sort() does
//    for strings, which is what RFC 8785 §3.2.3 requires.
//  * No insignificant whitespace.
//  * Numbers serialized via ECMAScript Number-to-string (JSON.stringify), which
//    is the RFC 8785 §3.2.2.3 rule verbatim. Non-finite numbers are rejected.
//  * Strings serialized via JSON.stringify, whose escaping (two-char escapes
//    \" \\ \b \f \n \r \t, \u00xx lowercase-hex for other control chars,
//    everything else literal) matches RFC 8785 §3.2.2.2.
//  * Not handled (never appears in these vectors): lone surrogates.

export function jcs(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS: non-finite number');
    return JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).sort(); // UTF-16 code unit order
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + jcs(value[k])).join(',') +
      '}'
    );
  }
  throw new Error('JCS: unsupported type ' + t);
}

/** Canonical bytes of a wire object with its top-level `sig` removed. */
export function canonicalMinusSig(obj) {
  const { sig, ...rest } = obj;
  return jcs(rest);
}

/** Sign `obj` (which must NOT already contain `sig`). Returns wire object + canonical. */
export function signObject(obj, key) {
  if ('sig' in obj) throw new Error('object already has sig');
  const canonical = jcs(obj);
  const sig = b64u(signRaw(key.priv, Buffer.from(canonical, 'utf8')));
  return { object: { ...obj, sig }, canonical };
}

/** Verify a wire object's `sig` against a raw 32-byte public key. */
export function verifyObject(obj, pub32) {
  if (typeof obj.sig !== 'string' || obj.sig.length === 0) return false;
  const canonical = canonicalMinusSig(obj);
  return verifyRaw(pub32, Buffer.from(canonical, 'utf8'), fromB64u(obj.sig));
}

// --- Fixed test keys ---------------------------------------------------------
// Each seed is sha256("lintel-test-vector:<name>") — hardcoded so the vectors
// never depend on the hash being recomputed. TEST KEYS ONLY (see banner above).

export const SEEDS = {
  gateway: '70aa01ee88373ba4d1088fe27ba9d4e7b5ad63b71210e7acb2ec4590d0ff79fd',
  gateway_next: 'a85f2ec11eef0ed26b37dbbb71ba23888d03971551b986d2db296086abe351d6',
  controller: 'b277bf5b83293f641115af6d4b21d4bef2b71b5d3be87a53cb3db4810ed1b548',
  app: 'bcf59d31ae4b740fdfab264ee3363240edac395f588a604f4ad7dc930041b89c',
  attacker: '913b84e1755084a2790c9d8b8b21b494265dd4dafae9f6459e3525a46467c832',
};

export const KEYS = Object.fromEntries(
  Object.entries(SEEDS).map(([name, seedHex]) => [name, keyFromSeedHex(seedHex)])
);
