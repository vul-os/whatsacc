import { assert, assertFalse } from '../helpers/assert.ts';
import { isValidSlug, randomSlug, RESERVED_SLUGS } from '@/lib/slug.ts';

test('isValidSlug: accepts simple lowercase slugs', () => {
  assert(isValidSlug('yusuf'));
  assert(isValidSlug('yusuf-adams'));
  assert(isValidSlug('yusuf42'));
  assert(isValidSlug('a-b-c'));
});

test('isValidSlug: rejects bad shapes', () => {
  assertFalse(isValidSlug('Yusuf'));
  assertFalse(isValidSlug('yu'));
  assertFalse(isValidSlug('-yusuf'));
  assertFalse(isValidSlug('yusuf-'));
  assertFalse(isValidSlug('yusuf--adams'));
  assertFalse(isValidSlug('yusuf.adams'));
  assertFalse(isValidSlug('yusuf_adams'));
  assertFalse(isValidSlug('a'.repeat(31)));
});

test('isValidSlug: blocks reserved paths', () => {
  for (const r of ['app', 'login', 'signup', 'r', 'admin', 'api']) {
    assertFalse(isValidSlug(r), `expected reserved: ${r}`);
    assert(RESERVED_SLUGS.has(r));
  }
});

test('randomSlug: produces valid slugs', () => {
  for (let i = 0; i < 50; i++) {
    const s = randomSlug(8);
    assert(isValidSlug(s), `produced invalid slug: ${s}`);
  }
});
