// Security tests for Slack webhook authentication (events + interactions).
//
// The verification is FAIL-CLOSED: with SLACK_SIGNING_SECRET configured,
// missing headers, stale timestamps (replay window), and tampered
// signatures are all 403 — omitting the signature header must never skip
// verification (that was the bypass: unauthenticated block_actions could
// reach gate actuation). Without a configured secret the endpoints refuse
// to process at all.

import { assert, assertEquals } from '../helpers/assert.ts';
import { resetEnvCache } from '@/lib/env.ts';
import { bootTestApp, type AppHandle } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { dbTest } from '../helpers/test.ts';

const SLACK_SECRET = 'test-slack-signing-secret';

function setSlackSecret(value: string | undefined): void {
  if (value === undefined) delete process.env.SLACK_SIGNING_SECRET;
  else process.env.SLACK_SIGNING_SECRET = value;
  resetEnvCache();
}

async function signSlack(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const bytes = new Uint8Array(sig);
  let hex = 'v0=';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

function nowTs(offsetS = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetS);
}

// url_verification is handled before any DB access — a pure signature probe.
const CHALLENGE_BODY = JSON.stringify({ type: 'url_verification', challenge: 'chal-123' });

async function postEvents(
  app: AppHandle,
  body: string,
  headers: Record<string, string> = {},
) {
  return await app.request('POST', '/webhooks/slack', {
    rawBody: body,
    contentType: 'application/json',
    headers,
  });
}

async function postInteractions(
  app: AppHandle,
  body: string,
  headers: Record<string, string> = {},
) {
  return await app.request('POST', '/webhooks/slack/interactions', {
    rawBody: body,
    contentType: 'application/x-www-form-urlencoded',
    headers,
  });
}

// A benign interactions payload (unknown type — no DB, no side effects).
const INTERACTION_BODY = `payload=${encodeURIComponent(JSON.stringify({ type: 'noop' }))}`;

dbTest('sec: slack — missing signature headers are rejected when the secret is set', async () => {
  await resetData();
  const app = await bootTestApp();
  setSlackSecret(SLACK_SECRET);
  try {
    // No headers at all.
    const bare = await postEvents(app, CHALLENGE_BODY);
    assertEquals(bare.status, 403);
    assertEquals((bare.body as { error: string }).error, 'bad_signature');

    // Timestamp without signature — still rejected.
    const tsOnly = await postEvents(app, CHALLENGE_BODY, {
      'X-Slack-Request-Timestamp': nowTs(),
    });
    assertEquals(tsOnly.status, 403);

    // Signature without timestamp — still rejected.
    const ts = nowTs();
    const sigOnly = await postEvents(app, CHALLENGE_BODY, {
      'X-Slack-Signature': await signSlack(SLACK_SECRET, ts, CHALLENGE_BODY),
    });
    assertEquals(sigOnly.status, 403);

    // Interactions endpoint mirrors the same fail-closed behavior.
    const inter = await postInteractions(app, INTERACTION_BODY);
    assertEquals(inter.status, 403);
    assertEquals((inter.body as { error: string }).error, 'bad_signature');
  } finally {
    setSlackSecret(undefined);
  }
});

dbTest('sec: slack — stale timestamps outside the 300s replay window are rejected', async () => {
  await resetData();
  const app = await bootTestApp();
  setSlackSecret(SLACK_SECRET);
  try {
    // A validly signed request whose timestamp is 400s old: replay attempt.
    const stale = nowTs(-400);
    const staleSig = await signSlack(SLACK_SECRET, stale, CHALLENGE_BODY);
    const r = await postEvents(app, CHALLENGE_BODY, {
      'X-Slack-Request-Timestamp': stale,
      'X-Slack-Signature': staleSig,
    });
    assertEquals(r.status, 403);
    assertEquals((r.body as { error: string }).error, 'bad_signature');

    // Future-dated timestamps are equally rejected.
    const future = nowTs(400);
    const futureSig = await signSlack(SLACK_SECRET, future, CHALLENGE_BODY);
    const f = await postEvents(app, CHALLENGE_BODY, {
      'X-Slack-Request-Timestamp': future,
      'X-Slack-Signature': futureSig,
    });
    assertEquals(f.status, 403);

    // Non-numeric timestamp garbage is rejected too.
    const junkSig = await signSlack(SLACK_SECRET, 'not-a-number', CHALLENGE_BODY);
    const j = await postEvents(app, CHALLENGE_BODY, {
      'X-Slack-Request-Timestamp': 'not-a-number',
      'X-Slack-Signature': junkSig,
    });
    assertEquals(j.status, 403);

    // Same on interactions.
    const iSig = await signSlack(SLACK_SECRET, stale, INTERACTION_BODY);
    const i = await postInteractions(app, INTERACTION_BODY, {
      'X-Slack-Request-Timestamp': stale,
      'X-Slack-Signature': iSig,
    });
    assertEquals(i.status, 403);
  } finally {
    setSlackSecret(undefined);
  }
});

dbTest('sec: slack — valid signature passes; tampered body/signature fails', async () => {
  await resetData();
  const app = await bootTestApp();
  setSlackSecret(SLACK_SECRET);
  try {
    const ts = nowTs();
    const sig = await signSlack(SLACK_SECRET, ts, CHALLENGE_BODY);

    // Valid: events endpoint answers the url_verification challenge.
    const ok = await postEvents(app, CHALLENGE_BODY, {
      'X-Slack-Request-Timestamp': ts,
      'X-Slack-Signature': sig,
    });
    assertEquals(ok.status, 200);
    assertEquals((ok.body as { challenge: string }).challenge, 'chal-123');

    // Tampered: same signature over a different body is rejected.
    const tamperedBody = JSON.stringify({ type: 'url_verification', challenge: 'evil' });
    const bad = await postEvents(app, tamperedBody, {
      'X-Slack-Request-Timestamp': ts,
      'X-Slack-Signature': sig,
    });
    assertEquals(bad.status, 403);

    // Tampered: flipped signature byte is rejected.
    const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
    const bad2 = await postEvents(app, CHALLENGE_BODY, {
      'X-Slack-Request-Timestamp': ts,
      'X-Slack-Signature': flipped,
    });
    assertEquals(bad2.status, 403);

    // Valid interactions request passes.
    const iSig = await signSlack(SLACK_SECRET, ts, INTERACTION_BODY);
    const i = await postInteractions(app, INTERACTION_BODY, {
      'X-Slack-Request-Timestamp': ts,
      'X-Slack-Signature': iSig,
    });
    assertEquals(i.status, 200);
  } finally {
    setSlackSecret(undefined);
  }
});

dbTest('sec: slack — without a configured secret the endpoints refuse to process', async () => {
  await resetData();
  const app = await bootTestApp();
  setSlackSecret(undefined);
  // Even a "validly signed" request (attacker knows some secret) is refused:
  // the integration is off until the operator configures the secret.
  const ts = nowTs();
  const sig = await signSlack('any-secret', ts, CHALLENGE_BODY);
  const r = await postEvents(app, CHALLENGE_BODY, {
    'X-Slack-Request-Timestamp': ts,
    'X-Slack-Signature': sig,
  });
  assertEquals(r.status, 403);
  assertEquals((r.body as { error: string }).error, 'slack_not_configured');

  const i = await postInteractions(app, INTERACTION_BODY);
  assertEquals(i.status, 403);
  assertEquals((i.body as { error: string }).error, 'slack_not_configured');
});
