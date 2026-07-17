import { assert } from '../helpers/assert.ts';
import { hashPassword, verifyPassword } from '@/lib/password.ts';

test('password roundtrip', async () => {
  const hash = await hashPassword('hunter2');
  assert(await verifyPassword('hunter2', hash));
  assert(!(await verifyPassword('wrong', hash)));
});

test('password hashes are not deterministic', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert(a !== b);
  assert(await verifyPassword('same-password', a));
  assert(await verifyPassword('same-password', b));
});
