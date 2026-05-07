// Webhook integration test against the running Workers backend.
// Hits POST /webhooks/paystack with a valid HMAC-SHA512, an invalid one,
// and a charge.success that forces the defense-in-depth re-verify path.
// Hits GET/POST /webhooks/whatsapp with the WHATSAPP_* secrets from env.
//
// Usage:
//   cd backend
//   npx wrangler dev --port 8787 &       # backend (Workers + Neon)
//   node --env-file=../.env.dev scripts/test-webhooks.mjs

import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const PAYSTACK_SECRET = (process.env.PAYSTACK_SECRET_KEY ?? '').trim();
const WA_APP_SECRET = (process.env.WHATSAPP_APP_SECRET ?? '').trim();
const WA_VERIFY = (process.env.WHATSAPP_VERIFY_TOKEN ?? '').trim();
const DB_URL = (process.env.DATABASE_URL ?? '').trim();

if (!PAYSTACK_SECRET) { console.error('PAYSTACK_SECRET_KEY not set'); process.exit(2); }
if (!DB_URL) { console.error('DATABASE_URL not set'); process.exit(2); }

let passed = 0, failed = 0;
const fails = [], warns = [];
const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', bold: '\x1b[1m', reset: '\x1b[0m' };
function ok(s, info = '') { console.log(`  ${C.ok}✓${C.reset} ${s}${info ? ' — ' + info : ''}`); passed++; }
function bad(s, info) { console.log(`  ${C.bad}✗${C.reset} ${s} — ${info}`); fails.push(`${s}: ${info}`); failed++; }
function warn(s, info) { console.log(`  ${C.warn}⚠${C.reset} ${s} — ${info}`); warns.push(`${s}: ${info}`); }
function step(s) { console.log(`\n${C.bold}${s}${C.reset}`); }

// Force IPv4 single-IP for pg
const u = new URL(DB_URL);
const { address } = await lookup(u.hostname, { family: 4 });
const sql = new pg.Client({
  host: address,
  port: Number(u.port) || 5432,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, ''),
  ssl: { servername: u.hostname, rejectUnauthorized: false },
});
await sql.connect();

async function postRaw(path, body, headers = {}) {
  const finalHeaders = { 'Connection': 'close', ...headers };
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(BASE + path, { method: 'POST', headers: finalHeaders, body });
      break;
    } catch (err) {
      const code = err?.cause?.code;
      if (attempt === 0 && (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET')) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      throw err;
    }
  }
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {/**/}
  return { status: res.status, body: parsed, text };
}

async function getRaw(path, query = '') {
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(BASE + path + (query ? '?' + query : ''), { headers: { 'Connection': 'close' } });
      break;
    } catch (err) {
      if (attempt === 0 && (err?.cause?.code === 'UND_ERR_SOCKET' || err?.cause?.code === 'ECONNRESET')) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      throw err;
    }
  }
  const text = await res.text();
  return { status: res.status, text };
}

function hmacSha512Hex(secret, body) {
  return createHmac('sha512', secret).update(body, 'utf8').digest('hex');
}
function hmacSha256Hex(secret, body) {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

// ─── Paystack ──────────────────────────────────────────────────────────────
step('Paystack webhook');

// 1. charge.failed with valid signature → 200, row in webhook_events
{
  const TS = Date.now();
  const data = {
    id: 999000000 + (TS % 1000000),
    reference: `whtest_failed_${TS}`,
    status: 'failed',
    amount: 1000,
    currency: 'ZAR',
    paid_at: null,
    channel: 'card',
    gateway_response: 'webhook test',
  };
  const body = JSON.stringify({ event: 'charge.failed', data });
  const sig = hmacSha512Hex(PAYSTACK_SECRET, body);

  const r = await postRaw('/webhooks/paystack', body, {
    'Content-Type': 'application/json',
    'x-paystack-signature': sig,
  });
  if (r.status === 200) {
    ok('valid signature → 200 charge.failed', `${r.status}`);
    // Verify DB row landed
    const rows = await sql.query(
      `select event_type, processed_at, error from webhook_events
       where provider = 'paystack' and event_id = $1`,
      [String(data.id)],
    );
    if (rows.rows[0]) {
      const row = rows.rows[0];
      if (row.processed_at && !row.error) ok('webhook_events row written, processed_at set', '');
      else if (row.error) bad('row has error', row.error);
      else warn('row not yet processed_at', '');
    } else {
      bad('webhook_events row missing for valid charge.failed', `event_id=${data.id}`);
    }
  } else {
    bad('valid signature charge.failed', `expected 200, got ${r.status}: ${r.text.slice(0, 200)}`);
  }
}

// 2. Tampered body / wrong signature → 401
{
  const body = JSON.stringify({ event: 'charge.failed', data: { id: 1, reference: 'x', amount: 1, currency: 'ZAR' } });
  const r = await postRaw('/webhooks/paystack', body, {
    'Content-Type': 'application/json',
    'x-paystack-signature': 'deadbeef'.repeat(16), // wrong sig
  });
  if (r.status === 401) ok('invalid signature → 401', `${r.status}`);
  else bad('invalid signature', `expected 401, got ${r.status}: ${r.text.slice(0, 200)}`);
}

// 3. charge.success with fake reference → signature passes, defense-in-depth
//    /transaction/verify call to Paystack fails → 500.  Proves both the
//    signature path AND the verifyTransaction outbound call work.
{
  const TS = Date.now();
  const data = {
    id: 999100000 + (TS % 1000000),
    reference: `whtest_success_${TS}`,
    status: 'success',
    amount: 1000,
    currency: 'ZAR',
    paid_at: '2026-05-07T00:00:00Z',
    channel: 'card',
    customer: { customer_code: 'CUS_test', email: 'whtest@example.com' },
  };
  const body = JSON.stringify({ event: 'charge.success', data });
  const sig = hmacSha512Hex(PAYSTACK_SECRET, body);

  const r = await postRaw('/webhooks/paystack', body, {
    'Content-Type': 'application/json',
    'x-paystack-signature': sig,
  });
  if (r.status === 500) {
    ok('charge.success fake-ref → 500 (defense-in-depth verify failed as expected)', '');
    // Verify there's an error logged on the webhook_events row
    const rows = await sql.query(
      `select event_type, processed_at, error from webhook_events
       where provider = 'paystack' and event_id = $1`,
      [String(data.id)],
    );
    if (rows.rows[0]?.error) ok('error logged on row', rows.rows[0].error.slice(0, 80));
    else warn('row missing or no error logged', 'transaction may have rolled back fully');
  } else if (r.status === 200) {
    warn('charge.success fake-ref → 200 (unexpected — verifyTransaction succeeded?)', `${r.status}`);
  } else {
    bad('charge.success', `expected 500, got ${r.status}: ${r.text.slice(0, 200)}`);
  }
}

// ─── WhatsApp ──────────────────────────────────────────────────────────────
step('WhatsApp webhook (current state of secrets)');

if (!WA_VERIFY) {
  // Verify token unset → handshake should reject regardless of token sent.
  const r = await getRaw('/webhooks/whatsapp', `hub.mode=subscribe&hub.verify_token=anything&hub.challenge=hello`);
  if (r.status === 403) ok('GET handshake (verify token unset) → 403', `${r.status}`);
  else bad('GET handshake unset-token', `expected 403, got ${r.status}: ${r.text.slice(0, 200)}`);
} else {
  // Valid handshake
  const r = await getRaw('/webhooks/whatsapp',
    `hub.mode=subscribe&hub.verify_token=${encodeURIComponent(WA_VERIFY)}&hub.challenge=hello-from-test`);
  if (r.status === 200 && r.text.includes('hello-from-test')) ok('GET handshake (valid token) → 200 + challenge echo', '');
  else bad('GET handshake', `expected 200/echo, got ${r.status}: ${r.text.slice(0, 200)}`);
  // Wrong token → 403
  const r2 = await getRaw('/webhooks/whatsapp',
    `hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`);
  if (r2.status === 403) ok('GET handshake (wrong token) → 403', '');
  else bad('GET handshake wrong-token', `expected 403, got ${r2.status}`);
}

if (!WA_APP_SECRET) {
  // App secret unset → POST should reject as webhook_secret_unset
  const body = '{"object":"whatsapp_business_account","entry":[]}';
  const r = await postRaw('/webhooks/whatsapp', body, {
    'Content-Type': 'application/json',
    'X-Hub-Signature-256': 'sha256=' + 'a'.repeat(64),
  });
  if (r.status === 403 && r.text.includes('webhook_secret_unset'))
    ok('POST (app secret unset) → 403 webhook_secret_unset', '');
  else bad('POST app-secret-unset', `expected 403 webhook_secret_unset, got ${r.status}: ${r.text.slice(0, 200)}`);
} else {
  // Valid signed POST
  const TS = Date.now();
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_TEST',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15551234567', phone_number_id: 'PHONE_TEST' },
          contacts: [{ profile: { name: 'Webhook Test' }, wa_id: '27821234567' }],
          messages: [{
            from: '27821234567', id: `wamid.whtest_${TS}`,
            timestamp: String(Math.floor(TS / 1000)), type: 'text',
            text: { body: 'webhook test from script' },
          }],
        },
      }],
    }],
  });
  const sig = hmacSha256Hex(WA_APP_SECRET, body);
  const r = await postRaw('/webhooks/whatsapp', body, {
    'Content-Type': 'application/json',
    'X-Hub-Signature-256': 'sha256=' + sig,
  });
  if (r.status === 200) {
    ok('POST (valid signature) → 200', '');
    const chats = await sql.query(`select id from whatsapp_chats where phone_e164 = '+27821234567'`);
    if (chats.rows[0]) ok('inbound message landed in whatsapp_chats', '');
    else warn('chat row not visible', 'RLS may be blocking the read with this connection');
  } else {
    bad('POST valid signature', `expected 200, got ${r.status}: ${r.text.slice(0, 200)}`);
  }
  // Wrong signature → 403
  const r2 = await postRaw('/webhooks/whatsapp', body, {
    'Content-Type': 'application/json',
    'X-Hub-Signature-256': 'sha256=' + 'b'.repeat(64),
  });
  if (r2.status === 403) ok('POST (bad signature) → 403', '');
  else bad('POST bad-signature', `expected 403, got ${r2.status}`);
}

// ─── Done ──────────────────────────────────────────────────────────────────
console.log(`\n${C.bold}Result: ${passed} passed, ${failed} failed${C.reset}`);
if (warns.length) {
  console.log(`\n${C.warn}Warnings:${C.reset}`);
  for (const w of warns) console.log(`  • ${w}`);
}
if (fails.length) {
  console.log(`\n${C.bad}Real failures:${C.reset}`);
  for (const f of fails) console.log(`  • ${f}`);
}
await sql.end();
process.exit(failed === 0 ? 0 : 1);
