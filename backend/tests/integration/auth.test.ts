import { assert, assertEquals, assertExists, assertNotEquals } from '@std/assert';
import { withRLS } from '@/lib/db.ts';
import { bootTestApp } from '../helpers/app.ts';
import { resetData } from '../helpers/db.ts';
import { registerUser } from '../helpers/fixtures.ts';
import { dbTest } from '../helpers/test.ts';
import { isValidSlug } from '@/lib/slug.ts';

async function markActive(userId: string): Promise<void> {
  await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      await tx`update users set status = 'active', email_verified_at = now() where id = ${userId}`;
    },
  );
}

dbTest('register: creates user, account, slug, and returns 201', async () => {
  await resetData();
  const app = await bootTestApp();
  const res = await app.request('POST', '/auth/register', {
    json: {
      email: 'alice@test.local',
      password: 'Pa55word_test',
      display_name: 'Alice',
      country_code: 'ZA',
      account_type: 'personal',
    },
  });
  assertEquals(res.status, 201);
  const body = res.body as { id: string; account_id: string };
  assertExists(body.id);
  assertExists(body.account_id);
  await markActive(body.id);

  // /me should resolve and have an auto-minted slug.
  const login = await app.request('POST', '/auth/login', {
    json: { email: 'alice@test.local', password: 'Pa55word_test' },
  });
  const tokens = login.body as { access_token: string };
  const me = await app.request('GET', '/auth/me', { token: tokens.access_token });
  assertEquals(me.status, 200);
  const meBody = me.body as {
    user: { email: string; referral_slug: string | null };
    accounts: { account_id: string; role: string }[];
  };
  assertEquals(meBody.user.email, 'alice@test.local');
  assertExists(meBody.user.referral_slug);
  assert(isValidSlug(meBody.user.referral_slug!));
  assertEquals(meBody.accounts.length, 1);
  assertEquals(meBody.accounts[0]!.role, 'owner');
});

dbTest('register: rejects duplicate email with 409', async () => {
  await resetData();
  const app = await bootTestApp();
  await registerUser(app, { email: 'dupe@test.local' });
  const res = await app.request('POST', '/auth/register', {
    json: {
      email: 'dupe@test.local',
      password: 'Pa55word_test',
      display_name: 'Other',
      country_code: 'ZA',
    },
  });
  assertEquals(res.status, 409);
  assertEquals((res.body as { error: string }).error, 'email_taken');
});

dbTest('login: rejects bad password with 401', async () => {
  await resetData();
  const app = await bootTestApp();
  await registerUser(app, { email: 'bob@test.local', password: 'Pa55word_test' });
  const res = await app.request('POST', '/auth/login', {
    json: { email: 'bob@test.local', password: 'wrong-password' },
  });
  assertEquals(res.status, 401);
  assertEquals((res.body as { error: string }).error, 'invalid_credentials');
});

dbTest('refresh: rotates the refresh token and returns a new access token', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const r = await app.request('POST', '/auth/refresh', {
    json: { refresh_token: u.refresh_token },
  });
  assertEquals(r.status, 200);
  const body = r.body as { access_token: string; refresh_token: string };
  // Refresh token must rotate. Access token may be byte-identical if minted
  // within the same wall-clock second (JWT iat/exp resolution = 1s).
  assertNotEquals(body.refresh_token, u.refresh_token);
  assertExists(body.access_token);
});

dbTest('refresh: reusing the old refresh token after rotation kills the family', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  // First rotation succeeds.
  const r1 = await app.request('POST', '/auth/refresh', {
    json: { refresh_token: u.refresh_token },
  });
  assertEquals(r1.status, 200);

  // Reusing the original token is detected and rejected.
  const r2 = await app.request('POST', '/auth/refresh', {
    json: { refresh_token: u.refresh_token },
  });
  assertEquals(r2.status, 401);
  assertEquals((r2.body as { error: string }).error, 'refresh_token_reused');

  // The just-issued token is now also revoked (family killed).
  const fresh = (r1.body as { refresh_token: string }).refresh_token;
  const r3 = await app.request('POST', '/auth/refresh', {
    json: { refresh_token: fresh },
  });
  assertEquals(r3.status, 401);
});

dbTest('logout: revokes the family; subsequent refresh fails', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);
  const out = await app.request('POST', '/auth/logout', {
    json: { refresh_token: u.refresh_token },
  });
  assertEquals(out.status, 204);

  const r = await app.request('POST', '/auth/refresh', {
    json: { refresh_token: u.refresh_token },
  });
  assertEquals(r.status, 401);
});

dbTest('forgot-password: returns 204 even for unknown emails (no enumeration)', async () => {
  await resetData();
  const app = await bootTestApp();
  const r = await app.request('POST', '/auth/forgot-password', {
    json: { email: 'never-existed@test.local' },
  });
  assertEquals(r.status, 204);
});

dbTest('me: requires a valid bearer token', async () => {
  await resetData();
  const app = await bootTestApp();
  const noTok = await app.request('GET', '/auth/me');
  assertEquals(noTok.status, 401);
  const bad = await app.request('GET', '/auth/me', { token: 'not.a.jwt' });
  assertEquals(bad.status, 401);
});

// ---------------------------------------------------------------------------
// Password update (authenticated)
// ---------------------------------------------------------------------------

dbTest('update-password: rotates the password and revokes existing refresh tokens', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  const ok = await app.request('POST', '/auth/update-password', {
    token: u.access_token,
    json: { current_password: u.password, new_password: 'Pa55word_NEW_1' },
  });
  assertEquals(ok.status, 204);

  // Old password no longer works.
  const oldLogin = await app.request('POST', '/auth/login', {
    json: { email: u.email, password: u.password },
  });
  assertEquals(oldLogin.status, 401);

  // New password works.
  const newLogin = await app.request('POST', '/auth/login', {
    json: { email: u.email, password: 'Pa55word_NEW_1' },
  });
  assertEquals(newLogin.status, 200);

  // Existing refresh token from registration was revoked.
  const refresh = await app.request('POST', '/auth/refresh', {
    json: { refresh_token: u.refresh_token },
  });
  assertEquals(refresh.status, 401);
});

dbTest('update-password: rejects wrong current password', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  const r = await app.request('POST', '/auth/update-password', {
    token: u.access_token,
    json: { current_password: 'wrong-password', new_password: 'Pa55word_NEW_1' },
  });
  assertEquals(r.status, 401);
  assertEquals((r.body as { error: string }).error, 'invalid_current_password');
});

dbTest('update-password: rejects same password', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  const r = await app.request('POST', '/auth/update-password', {
    token: u.access_token,
    json: { current_password: u.password, new_password: u.password },
  });
  assertEquals(r.status, 400);
  assertEquals((r.body as { error: string }).error, 'same_password');
});

dbTest('update-password: requires authentication', async () => {
  await resetData();
  const app = await bootTestApp();
  const r = await app.request('POST', '/auth/update-password', {
    json: { current_password: 'a', new_password: 'Pa55word_NEW_1' },
  });
  assertEquals(r.status, 401);
});

// ---------------------------------------------------------------------------
// Forgot / reset flow
// ---------------------------------------------------------------------------

dbTest('forgot + reset: full happy path rotates the password', async () => {
  await resetData();
  const app = await bootTestApp();
  const u = await registerUser(app);

  // Trigger forgot — response is always 204 to avoid email enumeration. We
  // grab the freshly-issued token directly from the DB to act as the user.
  const forgot = await app.request('POST', '/auth/forgot-password', {
    json: { email: u.email },
  });
  assertEquals(forgot.status, 204);

  const tokenHash = await import('@/lib/refresh.ts').then((m) =>
    m.hashToken('placeholder'),
  );
  void tokenHash;
  const tokenRow = await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      const rows = await tx<{ token_hash: string }[]>`
        select token_hash from password_reset_tokens where user_id = ${u.user_id}
        order by created_at desc limit 1
      `;
      return rows[0]!;
    },
  );

  // Tokens are stored hashed. We can't recover the plaintext, so we fake it
  // by directly inserting a known token. (The /forgot-password handler is
  // already tested for its email-enumeration behaviour elsewhere.)
  const plain = 'reset-token-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const knownHash = await import('@/lib/refresh.ts').then((m) => m.hashToken(plain));
  await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      await tx`
        update password_reset_tokens set token_hash = ${knownHash}
        where token_hash = ${tokenRow.token_hash}
      `;
    },
  );

  const reset = await app.request('POST', '/auth/reset-password', {
    json: { token: plain, new_password: 'Pa55word_RESET_1' },
  });
  assertEquals(reset.status, 204);

  // Old password rejected.
  const oldLogin = await app.request('POST', '/auth/login', {
    json: { email: u.email, password: u.password },
  });
  assertEquals(oldLogin.status, 401);

  // New password works.
  const newLogin = await app.request('POST', '/auth/login', {
    json: { email: u.email, password: 'Pa55word_RESET_1' },
  });
  assertEquals(newLogin.status, 200);

  // Token is single-use — second redemption fails.
  const replay = await app.request('POST', '/auth/reset-password', {
    json: { token: plain, new_password: 'Pa55word_OTHER_1' },
  });
  assertEquals(replay.status, 400);
  assertEquals((replay.body as { error: string }).error, 'token_used');
});
