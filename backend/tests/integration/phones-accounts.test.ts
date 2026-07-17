// Integration tests for profile phone management (src/routes/phones.ts,
// mounted at /phones → full path /phones/me/phones) and account management
// (src/routes/accounts.ts): membership listing, invites (create/accept and
// every guard), and role changes via re-invite. Checked first: no other
// suite covers these endpoints (auth.test.ts covers register/login/tokens;
// admin.test.ts covers the /admin surfaces; pentest only auth-probes
// /accounts).

import { assert, assertEquals, assertExists } from '../helpers/assert.ts';
import { bootTestApp, type AppHandle } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { registerUser, seedLocationWithAccessPoint } from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';
import { interceptOutbound } from '../helpers/outbound.ts';
import { adminSql, setEnvVars } from '../helpers/chat.ts';

type PhoneRow = { id: string; phone_e164: string; verified_at: string | null; is_primary: boolean };

function setWhatsAppSendEnv(): () => void {
  return setEnvVars({
    WHATSAPP_ACCESS_TOKEN: 'test-wa-access-token',
    WHATSAPP_PHONE_NUMBER_ID: '15550001111',
  });
}

async function listPhones(app: AppHandle, token: string): Promise<PhoneRow[]> {
  const r = await app.request('GET', '/phones/me/phones', { token });
  assertEquals(r.status, 200);
  return (r.body as { phones: PhoneRow[] }).phones;
}

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

dbTest('phones: add + list + primary ordering; invalid E.164 is rejected', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  const add1 = await app.request('POST', '/phones/me/phones', {
    token: u.access_token,
    json: { phone_e164: '+27831112221' },
  });
  assertEquals(add1.status, 201);
  const add2 = await app.request('POST', '/phones/me/phones', {
    token: u.access_token,
    json: { phone_e164: '+27831112222', is_primary: true },
  });
  assertEquals(add2.status, 201);

  const phones = await listPhones(app, u.access_token);
  assertEquals(phones.length, 2);
  // Primary sorts first.
  assertEquals(phones[0]!.phone_e164, '+27831112222');
  assertEquals(phones[0]!.is_primary, true);
  assertEquals(phones[1]!.phone_e164, '+27831112221');

  // TODO(REAL FINDING — documented, not fixed; tests must not touch src/):
  // src/routes/phones.ts inserts new phones with verified_at = now() — a
  // phone is "verified" the moment it is typed in, with no OTP challenge,
  // and the /verify endpoint below is a placeholder that accepts ANY
  // 6-digit code (TODO comment in src). Since a verified phone is exactly
  // what the WhatsApp webhook trusts for gate access, any member can attach
  // an arbitrary phone number (including someone else's) and that number's
  // WhatsApp immediately controls the member's gates. Pinned here.
  for (const p of phones) {
    assertExists(p.verified_at, 'phones are auto-verified on add (see TODO)');
  }

  // Not E.164 → zod 400.
  const bad = await app.request('POST', '/phones/me/phones', {
    token: u.access_token,
    json: { phone_e164: '0831112223' },
  });
  assertEquals(bad.status, 400);

  // Unauthenticated → 401.
  assertEquals((await app.request('GET', '/phones/me/phones')).status, 401);
});

dbTest('phones: first-time add sends the WhatsApp connected rundown; re-add does not re-notify', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppSendEnv();
  const outbound = interceptOutbound();
  try {
    const u = await registerUser(app);
    const seeded = await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

    const add = await app.request('POST', '/phones/me/phones', {
      token: u.access_token,
      json: { phone_e164: '+27831112230' },
    });
    assertEquals(add.status, 201);

    // Connected message + gate rundown (the account has one active gate →
    // text + button interactive).
    const calls = outbound.to('graph.facebook.com');
    assertEquals(calls.length, 2);
    const first = calls[0]!.body as { to: string; text: { body: string } };
    assertEquals(first.to, '27831112230');
    assert(first.text.body.includes('Your WhatsApp number is connected to whatsacc.'), first.text.body);
    const second = calls[1]!.body as { type: string; interactive: { action: { buttons: Array<{ reply: { id: string } }> } } };
    assertEquals(second.type, 'interactive');
    assertEquals(second.interactive.action.buttons[0]!.reply.id, `open_ap:${seeded.access_point_id!}`);

    // Adding the same (already-verified) number again is idempotent and
    // does not spam another rundown.
    const again = await app.request('POST', '/phones/me/phones', {
      token: u.access_token,
      json: { phone_e164: '+27831112230', is_primary: true },
    });
    assertEquals(again.status, 201);
    assertEquals(outbound.to('graph.facebook.com').length, 2, 'no duplicate notification');
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('phones: verify placeholder accepts any 6-digit code; scoping and delete lifecycle hold', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const other = await registerUser(app);

  const add = await app.request('POST', '/phones/me/phones', {
    token: u.access_token,
    json: { phone_e164: '+27831112240' },
  });
  const phoneId = (add.body as { id: string }).id;

  // Placeholder verification: ANY 6-digit code passes (see the TODO in
  // src/routes/phones.ts — there is no stored code to check against).
  const verify = await app.request('POST', `/phones/me/phones/${phoneId}/verify`, {
    token: u.access_token,
    json: { code: '123456' },
  });
  assertEquals(verify.status, 204);

  // Non-6-digit codes are rejected as invalid_code.
  const short = await app.request('POST', `/phones/me/phones/${phoneId}/verify`, {
    token: u.access_token,
    json: { code: '12345' },
  });
  assertEquals(short.status, 400);
  const alpha = await app.request('POST', `/phones/me/phones/${phoneId}/verify`, {
    token: u.access_token,
    json: { code: 'abcdef' },
  });
  assertEquals(alpha.status, 400);

  // Another user cannot verify or delete my phone (scoped by profile_id).
  const foreignVerify = await app.request('POST', `/phones/me/phones/${phoneId}/verify`, {
    token: other.access_token,
    json: { code: '123456' },
  });
  assertEquals(foreignVerify.status, 404);
  const foreignDelete = await app.request('DELETE', `/phones/me/phones/${phoneId}`, {
    token: other.access_token,
  });
  assertEquals(foreignDelete.status, 404);

  // Owner delete works once, then 404s; the list is empty again.
  assertEquals((await app.request('DELETE', `/phones/me/phones/${phoneId}`, { token: u.access_token })).status, 204);
  assertEquals((await app.request('DELETE', `/phones/me/phones/${phoneId}`, { token: u.access_token })).status, 404);
  assertEquals((await listPhones(app, u.access_token)).length, 0);
});

// ---------------------------------------------------------------------------
// Accounts: CRUD + members
// ---------------------------------------------------------------------------

dbTest('accounts: list/create/get/rename are owner-scoped; outsiders see nothing', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const outsider = await registerUser(app);

  // Signup bootstrapped one account with the caller as owner.
  const list = await app.request('GET', '/accounts', { token: u.access_token });
  assertEquals(list.status, 200);
  const accounts = (list.body as { accounts: Array<{ id: string; role: string; status: string }> }).accounts;
  assertEquals(accounts.length, 1);
  assertEquals(accounts[0]!.id, u.account_id);
  assertEquals(accounts[0]!.role, 'owner');
  assertEquals(accounts[0]!.status, 'active');

  // A second account can be created; the creator becomes its owner.
  const create = await app.request('POST', '/accounts', {
    token: u.access_token,
    json: { name: 'Beach house', country_code: 'za' },
  });
  assertEquals(create.status, 201);
  const newId = (create.body as { id: string }).id;
  const after = await app.request('GET', '/accounts', { token: u.access_token });
  const afterAccounts = (after.body as { accounts: Array<{ id: string; role: string }> }).accounts;
  assertEquals(afterAccounts.length, 2);
  assertEquals(afterAccounts.find((a) => a.id === newId)!.role, 'owner');

  // Detail + rename.
  const detail = await app.request('GET', `/accounts/${newId}`, { token: u.access_token });
  assertEquals(detail.status, 200);
  assertEquals((detail.body as { name: string }).name, 'Beach house');
  const rename = await app.request('PATCH', `/accounts/${newId}`, {
    token: u.access_token,
    json: { name: 'Beach house ZA' },
  });
  assertEquals(rename.status, 204);
  const renamed = await app.request('GET', `/accounts/${newId}`, { token: u.access_token });
  assertEquals((renamed.body as { name: string }).name, 'Beach house ZA');

  // RLS: outsiders can neither read nor rename it.
  assertEquals((await app.request('GET', `/accounts/${newId}`, { token: outsider.access_token })).status, 404);
  assertEquals(
    (await app.request('PATCH', `/accounts/${newId}`, { token: outsider.access_token, json: { name: 'mine now' } }))
      .status,
    404,
  );
});

dbTest('accounts: member listing only ever returns the caller (RLS swallows the rest)', async () => {
  await resetData();
  const app = await bootTestApp();
  const owner = await registerUser(app);
  const member = await registerUser(app);
  await adminSql(async (tx) => {
    await tx`
      insert into account_members (account_id, user_id, role, status)
      values (${owner.account_id}, ${member.user_id}, 'member', 'active')
    `;
  });

  // TODO(REAL BUG — documented, not fixed; tests must not touch src/):
  // GET /accounts/:id/members (src/routes/accounts.ts) INNER JOINs users,
  // but the users_self RLS policy (migrations/20260505000000_baseline.sql,
  // users_self) only exposes the caller's OWN users row to the request
  // role. The join therefore filters every other member out and an account
  // owner can never actually list their members — the endpoint returns
  // exactly one row: the caller. The account_members row for the second
  // member exists (asserted below); it is the users join that eats it.
  const r = await app.request('GET', `/accounts/${owner.account_id}/members`, { token: owner.access_token });
  assertEquals(r.status, 200);
  const members = (r.body as { members: Array<{ user_id: string; role: string; status: string; email: string }> })
    .members;
  assertEquals(members.length, 1, 'BUG: only the caller is visible (should be 2)');
  assertEquals(members[0]!.user_id, owner.user_id);
  assertEquals(members[0]!.role, 'owner');
  assertEquals(members[0]!.email, owner.email);

  // Ground truth: both memberships exist in the table.
  const raw = await adminSql(
    async (tx) => await tx<{ count: string }[]>`
      select count(*)::text as count from account_members where account_id = ${owner.account_id}
    `,
  );
  assertEquals(raw[0]!.count, '2');
});

// ---------------------------------------------------------------------------
// Accounts: invites
// ---------------------------------------------------------------------------

dbTest('accounts: invite → accept joins the account, links the phone, and is single-use', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppSendEnv();
  const outbound = interceptOutbound();
  try {
    const owner = await registerUser(app);
    await seedLocationWithAccessPoint(owner.account_id, { withAccessPoint: true });
    const inviteEmail = `invitee-${Date.now()}@example.com`;
    const invitePhone = '+27831112250';

    const invite = await app.request('POST', `/accounts/${owner.account_id}/invites`, {
      token: owner.access_token,
      json: { email: inviteEmail, role: 'member', phone_e164: invitePhone },
    });
    assertEquals(invite.status, 201);
    const inviteBody = invite.body as {
      id: string;
      accept_url: string;
      email_sent: boolean;
      whatsapp_sent: boolean;
    };
    assert(inviteBody.accept_url.includes('/accept-invite?token='), inviteBody.accept_url);
    assertEquals(inviteBody.whatsapp_sent, true, 'WhatsApp invite ping (mocked) must be sent');
    const token = new URL(inviteBody.accept_url).searchParams.get('token')!;

    // The WhatsApp ping carries the accept link to the invited phone.
    const waCalls = outbound.to('graph.facebook.com');
    assertEquals(waCalls.length, 1);
    const wa = waCalls[0]!.body as { to: string; text: { body: string } };
    assertEquals(wa.to, '27831112250');
    assert(wa.text.body.includes('accept your invitation'.replace('accept your', 'Accept your')), wa.text.body);

    // The invited person registers with the SAME email, then accepts.
    const invitee = await registerUser(app, { email: inviteEmail });
    const accept = await app.request('POST', `/accounts/invites/${encodeURIComponent(token)}/accept`, {
      token: invitee.access_token,
      json: {},
    });
    assertEquals(accept.status, 200);
    assertEquals((accept.body as { account_id: string; role: string }).account_id, owner.account_id);
    assertEquals((accept.body as { role: string }).role, 'member');

    // Membership is live: the account shows up in the invitee's list.
    const accounts = (
      (await app.request('GET', '/accounts', { token: invitee.access_token })).body as {
        accounts: Array<{ id: string; role: string }>;
      }
    ).accounts;
    const joined = accounts.find((a) => a.id === owner.account_id);
    assertExists(joined);
    assertEquals(joined!.role, 'member');

    // The invite's phone number was linked to the invitee, verified+primary,
    // and location memberships were fanned out to the account's locations.
    const linked = await adminSql(
      async (tx) => await tx<{ phone_e164: string; is_primary: boolean; verified_at: Date | null }[]>`
        select phone_e164, is_primary, verified_at from profile_phone_numbers
        where profile_id = ${invitee.user_id}
      `,
    );
    assertEquals(linked.length, 1);
    assertEquals(linked[0]!.phone_e164, invitePhone);
    assertEquals(linked[0]!.is_primary, true);
    assertExists(linked[0]!.verified_at);
    const locMembers = await adminSql(
      async (tx) => await tx<{ count: string }[]>`
        select count(*)::text as count
        from location_members lm
        join locations l on l.id = lm.location_id
        where lm.user_id = ${invitee.user_id} and l.account_id = ${owner.account_id}
      `,
    );
    assert(Number(locMembers[0]!.count) >= 1, 'accept must fan out location_members');

    // Single-use: accepting again fails.
    const replay = await app.request('POST', `/accounts/invites/${encodeURIComponent(token)}/accept`, {
      token: invitee.access_token,
      json: {},
    });
    assertEquals(replay.status, 400);
    assertEquals((replay.body as { error: string }).error, 'invite_used');
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('accounts: invite guards — wrong email, wrong phone, expiry, unknown token', async () => {
  await resetData();
  const app = await bootTestApp();
  const owner = await registerUser(app);
  const stranger = await registerUser(app); // email does NOT match the invite
  const inviteEmail = `guarded-${Date.now()}@example.com`;

  const invite = await app.request('POST', `/accounts/${owner.account_id}/invites`, {
    token: owner.access_token,
    json: { email: inviteEmail, role: 'member', phone_e164: '+27831112260' },
  });
  assertEquals(invite.status, 201);
  const inviteId = (invite.body as { id: string }).id;
  const token = new URL((invite.body as { accept_url: string }).accept_url).searchParams.get('token')!;

  // Wrong account: only the invited email may accept.
  const mismatch = await app.request('POST', `/accounts/invites/${encodeURIComponent(token)}/accept`, {
    token: stranger.access_token,
    json: {},
  });
  assertEquals(mismatch.status, 400);
  assertEquals((mismatch.body as { error: string }).error, 'invite_email_mismatch');

  // Right user, wrong phone in the accept body.
  const invitee = await registerUser(app, { email: inviteEmail });
  const wrongPhone = await app.request('POST', `/accounts/invites/${encodeURIComponent(token)}/accept`, {
    token: invitee.access_token,
    json: { phone_e164: '+27839999999' },
  });
  assertEquals(wrongPhone.status, 400);
  assertEquals((wrongPhone.body as { error: string }).error, 'invite_phone_mismatch');

  // Expired invites are refused.
  await adminSql(async (tx) => {
    await tx`update account_invites set expires_at = now() - interval '1 day' where id = ${inviteId}`;
  });
  const expired = await app.request('POST', `/accounts/invites/${encodeURIComponent(token)}/accept`, {
    token: invitee.access_token,
    json: {},
  });
  assertEquals(expired.status, 400);
  assertEquals((expired.body as { error: string }).error, 'invite_expired');

  // Unknown token → 404, and nobody joined the account through any of this.
  const unknown = await app.request('POST', '/accounts/invites/not-a-real-token/accept', {
    token: invitee.access_token,
    json: {},
  });
  assertEquals(unknown.status, 404);
  const members = await adminSql(
    async (tx) => await tx<{ count: string }[]>`
      select count(*)::text as count from account_members
      where account_id = ${owner.account_id}
    `,
  );
  assertEquals(members[0]!.count, '1', 'only the owner is a member');
});

dbTest('accounts: re-inviting an existing member with a new role updates the role on accept', async () => {
  await resetData();
  const app = await bootTestApp();
  const restore = setWhatsAppSendEnv();
  const outbound = interceptOutbound();
  try {
    const owner = await registerUser(app);
    const memberEmail = `promotee-${Date.now()}@example.com`;
    const member = await registerUser(app, { email: memberEmail });
    await adminSql(async (tx) => {
      await tx`
        insert into account_members (account_id, user_id, role, status)
        values (${owner.account_id}, ${member.user_id}, 'member', 'active')
      `;
    });

    const invite = await app.request('POST', `/accounts/${owner.account_id}/invites`, {
      token: owner.access_token,
      json: { email: memberEmail, role: 'admin', phone_e164: '+27831112270' },
    });
    assertEquals(invite.status, 201);
    const token = new URL((invite.body as { accept_url: string }).accept_url).searchParams.get('token')!;

    const accept = await app.request('POST', `/accounts/invites/${encodeURIComponent(token)}/accept`, {
      token: member.access_token,
      json: {},
    });
    assertEquals(accept.status, 200);
    assertEquals((accept.body as { role: string }).role, 'admin');

    const row = await adminSql(
      async (tx) => await tx<{ role: string }[]>`
        select role from account_members
        where account_id = ${owner.account_id} and user_id = ${member.user_id}
      `,
    );
    assertEquals(row[0]!.role, 'admin');
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('accounts: non-admin members cannot mint invites for the account', async () => {
  await resetData();
  const app = await bootTestApp();
  const owner = await registerUser(app);
  const member = await registerUser(app);
  const outsider = await registerUser(app);
  await adminSql(async (tx) => {
    await tx`
      insert into account_members (account_id, user_id, role, status)
      values (${owner.account_id}, ${member.user_id}, 'member', 'active')
    `;
  });

  for (const actor of [member, outsider]) {
    const r = await app.request('POST', `/accounts/${owner.account_id}/invites`, {
      token: actor.access_token,
      json: { email: 'nope@example.com', role: 'admin', phone_e164: '+27831112280' },
    });
    assert(r.status >= 400, `invite by non-admin must fail, got ${r.status}`);
  }
  const rows = await adminSql(
    async (tx) => await tx<{ count: string }[]>`
      select count(*)::text as count from account_invites where account_id = ${owner.account_id}
    `,
  );
  assertEquals(rows[0]!.count, '0', 'no invite rows may exist');
});
