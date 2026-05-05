import { assert, assertEquals, assertRejects } from '@std/assert';
import { resetEnvCache } from '@/lib/env.ts';
import { signAccessToken, verifyAccessToken } from '@/lib/jwt.ts';

function setTestEnv() {
  Deno.env.set('DATABASE_URL', 'postgres://test/test');
  Deno.env.set('JWT_SECRET', 'test-secret-do-not-use-in-prod');
  resetEnvCache();
}

Deno.test('access token round-trips claims', async () => {
  setTestEnv();
  const token = await signAccessToken({
    sub: '00000000-0000-0000-0000-000000000001',
    email: 'alice@example.com',
    account_id: '00000000-0000-0000-0000-000000000099',
    is_platform_admin: false,
  });
  assert(typeof token === 'string' && token.split('.').length === 3);

  const claims = await verifyAccessToken(token);
  assertEquals(claims.sub, '00000000-0000-0000-0000-000000000001');
  assertEquals(claims.email, 'alice@example.com');
  assertEquals(claims.account_id, '00000000-0000-0000-0000-000000000099');
  assertEquals(claims.is_platform_admin, false);
});

Deno.test('access token rejects tampered signature', async () => {
  setTestEnv();
  const token = await signAccessToken({
    sub: '00000000-0000-0000-0000-000000000002',
    email: 'bob@example.com',
    is_platform_admin: true,
  });
  const tampered = token.slice(0, -4) + 'AAAA';
  await assertRejects(() => verifyAccessToken(tampered));
});
