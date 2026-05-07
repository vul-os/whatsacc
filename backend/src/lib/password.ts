// PBKDF2-SHA256 password hashing via Web Crypto. Picked because:
//
// 1. Web Crypto's deriveBits runs in Cloudflare Workers' native C++ runtime,
//    not JS — doesn't count against the per-request 10ms CPU cap.
// 2. Free-tier compatible. argon2 (via @noble/hashes) used ~7s of CPU and
//    blew the limit; PBKDF2 with 600k iterations runs in ~10ms wall-clock,
//    ~0.1ms of "JS CPU time".
// 3. Standard, well-understood, OWASP-acceptable. Weaker than argon2 against
//    GPU/ASIC brute force but adequate for our threat model (we're not
//    storing secrets that justify a $1M attacker).
//
// Format on disk:
//   $pbkdf2-sha256$i=<iterations>$<saltB64>$<hashB64>
// e.g.
//   $pbkdf2-sha256$i=600000$AbCdEfGh...$XxYyZz...
//
// Verify reads iterations + salt from the encoded string, recomputes the
// hash, and constant-time-compares. Iterations stored per-record so we can
// raise them later without invalidating existing hashes.

// Cloudflare Workers' Web Crypto caps PBKDF2 iterations at 100_000 (their
// CPU-budget guardrail). 600k is the OWASP-2023 recommendation for SHA-256
// but isn't supported on this runtime — 100k still gives ~10ms-per-guess
// brute-force cost, which is acceptable for the threat model. Revisit if
// we ever move off Workers or want stronger hashing (Workers Paid + argon2).
const ITERATIONS = 100_000;
const HASH_LENGTH = 32;
const SALT_LENGTH = 16;

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const hash = await pbkdf2(plain, salt, ITERATIONS, HASH_LENGTH);
  return `$pbkdf2-sha256$i=${ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    // ['', 'pbkdf2-sha256', 'i=600000', saltB64, hashB64]
    if (parts.length !== 5) return false;
    if (parts[1] !== 'pbkdf2-sha256') return false;
    const m = /^i=(\d+)$/.exec(parts[2] ?? '');
    if (!m) return false;
    const iterations = Number(m[1]);
    if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 1_000_000) return false;
    const salt = b64decode(parts[3] ?? '');
    const expected = b64decode(parts[4] ?? '');
    if (salt.length === 0 || expected.length === 0) return false;
    const computed = await pbkdf2(plain, salt, iterations, expected.length);
    return constantTimeEqual(computed, expected);
  } catch (err) {
    console.error('[verifyPassword]', (err as Error).message);
    return false;
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  outLen: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    outLen * 8,
  );
  return new Uint8Array(bits);
}

function b64encode(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!);
  return btoa(str).replace(/=+$/, '');
}

function b64decode(s: string): Uint8Array {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
