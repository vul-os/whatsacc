// Integration tests for the Slack conversational contract
// (src/routes/slack.ts): signed events ("open" DM → gate picker blocks,
// menu/help text, unlinked prompt) and block_actions interactions
// (open_gate → actual open + honest denials). Signature negatives live in
// tests/security/slack.test.ts — these tests cover FUNCTIONALITY, with
// outbound chat.postMessage calls intercepted (tests/helpers/outbound.ts).

import { assert, assertEquals } from '../helpers/assert.ts';
import { bootTestApp, type AppHandle } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { registerUser, seedLocationWithAccessPoint } from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';
import { interceptOutbound } from '../helpers/outbound.ts';
import {
  accessLogsFor,
  adminSql,
  linkSlackUser,
  postSignedSlack,
  seedExtraAccessPoint,
  setEnvVars,
  slackMessagesFor,
} from '../helpers/chat.ts';

const SLACK_SECRET = 'test-slack-signing-secret';

function setSlackEnv(): () => void {
  return setEnvVars({
    SLACK_SIGNING_SECRET: SLACK_SECRET,
    SLACK_BOT_TOKEN: 'xoxb-test-token',
  });
}

let slackTsSeq = 0;

function eventBody(user: string, channel: string, text: string): string {
  slackTsSeq += 1;
  return JSON.stringify({
    type: 'event_callback',
    team_id: 'T-TEST',
    event: {
      type: 'message',
      channel,
      user,
      text,
      ts: `${Math.floor(Date.now() / 1000)}.${String(slackTsSeq).padStart(6, '0')}`,
    },
  });
}

async function postEvent(app: AppHandle, user: string, channel: string, text: string) {
  return await postSignedSlack(
    app,
    SLACK_SECRET,
    '/webhooks/slack',
    eventBody(user, channel, text),
    'application/json',
  );
}

async function postOpenGateAction(app: AppHandle, user: string, channel: string, apId: string) {
  const payload = {
    type: 'block_actions',
    user: { id: user },
    channel: { id: channel },
    actions: [{ action_id: `open_gate:${apId}`, value: apId }],
  };
  return await postSignedSlack(
    app,
    SLACK_SECRET,
    '/webhooks/slack/interactions',
    `payload=${encodeURIComponent(JSON.stringify(payload))}`,
    'application/x-www-form-urlencoded',
  );
}

// ---------------------------------------------------------------------------

dbTest('slack flow: "open" DM from a linked user answers with the gate-picker blocks', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setSlackEnv();
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const sideApId = await seedExtraAccessPoint(seeded.location_id, 'Side gate');
    await linkSlackUser(u.user_id, 'U-LINKED-1');

    const r = await postEvent(app, 'U-LINKED-1', 'D-CHAN-1', 'open');

    // FIXED (was pinned): slack_messages.kind used to reject 'interactive'
    // (CHECK allowed only text/file/system), so the outbound INSERT blew up
    // 23514 AFTER the blocks were posted → 500 → Slack retried → duplicate
    // pickers, and the outbound row was never logged. The CHECK now includes
    // 'interactive' (migrations/20260505050000_fixes.sql): the webhook 200s
    // and the picker is persisted exactly once.
    assertEquals(r.status, 200);

    // The reply went to chat.postMessage ONCE with one open_gate button per
    // gate — no retry amplification.
    const calls = outbound.to('slack.com/api/chat.postMessage');
    assertEquals(calls.length, 1, 'exactly one picker sent');
    const sent = calls[0]!.body as {
      channel: string;
      text: string;
      blocks: Array<{ accessory?: { action_id: string; value: string } }>;
    };
    assertEquals(sent.channel, 'D-CHAN-1');
    assertEquals(sent.text, 'Select a gate to open');
    const actionIds = sent.blocks.map((b) => b.accessory?.action_id).filter(Boolean);
    assert(actionIds.includes(`open_gate:${seeded.access_point_id!}`), `got: ${JSON.stringify(actionIds)}`);
    assert(actionIds.includes(`open_gate:${sideApId}`), `got: ${JSON.stringify(actionIds)}`);

    // Presenting the picker never opens anything.
    assertEquals((await accessLogsFor(seeded.access_point_id!)).length, 0);
    assertEquals((await accessLogsFor(sideApId)).length, 0);

    // Both sides of the exchange are in the audit trail now: the inbound
    // text AND the outbound interactive picker (status 'sent').
    const rows = await slackMessagesFor('D-CHAN-1');
    assert(rows.some((m) => m.direction === 'in' && m.kind === 'text'));
    const outRows = rows.filter((m) => m.direction === 'out');
    assertEquals(outRows.length, 1, 'outbound picker logged exactly once');
    assertEquals(outRows[0]!.kind, 'interactive');
    assertEquals(outRows[0]!.status, 'sent');
    assert(
      JSON.stringify(outRows[0]!.body).includes(`open_gate:${seeded.access_point_id!}`),
      'logged body must carry the blocks',
    );
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('slack flow: "hi" answers the menu with the profile display name; unknown text also menus', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setSlackEnv();
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app, { display_name: 'Naledi' });
    await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    await linkSlackUser(u.user_id, 'U-LINKED-2');

    assertEquals((await postEvent(app, 'U-LINKED-2', 'D-CHAN-2', 'hi')).status, 200);
    let calls = outbound.to('slack.com/api/chat.postMessage');
    assertEquals(calls.length, 1);
    const text = (calls[0]!.body as { text: string }).text;
    assert(text.startsWith('Hi Naledi.'), text);
    assert(text.includes('Send "open" to see available gates'), text);

    // Unrecognized chatter draws the same menu.
    assertEquals((await postEvent(app, 'U-LINKED-2', 'D-CHAN-2', 'what is the wifi password')).status, 200);
    calls = outbound.to('slack.com/api/chat.postMessage');
    assertEquals(calls.length, 2);
    assert((calls[1]!.body as { text: string }).text.startsWith('Hi Naledi.'));
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('slack flow: unlinked slack user asking "open" gets the link prompt with their user id', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setSlackEnv();
  const outbound = interceptOutbound();
  try {
    assertEquals((await postEvent(app, 'U-STRANGER', 'D-CHAN-3', 'open')).status, 200);
    const calls = outbound.to('slack.com/api/chat.postMessage');
    assertEquals(calls.length, 1);
    const text = (calls[0]!.body as { text: string }).text;
    assert(text.includes("I don't know which lintel profile this Slack user belongs to yet."), text);
    assert(text.includes('U-STRANGER'), 'prompt must tell the user which Slack ID to link');
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('slack flow: linked user with no gate access gets the honest empty answer', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setSlackEnv();
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app); // signup location has no access points
    await linkSlackUser(u.user_id, 'U-LINKED-3');
    assertEquals((await postEvent(app, 'U-LINKED-3', 'D-CHAN-4', 'open')).status, 200);
    const calls = outbound.to('slack.com/api/chat.postMessage');
    assertEquals(calls.length, 1);
    assertEquals(
      (calls[0]!.body as { text: string }).text,
      "You don't have any active gate access. Please contact the administrator.",
    );
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('slack flow: block_actions open_gate opens the gate and acks with Opening', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setSlackEnv();
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const apId = seeded.access_point_id!;
    await linkSlackUser(u.user_id, 'U-LINKED-4');

    const r = await postOpenGateAction(app, 'U-LINKED-4', 'D-CHAN-5', apId);
    assertEquals(r.status, 200);
    assertEquals((r.body as { ok: boolean }).ok, true);

    const logs = await accessLogsFor(apId);
    assertEquals(logs.length, 1);
    assertEquals(logs[0]!.success, true);
    assertEquals(logs[0]!.source, 'slack');
    assertEquals(logs[0]!.user_id, u.user_id);

    const calls = outbound.to('slack.com/api/chat.postMessage');
    assertEquals(calls.length, 1);
    assertEquals((calls[0]!.body as { text: string }).text, '✅ Opening gate...');
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('slack flow: block_actions for a gate outside the user access set is refused honestly', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setSlackEnv();
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app);
    await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const other = await registerUser(app);
    const foreign = await seedLocationWithAccessPoint(other.account_id, { withAccessPoint: true });
    await linkSlackUser(u.user_id, 'U-LINKED-5');

    // A forged/stale button for ANOTHER tenant's gate: no open, honest reply.
    const r = await postOpenGateAction(app, 'U-LINKED-5', 'D-CHAN-6', foreign.access_point_id!);
    assertEquals(r.status, 200);
    assertEquals((await accessLogsFor(foreign.access_point_id!)).length, 0, 'cross-tenant gate must stay shut');
    const calls = outbound.to('slack.com/api/chat.postMessage');
    assertEquals(calls.length, 1);
    assertEquals(
      (calls[0]!.body as { text: string }).text,
      '❌ Sorry, you no longer have access to this gate.',
    );

    // From an UNLINKED slack user the interaction is silently dropped (ack
    // only, no reply, no open) — pinned current behavior.
    const r2 = await postOpenGateAction(app, 'U-NOBODY', 'D-CHAN-6', foreign.access_point_id!);
    assertEquals(r2.status, 200);
    assertEquals(outbound.to('slack.com/api/chat.postMessage').length, 1, 'no reply for unlinked user');
    assertEquals((await accessLogsFor(foreign.access_point_id!)).length, 0);
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('slack flow: rate-limited block_actions open replies with the cooldown denial copy', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setSlackEnv();
  const restoreRate = setEnvVars({ RATE_OPEN_COOLDOWN_S: '10' });
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const apId = seeded.access_point_id!;
    await linkSlackUser(u.user_id, 'U-LINKED-6');

    assertEquals((await postOpenGateAction(app, 'U-LINKED-6', 'D-CHAN-7', apId)).status, 200);
    assertEquals((await postOpenGateAction(app, 'U-LINKED-6', 'D-CHAN-7', apId)).status, 200);

    const logs = await accessLogsFor(apId);
    assertEquals(logs.filter((l) => l.success).length, 1);
    assertEquals(logs.filter((l) => !l.success && l.error === 'rate_limited').length, 1);

    const calls = outbound.to('slack.com/api/chat.postMessage');
    assertEquals(calls.length, 2);
    assertEquals((calls[0]!.body as { text: string }).text, '✅ Opening gate...');
    assertEquals((calls[1]!.body as { text: string }).text, 'Too many opens — try again in ~1 min.');
  } finally {
    outbound.restore();
    restoreRate();
    restore();
  }
});

dbTest('slack flow: bot messages are ignored (no chat rows, no replies, no loops)', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setSlackEnv();
  const outbound = interceptOutbound();
  try {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T-TEST',
      event: {
        type: 'message',
        channel: 'D-CHAN-8',
        user: 'U-ANY',
        bot_id: 'B-OURSELVES',
        text: 'open',
        ts: `${Math.floor(Date.now() / 1000)}.000001`,
      },
    });
    const r = await postSignedSlack(app, SLACK_SECRET, '/webhooks/slack', body, 'application/json');
    assertEquals(r.status, 200);
    assertEquals((await slackMessagesFor('D-CHAN-8')).length, 0);
    assertEquals(outbound.calls.length, 0, 'the bot must never answer bots');
  } finally {
    outbound.restore();
    restore();
  }
});
