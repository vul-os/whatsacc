// Integration tests for the WhatsApp conversational contract
// (src/routes/whatsapp.ts). The security suites already cover signature
// negatives and flood throttling; these tests cover the FUNCTIONALITY:
// message → intent → open / picker / instructional replies, exercised through
// the real signed webhook against the real DB, with outbound Meta Graph calls
// intercepted (tests/helpers/outbound.ts).
//
// Selection model (pinned here on purpose): pickers are WhatsApp INTERACTIVE
// list/button messages — selection happens via list_reply/button_reply ids
// (`select_loc:<uuid>`, `open_ap:<uuid>`), NOT via numbered text replies.
// A plain "2" is treated as irrelevant text and re-draws the menu.

import { assert, assertEquals, assertExists } from '../helpers/assert.ts';
import { bootTestApp, type AppHandle } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { registerUser, seedLocationWithAccessPoint } from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';
import { interceptOutbound, type OutboundIntercept } from '../helpers/outbound.ts';
import {
  accessLogsFor,
  adminSql,
  linkVerifiedPhone,
  postSignedWhatsApp,
  seedExtraAccessPoint,
  setEnvVars,
  waEnvelope,
  waInteractiveMessage,
  waTextMessage,
  waValueEnvelope,
  whatsappMessagesFor,
} from '../helpers/chat.ts';

const WA_SECRET = 'test-wa-secret';
const WA_PHONE_ID = '15550001111';

/** Standard env for a fully configured WhatsApp integration. */
function setWhatsAppEnv(): () => void {
  return setEnvVars({
    WHATSAPP_APP_SECRET: WA_SECRET,
    WHATSAPP_ACCESS_TOKEN: 'test-wa-access-token',
    WHATSAPP_PHONE_NUMBER_ID: WA_PHONE_ID,
    WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
  });
}

async function postText(app: AppHandle, fromNoPlus: string, text: string, messageId?: string) {
  return await postSignedWhatsApp(app, WA_SECRET, waEnvelope(waTextMessage(fromNoPlus, text, { messageId })));
}

async function postReply(
  app: AppHandle,
  fromNoPlus: string,
  kind: 'list_reply' | 'button_reply',
  replyId: string,
  title: string,
) {
  return await postSignedWhatsApp(app, WA_SECRET, waEnvelope(waInteractiveMessage(fromNoPlus, kind, replyId, title)));
}

/** Outbound reply bodies for a phone, JSON-stringified for content matching. */
async function outboundBodies(phoneE164: string): Promise<{ kind: string; status: string; json: string; body: unknown }[]> {
  const rows = await whatsappMessagesFor(phoneE164);
  return rows
    .filter((r) => r.direction === 'out')
    .map((r) => ({ kind: r.kind, status: r.status, json: JSON.stringify(r.body), body: r.body }));
}

async function grantUses(grantId: string): Promise<number> {
  const rows = await adminSql(
    async (tx) => await tx<{ uses_count: number }[]>`
      select uses_count from temporary_access_grants where id = ${grantId}
    `,
  );
  return Number(rows[0]!.uses_count);
}

// ---------------------------------------------------------------------------
// Webhook handshake
// ---------------------------------------------------------------------------

dbTest('wa flow: GET handshake echoes the challenge only for the right verify token', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  try {
    const ok = await app.request('GET', '/webhooks/whatsapp', {
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': 'chal-42' },
    });
    assertEquals(ok.status, 200);
    assertEquals(ok.text, 'chal-42');

    const bad = await app.request('GET', '/webhooks/whatsapp', {
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'chal-42' },
    });
    assertEquals(bad.status, 403);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// The core open flow
// ---------------------------------------------------------------------------

dbTest('wa flow: "open" from a linked phone with ONE gate opens it and replies Opening + close prompt', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const apId = seeded.access_point_id!;
    const phone = '27831230001';
    await linkVerifiedPhone(u.user_id, `+${phone}`);

    const r = await postText(app, phone, 'open');
    assertEquals(r.status, 200);
    assertEquals((r.body as { ok: boolean }).ok, true);

    // The gate actually opened: one successful access log via the whatsapp
    // source, attributed to the member behind the linked phone.
    const logs = await accessLogsFor(apId);
    assertEquals(logs.length, 1);
    assertEquals(logs[0]!.success, true);
    assertEquals(logs[0]!.source, 'whatsapp');
    assertEquals(logs[0]!.command, 'open');
    assertEquals(logs[0]!.user_id, u.user_id);

    // Two replies: the Opening confirmation and the close-button follow-up.
    const out = await outboundBodies(`+${phone}`);
    assertEquals(out.length, 2);
    assertEquals(out[0]!.kind, 'text');
    assert(out[0]!.json.includes('Opening Main gate...'), `got: ${out[0]!.json}`);
    assertEquals(out[1]!.kind, 'interactive');
    assert(out[1]!.json.includes('Would you like to close Main gate?'), `got: ${out[1]!.json}`);
    assert(out[1]!.json.includes(`close_ap:${apId}`), 'close button must carry the close_ap id');

    // Both were actually sent to Meta (mocked) and recorded as sent with the
    // provider message id.
    for (const row of out) {
      assertEquals(row.status, 'sent');
    }
    const calls = outbound.to('graph.facebook.com');
    assertEquals(calls.length, 2);
    const first = calls[0]!.body as { to: string; type: string; text: { body: string } };
    assertEquals(first.to, phone);
    assertEquals(first.type, 'text');
    assertEquals(first.text.body, 'Opening Main gate...');
    const second = calls[1]!.body as { type: string; interactive: { action: { buttons: Array<{ reply: { id: string } }> } } };
    assertEquals(second.type, 'interactive');
    assertEquals(second.interactive.action.buttons[0]!.reply.id, `close_ap:${apId}`);
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('wa flow: multiple gates → interactive gate picker; picking an entry opens THAT gate', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const mainApId = seeded.access_point_id!;
    const sideApId = await seedExtraAccessPoint(seeded.location_id, 'Side gate');
    const phone = '27831230002';
    await linkVerifiedPhone(u.user_id, `+${phone}`);

    // "open" is ambiguous with 2 gates → a list picker, not an open.
    assertEquals((await postText(app, phone, 'open')).status, 200);
    let out = await outboundBodies(`+${phone}`);
    assertEquals(out.length, 1);
    assertEquals(out[0]!.kind, 'interactive');
    assert(out[0]!.json.includes('Which gate would you like to open?'), `got: ${out[0]!.json}`);
    assert(out[0]!.json.includes(`open_ap:${mainApId}`), 'picker must list Main gate');
    assert(out[0]!.json.includes(`open_ap:${sideApId}`), 'picker must list Side gate');
    assertEquals((await accessLogsFor(mainApId)).length, 0, 'a picker is not an open');

    // Selecting the second entry (a list_reply carrying open_ap:<uuid>) opens
    // exactly that gate.
    assertEquals((await postReply(app, phone, 'list_reply', `open_ap:${sideApId}`, 'Side gate')).status, 200);
    const sideLogs = await accessLogsFor(sideApId);
    assertEquals(sideLogs.length, 1);
    assertEquals(sideLogs[0]!.success, true);
    assertEquals((await accessLogsFor(mainApId)).length, 0, 'the other gate must stay shut');
    out = await outboundBodies(`+${phone}`);
    assert(out.some((o) => o.json.includes('Opening Side gate...')), 'must confirm the selected gate');

    // A numbered text reply is NOT a selection — it falls through to the
    // irrelevant-text path and re-draws the menu instead of opening anything.
    assertEquals((await postText(app, phone, '2')).status, 200);
    out = await outboundBodies(`+${phone}`);
    const last = out[out.length - 1]!;
    assertEquals(last.kind, 'interactive');
    assert(last.json.includes('Which gate would you like to open?'), `got: ${last.json}`);
    assertEquals((await accessLogsFor(sideApId)).length, 1, '"2" must not open a gate');

    // Mentioning a gate by name in the command targets it directly.
    assertEquals((await postText(app, phone, 'open side gate')).status, 200);
    assertEquals((await accessLogsFor(sideApId)).length, 2);
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('wa flow: multiple locations → location picker → gate menu → open (full 3-step conversation)', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app);
    const s1 = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const s2 = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const phone = '27831230003';
    await linkVerifiedPhone(u.user_id, `+${phone}`);

    // Step 1: "open" with 2 locations → location list picker.
    assertEquals((await postText(app, phone, 'open')).status, 200);
    let out = await outboundBodies(`+${phone}`);
    assertEquals(out.length, 1);
    assert(out[0]!.json.includes('Which location do you want to use?'), `got: ${out[0]!.json}`);
    assert(out[0]!.json.includes(`select_loc:${s1.location_id}`));
    assert(out[0]!.json.includes(`select_loc:${s2.location_id}`));

    // Step 2: choosing location 2 → its gate menu (single gate → button).
    assertEquals(
      (await postReply(app, phone, 'list_reply', `select_loc:${s2.location_id}`, 'Test Location')).status,
      200,
    );
    out = await outboundBodies(`+${phone}`);
    const menu = out[out.length - 1]!;
    assertEquals(menu.kind, 'interactive');
    assert(menu.json.includes(`open_ap:${s2.access_point_id!}`), 'gate menu must target location 2 gates');
    assert(!menu.json.includes(`open_ap:${s1.access_point_id!}`), 'location 1 gates must not leak in');

    // Step 3: tapping the gate button opens it.
    assertEquals(
      (await postReply(app, phone, 'button_reply', `open_ap:${s2.access_point_id!}`, 'Open Main gate')).status,
      200,
    );
    const logs = await accessLogsFor(s2.access_point_id!);
    assertEquals(logs.length, 1);
    assertEquals(logs[0]!.success, true);
    assertEquals(logs[0]!.user_id, u.user_id);
    assertEquals((await accessLogsFor(s1.access_point_id!)).length, 0);

    // Picking a location with no active gates gets the honest empty answer.
    const s3 = await seedLocationWithAccessPoint(u.account_id, {});
    assertEquals(
      (await postReply(app, phone, 'list_reply', `select_loc:${s3.location_id}`, 'Test Location')).status,
      200,
    );
    out = await outboundBodies(`+${phone}`);
    assert(
      out[out.length - 1]!.json.includes('That location has no active gates or doors ready yet.'),
      `got: ${out[out.length - 1]!.json}`,
    );
  } finally {
    outbound.restore();
    restore();
  }
});

// ---------------------------------------------------------------------------
// Help / irrelevant text / not-linked
// ---------------------------------------------------------------------------

dbTest('wa flow: "hi" and irrelevant text both draw the welcome gate menu for a linked phone', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const phone = '27831230004';
    await linkVerifiedPhone(u.user_id, `+${phone}`);

    assertEquals((await postText(app, phone, 'hi')).status, 200);
    let out = await outboundBodies(`+${phone}`);
    assertEquals(out.length, 1);
    assertEquals(out[0]!.kind, 'interactive');
    const menuText = (out[0]!.body as { body: { text: string } }).body.text;
    assertEquals(
      menuText,
      'Welcome to Test Location. Message "open" any time, or tap below to open Main gate.',
    );
    assert(out[0]!.json.includes(`open_ap:${seeded.access_point_id!}`));

    // Arbitrary chatter draws the same instructional menu (fallback path).
    assertEquals((await postText(app, phone, 'what time does the plumber arrive?')).status, 200);
    out = await outboundBodies(`+${phone}`);
    assertEquals(out.length, 2);
    assertEquals(out[1]!.kind, 'interactive');
    assert(out[1]!.json.includes('Welcome to Test Location.'));

    // Nothing opened.
    assertEquals((await accessLogsFor(seeded.access_point_id!)).length, 0);
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('wa flow: unlinked phone gets the signup message with a wa_phone-prefilled link', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  const outbound = interceptOutbound();
  try {
    const phone = '27831230005';
    assertEquals((await postText(app, phone, 'hello')).status, 200);
    const out = await outboundBodies(`+${phone}`);
    assertEquals(out.length, 1);
    assertEquals(out[0]!.kind, 'text');
    const text = (out[0]!.body as { text: { body: string } }).text.body;
    assert(text.includes("This WhatsApp number isn't linked to a whatsacc account yet."), text);
    assert(text.includes('http://test.local/signup?wa_phone=%2B27831230005'), text);
    assert(text.includes("After signup, we'll ask if you want to connect this number."), text);
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('wa flow: linked phone with no location / no gates gets the matching setup nudge', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  const outbound = interceptOutbound();
  try {
    // Linked, member of an account with NO active locations (the signup HQ
    // location is deactivated).
    const u = await registerUser(app);
    await adminSql(async (tx) => {
      await tx`update locations set status = 'inactive' where account_id = ${u.account_id}`;
    });
    const phone = '27831230006';
    await linkVerifiedPhone(u.user_id, `+${phone}`);
    assertEquals((await postText(app, phone, 'open')).status, 200);
    let out = await outboundBodies(`+${phone}`);
    assertEquals(out.length, 1);
    let text = (out[0]!.body as { text: { body: string } }).text.body;
    assert(text.includes('Welcome to whatsacc. Your number is connected.'), text);
    assert(text.includes("You don't have a location set up yet."), text);
    assert(text.includes('http://test.local/app'), text);

    // Linked, exactly one active location but no active access points (the
    // signup HQ location is deactivated so the single-location copy fires).
    const u2 = await registerUser(app);
    await adminSql(async (tx) => {
      await tx`update locations set status = 'inactive' where account_id = ${u2.account_id}`;
    });
    await seedLocationWithAccessPoint(u2.account_id, {});
    const phone2 = '27831230007';
    await linkVerifiedPhone(u2.user_id, `+${phone2}`);
    assertEquals((await postText(app, phone2, 'open')).status, 200);
    out = await outboundBodies(`+${phone2}`);
    assertEquals(out.length, 1);
    text = (out[0]!.body as { text: { body: string } }).text.body;
    assert(text.includes('No gates or doors are ready at this location yet.'), text);
    assert(text.includes('http://test.local/app/access-points'), text);
  } finally {
    outbound.restore();
    restore();
  }
});

// ---------------------------------------------------------------------------
// Visitor grants over WhatsApp
// ---------------------------------------------------------------------------

dbTest('wa flow: visitor grant phone can open, uses are counted, exhaustion closes the door', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  const outbound = interceptOutbound();
  try {
    const owner = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(owner.account_id, { withAccessPoint: true });
    const apId = seeded.access_point_id!;
    const visitorPhone = '27831230008';

    const create = await app.request('POST', '/access/grants', {
      token: owner.access_token,
      json: {
        phone_e164: `+${visitorPhone}`,
        visitor_name: 'Themba (electrician)',
        ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        max_uses: 2,
        access_point_ids: [apId],
      },
    });
    assertEquals(create.status, 201);
    const grantId = (create.body as { id: string }).id;

    // Use 1 of 2: the visitor (whose phone is NOT linked to any account)
    // texts "open" — single grant, single location → direct open.
    assertEquals((await postText(app, visitorPhone, 'open')).status, 200);
    let logs = await accessLogsFor(apId);
    assertEquals(logs.length, 1);
    assertEquals(logs[0]!.success, true);
    assertEquals(logs[0]!.user_id, null, 'visitor opens are not attributed to a member');
    assertEquals(await grantUses(grantId), 1);
    let out = await outboundBodies(`+${visitorPhone}`);
    assert(out.some((o) => o.json.includes('Opening Main gate...')));

    // Use 2 of 2.
    assertEquals((await postText(app, visitorPhone, 'open')).status, 200);
    assertEquals(await grantUses(grantId), 2);
    assertEquals((await accessLogsFor(apId)).filter((l) => l.success).length, 2);

    // Exhausted grant + unlinked phone: text "open" now resolves ZERO access
    // points, so the visitor gets the signup message (the grant no longer
    // exists from their point of view).
    assertEquals((await postText(app, visitorPhone, 'open')).status, 200);
    out = await outboundBodies(`+${visitorPhone}`);
    assert(
      out[out.length - 1]!.json.includes("isn't linked to a whatsacc account yet"),
      `got: ${out[out.length - 1]!.json}`,
    );
    assertEquals((await accessLogsFor(apId)).filter((l) => l.success).length, 2, 'no extra open');

    // Replaying a stale open button after exhaustion is refused honestly.
    assertEquals((await postReply(app, visitorPhone, 'button_reply', `open_ap:${apId}`, 'Open Main gate')).status, 200);
    out = await outboundBodies(`+${visitorPhone}`);
    assert(
      out[out.length - 1]!.json.includes('Sorry, you no longer have access to this gate.'),
      `got: ${out[out.length - 1]!.json}`,
    );
    assertEquals(await grantUses(grantId), 2, 'refused replay must not consume a use');
  } finally {
    outbound.restore();
    restore();
  }
});

// ---------------------------------------------------------------------------
// Denial replies (exact copy where stable)
// ---------------------------------------------------------------------------

dbTest('wa flow: rate-limited open replies with the cooldown message; visitor uses are refunded', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  const restoreRate = setEnvVars({ RATE_OPEN_COOLDOWN_S: '10' });
  const outbound = interceptOutbound();
  try {
    const owner = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(owner.account_id, { withAccessPoint: true });
    const apId = seeded.access_point_id!;
    const visitorPhone = '27831230009';
    const create = await app.request('POST', '/access/grants', {
      token: owner.access_token,
      json: {
        phone_e164: `+${visitorPhone}`,
        ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        max_uses: 5,
        access_point_ids: [apId],
      },
    });
    assertEquals(create.status, 201);
    const grantId = (create.body as { id: string }).id;

    assertEquals((await postText(app, visitorPhone, 'open')).status, 200);
    assertEquals(await grantUses(grantId), 1);

    // Second open inside the 10s cooldown: denied with the exact copy, and
    // the grant use consumed for the denied attempt is refunded.
    assertEquals((await postText(app, visitorPhone, 'open')).status, 200);
    const out = await outboundBodies(`+${visitorPhone}`);
    const last = out[out.length - 1]!;
    assertEquals(last.kind, 'text');
    assertEquals((last.body as { text: { body: string } }).text.body, 'Too many opens — try again in ~1 min.');
    assertEquals(await grantUses(grantId), 1, 'denied attempt must refund the grant use');

    const logs = await accessLogsFor(apId);
    assertEquals(logs.filter((l) => l.success).length, 1);
    assertEquals(logs.filter((l) => !l.success && l.error === 'rate_limited').length, 1);
  } finally {
    outbound.restore();
    restoreRate();
    restore();
  }
});

dbTest('wa flow: quota-exceeded open replies with the daily-limit message', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  const outbound = interceptOutbound();
  try {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    await adminSql(async (tx) => {
      await tx`
        insert into account_members (account_id, user_id, role, status)
        values (${owner.account_id}, ${member.user_id}, 'member', 'active')
      `;
    });
    const seeded = await seedLocationWithAccessPoint(owner.account_id, { withAccessPoint: true });
    const apId = seeded.access_point_id!;
    const phone = '27831230010';
    await linkVerifiedPhone(member.user_id, `+${phone}`);

    const patch = await app.request('PATCH', `/locations/${seeded.location_id}/limits`, {
      token: owner.access_token,
      json: { max_opens_per_member_per_day: 1 },
    });
    assertEquals(patch.status, 200);

    assertEquals((await postText(app, phone, 'open')).status, 200);
    assertEquals((await accessLogsFor(apId)).filter((l) => l.success).length, 1);

    assertEquals((await postText(app, phone, 'open')).status, 200);
    const out = await outboundBodies(`+${phone}`);
    const last = out[out.length - 1]!;
    assertEquals(
      (last.body as { text: { body: string } }).text.body,
      'Daily limit reached for this location — contact your admin. The web portal: http://test.local/app',
    );
    assertEquals((await accessLogsFor(apId)).filter((l) => l.success).length, 1, 'quota must hold');
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('wa flow: suspended account replies with the suspension message and does not open', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const apId = seeded.access_point_id!;
    const phone = '27831230011';
    await linkVerifiedPhone(u.user_id, `+${phone}`);
    await adminSql(async (tx) => {
      await tx`update accounts set status = 'suspended' where id = ${u.account_id}`;
    });

    assertEquals((await postText(app, phone, 'open')).status, 200);
    const out = await outboundBodies(`+${phone}`);
    const last = out[out.length - 1]!;
    assertEquals(
      (last.body as { text: { body: string } }).text.body,
      'This account has been suspended by the gateway operator — the gate cannot be opened. Contact your operator for help.',
    );
    const logs = await accessLogsFor(apId);
    assertEquals(logs.filter((l) => l.success).length, 0);
    assertEquals(logs.filter((l) => l.error === 'account_suspended').length, 1);
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('wa flow: a disabled user is filtered out of access lookups and gets the honest disabled copy', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const phone = '27831230012';
    await linkVerifiedPhone(u.user_id, `+${phone}`);
    await adminSql(async (tx) => {
      await tx`update users set status = 'disabled' where id = ${u.user_id}`;
    });

    // FIXED (was pinned): the access lookups filter u.status = 'active', so
    // a disabled user's "open" resolves zero gates AND zero locations — and
    // used to fall through to the misleading "no location set up yet" nudge.
    // The webhook now detects "linked but no active linked user" in the same
    // single query and answers honestly (the portal says the same thing, so
    // nothing new is leaked to the phone). The gate still never opens.
    assertEquals((await postText(app, phone, 'open')).status, 200);
    const out = await outboundBodies(`+${phone}`);
    assertEquals(out.length, 1);
    const text = (out[0]!.body as { text: { body: string } }).text.body;
    assertEquals(text, 'This account is disabled — contact your admin.');
    assertEquals((await accessLogsFor(seeded.access_point_id!)).length, 0, 'gate must not open');
  } finally {
    outbound.restore();
    restore();
  }
});

// ---------------------------------------------------------------------------
// Webhook hygiene: dedupe, sibling bots, non-text messages, statuses
// ---------------------------------------------------------------------------

dbTest('wa flow: redelivered message id is processed once (single reply)', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app);
    await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const phone = '27831230013';
    await linkVerifiedPhone(u.user_id, `+${phone}`);

    const messageId = 'wamid.dedupe-1';
    assertEquals((await postText(app, phone, 'hi', messageId)).status, 200);
    assertEquals((await postText(app, phone, 'hi', messageId)).status, 200, 'retry still 200s');

    const rows = await whatsappMessagesFor(`+${phone}`);
    assertEquals(rows.filter((r) => r.direction === 'in').length, 1, 'one inbound row');
    assertEquals(rows.filter((r) => r.direction === 'out').length, 1, 'one reply, not two');
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('wa flow: messages for a sibling phone_number_id are ignored entirely', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  const outbound = interceptOutbound();
  try {
    const phone = '27831230014';
    const body = waEnvelope(waTextMessage(phone, 'open'), { phoneNumberId: 'someone-elses-bot' });
    const r = await postSignedWhatsApp(app, WA_SECRET, body);
    assertEquals(r.status, 200);
    const rows = await whatsappMessagesFor(`+${phone}`);
    assertEquals(rows.length, 0, 'sibling-bot traffic must not create chats or replies');
    assertEquals(outbound.calls.length, 0);

    // Our own phone_number_id in the metadata is processed normally.
    const ours = waEnvelope(waTextMessage(phone, 'hello'), { phoneNumberId: WA_PHONE_ID });
    assertEquals((await postSignedWhatsApp(app, WA_SECRET, ours)).status, 200);
    assertEquals((await whatsappMessagesFor(`+${phone}`)).filter((r) => r.direction === 'out').length, 1);
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('wa flow: location-share messages are logged but draw no reply; statuses-only payloads are no-ops', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppEnv();
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app);
    await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });
    const phone = '27831230015';
    await linkVerifiedPhone(u.user_id, `+${phone}`);

    // Pinned current behavior: only 'text' and 'interactive' message types
    // are conversational; a WhatsApp location share is persisted for audit
    // (kind = the raw message type) and otherwise ignored — no location-based
    // gate matching is implemented.
    const locationMsg = {
      id: `wamid.loc-${Date.now()}`,
      from: phone,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'location',
      location: { latitude: -33.9249, longitude: 18.4241 },
    };
    assertEquals((await postSignedWhatsApp(app, WA_SECRET, waEnvelope(locationMsg))).status, 200);
    const rows = await whatsappMessagesFor(`+${phone}`);
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.direction, 'in');
    assertEquals(rows[0]!.kind, 'location');
    assertEquals(outbound.calls.length, 0, 'no reply to a location share');

    // Delivery-status callbacks (no messages array) change nothing.
    const statuses = waValueEnvelope({
      statuses: [{ id: 'wamid.x', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) }],
    });
    assertEquals((await postSignedWhatsApp(app, WA_SECRET, statuses)).status, 200);
    assertEquals((await whatsappMessagesFor(`+${phone}`)).length, 1);
    assertEquals(outbound.calls.length, 0);
  } finally {
    outbound.restore();
    restore();
  }
});
