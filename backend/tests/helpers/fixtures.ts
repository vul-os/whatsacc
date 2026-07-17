// Test fixtures. Build users, accounts, locations, etc. via the actual API
// (so the integration path is exercised) plus a few direct DB inserts where
// the API doesn't expose creation yet (devices, access points, etc.).

import { getSql, withRLS } from '@/lib/db.ts';
import type { AppHandle } from './app.ts';

let userCounter = 0;

export type RegisteredUser = {
  user_id: string;
  account_id: string;
  email: string;
  password: string;
  display_name: string;
  access_token: string;
  refresh_token: string;
};

export type RegisterOpts = {
  email?: string;
  password?: string;
  display_name?: string;
  location_name?: string;
  country_code?: string;
};

export async function registerUser(
  app: AppHandle,
  opts: RegisterOpts = {},
): Promise<RegisteredUser> {
  userCounter += 1;
  const email = opts.email ?? `user${userCounter}-${Date.now()}@example.com`;
  const password = opts.password ?? 'Pa55word_test';
  const display_name = opts.display_name ?? `Test User ${userCounter}`;

  const reg = await app.request('POST', '/auth/register', {
    json: {
      email,
      password,
      display_name,
      location_name: opts.location_name ?? `${display_name} HQ`,
      country_code: opts.country_code ?? 'ZA',
    },
  });
  if (reg.status !== 201) {
    throw new Error(`register failed (${reg.status}): ${reg.text}`);
  }
  const regBody = reg.body as { id: string; account_id: string };

  // Skip email verification in tests — flip status to active directly.
  await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      await tx`
        update users set status = 'active', email_verified_at = coalesce(email_verified_at, now())
        where id = ${regBody.id}
      `;
    },
  );

  const login = await app.request('POST', '/auth/login', {
    json: { email, password },
  });
  if (login.status !== 200) {
    throw new Error(`login failed (${login.status}): ${login.text}`);
  }
  const loginBody = login.body as { access_token: string; refresh_token: string };

  return {
    user_id: regBody.id,
    account_id: regBody.account_id,
    email,
    password,
    display_name,
    access_token: loginBody.access_token,
    refresh_token: loginBody.refresh_token,
  };
}

/**
 * Create a location, optional access_point + a meters row, returning the ids.
 */
export async function seedLocationWithAccessPoint(
  accountId: string,
  opts: { withAccessPoint?: boolean; gateMovementMperOp?: number } = {},
): Promise<{ location_id: string; access_point_id?: string }> {
  return await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      const [loc] = await tx<{ id: string }[]>`
        insert into locations (account_id, type, name, slug)
        values (${accountId}, 'house', 'Test Location', ${`test-loc-${crypto.randomUUID().slice(0, 8)}`})
        returning id
      `;
      const locationId = loc!.id;
      await tx`
        insert into location_settings (location_id, gate_movement_m_per_op)
        values (${locationId}, ${opts.gateMovementMperOp ?? 3.5})
      `;
      if (!opts.withAccessPoint) return { location_id: locationId };

      const [ap] = await tx<{ id: string }[]>`
        insert into access_points (location_id, name, kind, status)
        values (${locationId}, 'Main gate', 'gate', 'active')
        returning id
      `;
      return { location_id: locationId, access_point_id: ap!.id };
    },
  );
}

export async function rawSqlAdmin<T extends Record<string, unknown> = Record<string, unknown>>(
  fn: (tx: typeof getSql extends () => infer S ? S : never) => Promise<T[]>,
): Promise<T[]> {
  return await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    fn as never,
  );
}
