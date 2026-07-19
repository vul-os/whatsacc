// Security regressions for the phone-OTP hardening (adversarial review
// 2026-07-18):
//
//   1. INVITE AUTO-VERIFY BYPASS (F1): the accept token is dual-delivered
//      (email + WhatsApp) — the same secret over both channels — so
//      possessing it proves nothing about controlling the invited phone.
//      Accepting an invite used to insert the phone with verified_at =
//      now(): a SELF-INVITE (invite your own email with any unclaimed
//      number, accept via your own emailed/echoed token) verified a number
//      the attacker never controlled, and the one-verified-owner unique
//      index then durably locked the real owner out (squat DoS). Pin the
//      fix: accept links UNVERIFIED, only the OTP flow verifies, and the
//      real owner can still claim the number afterwards.
//
//   2. OTP RATE LIMITS (F2): the per-challenge 5-attempt cap resets on
//      every POST /me/phones re-add (fresh code, attempts = 0). Pin the
//      persistent fixed-window counters: otp_start (5/user/hour) and
//      otp_verify (15/phone-row/hour, surviving challenge restarts).

import { assert, assertEquals, assertExists } from '../helpers/assert.ts';
import { bootTestApp, type AppHandle } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { registerUser } from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';
import { adminSql } from '../helpers/chat.ts';
import { hashToken } from '@/lib/refresh.ts';

/** Overwrite an invite's token hash with the hash of a known token. */
async function forceInviteToken(inviteId: string, tokenPlain: string): Promise<void> {
  const tokenHash = await hashToken(tokenPlain);
  await adminSql(async (tx) => {
    await tx`update account_invites set token_hash = ${tokenHash} where id = ${inviteId}`;
  });
}

/** Force a known OTP code (salt = '' → stored hash = SHA-256(code)). */
async function forceVerificationCode(phoneId: string, code: string): Promise<void> {
  const codeHash = await hashToken(code);
  await adminSql(async (tx) => {
    await tx`
      update phone_verification_codes
      set salt = '', code_hash = ${codeHash}
      where phone_id = ${phoneId}
    `;
  });
}

async function phoneRow(profileId: string, phoneE164: string) {
  const rows = await adminSql(
    async (tx) => await tx<{ id: string; verified_at: Date | null; is_primary: boolean }[]>`
      select id, verified_at, is_primary from profile_phone_numbers
      where profile_id = ${profileId} and phone_e164 = ${phoneE164}
    `,
  );
  return rows[0] ?? null;
}

async function addPhone(app: AppHandle, token: string, phoneE164: string) {
  return await app.request('POST', '/phones/me/phones', { token, json: { phone_e164: phoneE164 } });
}

async function verifyPhone(app: AppHandle, token: string, phoneId: string, code: string) {
  return await app.request('POST', `/phones/me/phones/${phoneId}/verify`, { token, json: { code } });
}

dbTest('security: self-invite accept can NEVER verify a phone — and the real owner can still claim it', async () => {
  await resetData();
  const app = await bootTestApp();

  // The exact bypass: the attacker invites their OWN email into their OWN
  // account, naming a victim's (unclaimed) number, then accepts with the
  // token from their own delivery channels. Pre-fix this yielded
  // verified_at = now() on a number the attacker does not control.
  const attacker = await registerUser(app);
  const victimPhone = '+27835550100';

  const invite = await app.request('POST', `/accounts/${attacker.account_id}/invites`, {
    token: attacker.access_token,
    json: { email: attacker.email, role: 'admin', phone_e164: victimPhone },
  });
  assertEquals(invite.status, 201);
  // The response must not hand the inviter the accept secret.
  assert(!invite.text.includes('accept-invite?token='), 'accept token must not be echoed to the inviter');
  assert(!('accept_url' in (invite.body as Record<string, unknown>)), 'accept_url must not be returned');

  const token = `self-invite-${Date.now()}`;
  await forceInviteToken((invite.body as { id: string }).id, token);
  const accept = await app.request('POST', `/accounts/invites/${encodeURIComponent(token)}/accept`, {
    token: attacker.access_token,
    json: {},
  });
  assertEquals(accept.status, 200);
  assertEquals(
    (accept.body as { phone_verification_required: boolean }).phone_verification_required,
    true,
  );

  // The phone is linked but NOT verified — no identity, no squat.
  const attackerLink = await phoneRow(attacker.user_id, victimPhone);
  assertExists(attackerLink);
  assertEquals(attackerLink!.verified_at, null, 'accept must NOT verify the phone');
  assertEquals(attackerLink!.is_primary, false, 'unverified phones cannot be primary');

  // An unverified link resolves no WhatsApp identity/gates.
  const { getAvailableAccessPoints } = await import('@/lib/access-lookup.ts');
  const gates = await adminSql(async (tx) => await getAvailableAccessPoints(tx, { phoneE164: victimPhone }));
  assertEquals(gates.length, 0, 'unverified invite-linked phone must resolve no access');

  // The REAL owner of the number can still verify it (no durable squat: the
  // one-verified-owner unique index only bites on VERIFIED rows).
  const owner = await registerUser(app);
  const add = await addPhone(app, owner.access_token, victimPhone);
  assertEquals(add.status, 201);
  const ownerPhoneId = (add.body as { id: string }).id;
  await forceVerificationCode(ownerPhoneId, '246810');
  assertEquals((await verifyPhone(app, owner.access_token, ownerPhoneId, '246810')).status, 204);
  const ownerLink = await phoneRow(owner.user_id, victimPhone);
  assertExists(ownerLink!.verified_at, 'real owner must be able to verify');

  // And the attacker cannot complete their challenge onto the now-owned
  // number even with the correct code — honest phone_taken conflict.
  await forceVerificationCode(attackerLink!.id, '135791');
  const late = await verifyPhone(app, attacker.access_token, attackerLink!.id, '135791');
  assertEquals(late.status, 409);
  assertEquals((late.body as { error: string }).error, 'phone_in_use');
}, 120_000);

dbTest('security: OTP challenge starts are capped per user per hour (6th → 429)', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  // Every (re)add of an unverified number mints a fresh code — each one is
  // a challenge start. 5 are allowed per hour.
  for (let i = 0; i < 5; i++) {
    const r = await addPhone(app, u.access_token, '+27835550110');
    assertEquals(r.status, 201, `start ${i + 1} must be allowed`);
  }
  const sixth = await addPhone(app, u.access_token, '+27835550110');
  assertEquals(sixth.status, 429);
  const body = sixth.body as { error: string; retry_after_s: number };
  assertEquals(body.error, 'otp_rate_limited');
  assert(body.retry_after_s >= 1 && body.retry_after_s <= 3600, `retry_after_s: ${body.retry_after_s}`);
  assertEquals(sixth.headers.get('retry-after'), String(body.retry_after_s));

  // Per-user scope: another user is unaffected.
  const other = await registerUser(app);
  assertEquals((await addPhone(app, other.access_token, '+27835550111')).status, 201);
}, 120_000);

dbTest('security: OTP verify attempts are capped per phone row per hour and SURVIVE challenge restarts', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  const add = await addPhone(app, u.access_token, '+27835550120');
  assertEquals(add.status, 201);
  const phoneId = (add.body as { id: string }).id;
  await forceVerificationCode(phoneId, '111111');

  // Challenge 1: five wrong guesses burn the per-challenge cap...
  for (let i = 0; i < 5; i++) {
    const r = await verifyPhone(app, u.access_token, phoneId, '000000');
    assertEquals(r.status, 400);
    assertEquals((r.body as { error: string }).error, 'invalid_code');
  }
  // ...locking even the correct code.
  const locked = await verifyPhone(app, u.access_token, phoneId, '111111');
  assertEquals(locked.status, 429);
  assertEquals((locked.body as { error: string }).error, 'too_many_attempts');

  // Restart the challenge (re-add): the per-challenge counter resets — this
  // was the unlimited-guess hole — but the persistent otp_verify window
  // keeps counting. 6 attempts so far.
  assertEquals((await addPhone(app, u.access_token, '+27835550120')).status, 201);
  await forceVerificationCode(phoneId, '111111');
  for (let i = 0; i < 5; i++) {
    assertEquals((await verifyPhone(app, u.access_token, phoneId, '000000')).status, 400); // 7..11
  }

  // Second restart, four more wrong guesses → 15 attempts in the window.
  assertEquals((await addPhone(app, u.access_token, '+27835550120')).status, 201);
  await forceVerificationCode(phoneId, '111111');
  for (let i = 0; i < 4; i++) {
    assertEquals((await verifyPhone(app, u.access_token, phoneId, '000000')).status, 400); // 12..15
  }

  // The fresh challenge has only 4/5 attempts burned, but the persistent
  // window is exhausted: even the CORRECT code is refused with 429 — proof
  // the cap survives restarts.
  const capped = await verifyPhone(app, u.access_token, phoneId, '111111');
  assertEquals(capped.status, 429);
  assertEquals((capped.body as { error: string }).error, 'otp_rate_limited');
  assert((capped.body as { retry_after_s: number }).retry_after_s >= 1);

  const row = await phoneRow(u.user_id, '+27835550120');
  assertEquals(row!.verified_at, null, 'phone must remain unverified');
}, 120_000);
