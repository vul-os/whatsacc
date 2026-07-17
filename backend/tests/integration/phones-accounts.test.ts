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
import { hashToken } from '@/lib/refresh.ts';

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

type CodeRow = { code_hash: string; attempts: number; expires_at: Date };

/** Read the pending OTP challenge row for a phone (admin context). */
async function verificationCodeRow(phoneId: string): Promise<CodeRow | null> {
  const rows = await adminSql(
    async (tx) => await tx<CodeRow[]>`
      select code_hash, attempts, expires_at
      from phone_verification_codes
      where phone_id = ${phoneId}
    `,
  );
  return rows[0] ?? null;
}

/**
 * Overwrite the stored OTP hash with the hash of a known code so the test
 * can complete the challenge deterministically (the plaintext code is never
 * stored, logged, or returned by the API — only sent over WhatsApp).
 */
async function forceVerificationCode(phoneId: string, code: string): Promise<void> {
  const codeHash = await hashToken(code);
  await adminSql(async (tx) => {
    await tx`
      update phone_verification_codes
      set code_hash = ${codeHash}
      where phone_id = ${phoneId}
    `;
  });
}

async function verifyPhone(app: AppHandle, token: string, phoneId: string, code: string) {
  return await app.request('POST', `/phones/me/phones/${phoneId}/verify`, {
    token,
    json: { code },
  });
}

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

dbTest('phones: add starts UNVERIFIED with an OTP challenge; primary requires verification; invalid E.164 rejected', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  // FIXED (was pinned): phones used to be auto-verified with verified_at =
  // now() on add, and /verify accepted any 6-digit code — letting anyone
  // claim a number they don't own as their WhatsApp gate identity. Now: add
  // → unverified + hashed OTP row; only a correct /verify flips verified_at.
  const add1 = await app.request('POST', '/phones/me/phones', {
    token: u.access_token,
    json: { phone_e164: '+27831112221' },
  });
  assertEquals(add1.status, 201);
  const phone1 = (add1.body as { id: string; verification_required: boolean });
  assertEquals(phone1.verification_required, true);

  // is_primary on an UNVERIFIED phone must not stick.
  const add2 = await app.request('POST', '/phones/me/phones', {
    token: u.access_token,
    json: { phone_e164: '+27831112222', is_primary: true },
  });
  assertEquals(add2.status, 201);
  const phone2 = (add2.body as { id: string });

  let phones = await listPhones(app, u.access_token);
  assertEquals(phones.length, 2);
  for (const p of phones) {
    assertEquals(p.verified_at, null, 'phones must start unverified');
    assertEquals(p.is_primary, false, 'unverified phones cannot be primary');
  }

  // A hashed challenge row exists per phone; the API never leaks the code.
  const codeRow = await verificationCodeRow(phone1.id);
  assertExists(codeRow);
  assertEquals(codeRow!.attempts, 0);
  assert(!JSON.stringify(add1.body).includes(codeRow!.code_hash), 'hash must not leak');

  // Verify both phones, then re-add phone2 as primary — now it sticks.
  await forceVerificationCode(phone1.id, '111222');
  assertEquals((await verifyPhone(app, u.access_token, phone1.id, '111222')).status, 204);
  await forceVerificationCode(phone2.id, '333444');
  assertEquals((await verifyPhone(app, u.access_token, phone2.id, '333444')).status, 204);
  const makePrimary = await app.request('POST', '/phones/me/phones', {
    token: u.access_token,
    json: { phone_e164: '+27831112222', is_primary: true },
  });
  assertEquals(makePrimary.status, 201);
  assertEquals((makePrimary.body as { verification_required: boolean }).verification_required, false);

  phones = await listPhones(app, u.access_token);
  // Primary sorts first.
  assertEquals(phones[0]!.phone_e164, '+27831112222');
  assertEquals(phones[0]!.is_primary, true);
  assertExists(phones[0]!.verified_at);
  assertEquals(phones[1]!.phone_e164, '+27831112221');
  assertExists(phones[1]!.verified_at);

  // The consumed challenge rows are gone.
  assertEquals(await verificationCodeRow(phone1.id), null);
  assertEquals(await verificationCodeRow(phone2.id), null);

  // Not E.164 → zod 400.
  const bad = await app.request('POST', '/phones/me/phones', {
    token: u.access_token,
    json: { phone_e164: '0831112223' },
  });
  assertEquals(bad.status, 400);

  // Unauthenticated → 401.
  assertEquals((await app.request('GET', '/phones/me/phones')).status, 401);
});

dbTest('phones: add sends the OTP over WhatsApp; the connected rundown moves to after verification', async () => {
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
    const phoneId = (add.body as { id: string }).id;

    // Add sends ONLY the OTP text to the number being verified — no rundown
    // yet (the number is not proven).
    let calls = outbound.to('graph.facebook.com');
    assertEquals(calls.length, 1);
    const otpMsg = calls[0]!.body as { to: string; text: { body: string } };
    assertEquals(otpMsg.to, '27831112230');
    const codeMatch = /verification code is (\d{6})/.exec(otpMsg.text.body);
    assertExists(codeMatch, `OTP text must carry the code: ${otpMsg.text.body}`);
    const code = codeMatch![1]!;

    // The stored row holds the HASH of exactly that code.
    const row = await verificationCodeRow(phoneId);
    assertExists(row);
    assertEquals(row!.code_hash, await hashToken(code));

    // Wrong code → 400 invalid_code, nothing verified, nothing sent.
    const wrong = await verifyPhone(app, u.access_token, phoneId, code === '000000' ? '000001' : '000000');
    assertEquals(wrong.status, 400);
    assertEquals((wrong.body as { error: string }).error, 'invalid_code');
    assertEquals(outbound.to('graph.facebook.com').length, 1);

    // Correct code → verified; NOW the connected rundown goes out (text +
    // one-gate button interactive).
    assertEquals((await verifyPhone(app, u.access_token, phoneId, code)).status, 204);
    calls = outbound.to('graph.facebook.com');
    assertEquals(calls.length, 3);
    const connected = calls[1]!.body as { to: string; text: { body: string } };
    assertEquals(connected.to, '27831112230');
    assert(connected.text.body.includes('Your WhatsApp number is connected to whatsacc.'), connected.text.body);
    const rundown = calls[2]!.body as { type: string; interactive: { action: { buttons: Array<{ reply: { id: string } }> } } };
    assertEquals(rundown.type, 'interactive');
    assertEquals(rundown.interactive.action.buttons[0]!.reply.id, `open_ap:${seeded.access_point_id!}`);

    const phones = await listPhones(app, u.access_token);
    assertExists(phones[0]!.verified_at);

    // Re-adding the (now verified) number again is idempotent: no new OTP,
    // no duplicate rundown.
    const again = await app.request('POST', '/phones/me/phones', {
      token: u.access_token,
      json: { phone_e164: '+27831112230', is_primary: true },
    });
    assertEquals(again.status, 201);
    assertEquals((again.body as { verification_required: boolean }).verification_required, false);
    assertEquals(outbound.to('graph.facebook.com').length, 3, 'no duplicate notification');
    assertEquals(await verificationCodeRow(phoneId), null, 'no new challenge for a verified phone');
  } finally {
    outbound.restore();
    restore();
  }
});

dbTest('phones: verify checks the stored hash — wrong code ×5 locks, codes expire, scoping and delete hold', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const other = await registerUser(app);

  // WHATSAPP_* creds are UNSET here (dev/test ergonomics): the add still
  // creates the hashed challenge row — it just cannot text the code out.
  const add = await app.request('POST', '/phones/me/phones', {
    token: u.access_token,
    json: { phone_e164: '+27831112240' },
  });
  assertEquals(add.status, 201);
  const phoneId = (add.body as { id: string }).id;
  assertExists(await verificationCodeRow(phoneId), 'challenge row must exist without WA creds');
  await forceVerificationCode(phoneId, '654321');

  // Non-6-digit codes are rejected as invalid_code without burning attempts.
  assertEquals((await verifyPhone(app, u.access_token, phoneId, '12345')).status, 400);
  assertEquals((await verifyPhone(app, u.access_token, phoneId, 'abcdef')).status, 400);
  assertEquals((await verificationCodeRow(phoneId))!.attempts, 0);

  // Wrong code ×5 → each 400 invalid_code, attempts counted...
  for (let i = 0; i < 5; i++) {
    const r = await verifyPhone(app, u.access_token, phoneId, '000000');
    assertEquals(r.status, 400);
    assertEquals((r.body as { error: string }).error, 'invalid_code');
  }
  assertEquals((await verificationCodeRow(phoneId))!.attempts, 5);

  // ...then the challenge is locked — even the CORRECT code is refused.
  const locked = await verifyPhone(app, u.access_token, phoneId, '654321');
  assertEquals(locked.status, 429);
  assertEquals((locked.body as { error: string }).error, 'too_many_attempts');
  assertEquals((await listPhones(app, u.access_token))[0]!.verified_at, null);

  // Re-adding the phone restarts the challenge (new code, attempts reset).
  assertEquals(
    (await app.request('POST', '/phones/me/phones', { token: u.access_token, json: { phone_e164: '+27831112240' } }))
      .status,
    201,
  );
  assertEquals((await verificationCodeRow(phoneId))!.attempts, 0);

  // Expired codes are refused.
  await forceVerificationCode(phoneId, '654321');
  await adminSql(async (tx) => {
    await tx`update phone_verification_codes set expires_at = now() - interval '1 minute' where phone_id = ${phoneId}`;
  });
  const expired = await verifyPhone(app, u.access_token, phoneId, '654321');
  assertEquals(expired.status, 400);
  assertEquals((expired.body as { error: string }).error, 'code_expired');

  // Fresh challenge → correct code verifies and consumes the row.
  assertEquals(
    (await app.request('POST', '/phones/me/phones', { token: u.access_token, json: { phone_e164: '+27831112240' } }))
      .status,
    201,
  );
  await forceVerificationCode(phoneId, '654321');
  assertEquals((await verifyPhone(app, u.access_token, phoneId, '654321')).status, 204);
  assertExists((await listPhones(app, u.access_token))[0]!.verified_at);
  assertEquals(await verificationCodeRow(phoneId), null, 'challenge consumed on success');

  // Another user cannot verify or delete my phone (scoped by profile_id).
  const foreignVerify = await verifyPhone(app, other.access_token, phoneId, '654321');
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

dbTest('phones: an unverified phone carries no chat identity — the webhook treats it as unlinked', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  await seedLocationWithAccessPoint(u.account_id, { withAccessPoint: true });

  const add = await app.request('POST', '/phones/me/phones', {
    token: u.access_token,
    json: { phone_e164: '+27831112245' },
  });
  assertEquals(add.status, 201);

  // access-lookup / webhook identity resolution filters verified_at IS NOT
  // NULL — an attacker-added (unverified) number must resolve zero access.
  const { getAvailableAccessPoints } = await import('@/lib/access-lookup.ts');
  const gates = await adminSql(async (tx) => await getAvailableAccessPoints(tx, { phoneE164: '+27831112245' }));
  assertEquals(gates.length, 0, 'unverified phone must resolve no gates');
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

dbTest('accounts: member listing returns every member (email + display name) without weakening users RLS', async () => {
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

  // FIXED (was pinned): the route used to INNER JOIN users under the
  // caller's RLS context, and users_self hid every co-member's row — an
  // owner could only ever list themselves. It now reads through the
  // SECURITY DEFINER app.account_member_list helper (self-gated on active
  // membership), so the full roster with email + display_name comes back.
  const r = await app.request('GET', `/accounts/${owner.account_id}/members`, { token: owner.access_token });
  assertEquals(r.status, 200);
  const members = (
    r.body as {
      members: Array<{ user_id: string; role: string; status: string; email: string; display_name: string | null }>;
    }
  ).members;
  assertEquals(members.length, 2, 'owner must see the full roster');
  const ownerRow = members.find((m) => m.user_id === owner.user_id);
  const memberRow = members.find((m) => m.user_id === member.user_id);
  assertExists(ownerRow);
  assertExists(memberRow);
  assertEquals(ownerRow!.role, 'owner');
  assertEquals(ownerRow!.email, owner.email);
  assertEquals(memberRow!.role, 'member');
  assertEquals(memberRow!.email, member.email);
  assertEquals(memberRow!.display_name, member.display_name);

  // A plain member (not admin) can also see their co-members.
  const asMember = await app.request('GET', `/accounts/${owner.account_id}/members`, { token: member.access_token });
  assertEquals(asMember.status, 200);
  assertEquals((asMember.body as { members: unknown[] }).members.length, 2);

  // Fail-closed: non-members of the account get an empty roster, and the
  // users_self policy still hides foreign users rows elsewhere (the helper
  // is the ONLY cross-row read path).
  const asOutsider = await app.request('GET', `/accounts/${owner.account_id}/members`, {
    token: outsider.access_token,
  });
  assertEquals(asOutsider.status, 200);
  assertEquals((asOutsider.body as { members: unknown[] }).members.length, 0, 'outsiders see nobody');

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
