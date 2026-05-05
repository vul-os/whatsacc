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
  referral_slug: string | null;
};

export type RegisterOpts = {
  email?: string;
  password?: string;
  display_name?: string;
  country_code?: string;
  account_type?: 'personal' | 'business';
  referral_slug?: string;
};

export async function registerUser(
  app: AppHandle,
  opts: RegisterOpts = {},
): Promise<RegisteredUser> {
  userCounter += 1;
  const email = opts.email ?? `user${userCounter}-${Date.now()}@test.local`;
  const password = opts.password ?? 'Pa55word_test';
  const display_name = opts.display_name ?? `Test User ${userCounter}`;

  const reg = await app.request('POST', '/auth/register', {
    json: {
      email,
      password,
      display_name,
      country_code: opts.country_code ?? 'ZA',
      account_type: opts.account_type ?? 'personal',
      referral_slug: opts.referral_slug,
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

  const me = await app.request('GET', '/auth/me', { token: loginBody.access_token });
  const meBody = me.body as { user: { referral_slug: string | null } };

  return {
    user_id: regBody.id,
    account_id: regBody.account_id,
    email,
    password,
    display_name,
    access_token: loginBody.access_token,
    refresh_token: loginBody.refresh_token,
    referral_slug: meBody.user.referral_slug ?? null,
  };
}

/**
 * Manually grant a referral earning credit to a user. Used so payout tests
 * don't need a full Paystack roundtrip just to seed a balance.
 */
export async function seedReferralEarning(
  refererUserId: string,
  refereeUserId: string,
  amountZarCents: number,
): Promise<void> {
  await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      await tx`
        insert into referral_earnings
          (referrer_user_id, referee_user_id, source_kind, amount_zar_cents, rate_bps)
        values
          (${refererUserId}, ${refereeUserId}, 'adjustment', ${amountZarCents}, 1000)
      `;
    },
  );
}

/**
 * Mark a user's KYC as complete so payout flows can run.
 */
export async function completeKyc(
  userId: string,
  overrides: Partial<{
    full_name: string;
    contact_email: string;
    cellphone: string;
    bank_name: string;
    bank_branch_code: string;
    bank_account_number: string;
    bank_account_holder: string;
    bank_account_type: 'cheque' | 'savings' | 'transmission';
  }> = {},
): Promise<void> {
  const k = {
    full_name: overrides.full_name ?? 'Test Holder',
    contact_email: overrides.contact_email ?? null,
    cellphone: overrides.cellphone ?? '+27821234567',
    bank_name: overrides.bank_name ?? 'FNB',
    bank_branch_code: overrides.bank_branch_code ?? '250655',
    bank_account_number: overrides.bank_account_number ?? '62123456789',
    bank_account_holder: overrides.bank_account_holder ?? 'Test Holder',
    bank_account_type: overrides.bank_account_type ?? 'cheque',
  };
  await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    async (tx) => {
      await tx`
        insert into kyc_profiles
          (user_id, full_name, contact_email, cellphone, id_kind, id_number,
           bank_name, bank_branch_code, bank_account_number, bank_account_holder,
           bank_account_type)
        values
          (${userId}, ${k.full_name}, ${k.contact_email}, ${k.cellphone},
           'za_id', '8001015009087',
           ${k.bank_name}, ${k.bank_branch_code}, ${k.bank_account_number},
           ${k.bank_account_holder}, ${k.bank_account_type})
        on conflict (user_id) do update set
          full_name = excluded.full_name,
          contact_email = excluded.contact_email,
          cellphone = excluded.cellphone,
          id_kind = excluded.id_kind,
          id_number = excluded.id_number,
          bank_name = excluded.bank_name,
          bank_branch_code = excluded.bank_branch_code,
          bank_account_number = excluded.bank_account_number,
          bank_account_holder = excluded.bank_account_holder,
          bank_account_type = excluded.bank_account_type,
          updated_at = now()
      `;
    },
  );
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

/**
 * Generate a Paystack-style HMAC-SHA512 signature over the supplied raw body.
 * Used to test the webhook signature path.
 */
export async function signPaystackBody(secret: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function rawSqlAdmin<T extends Record<string, unknown> = Record<string, unknown>>(
  fn: (tx: typeof getSql extends () => infer S ? S : never) => Promise<T[]>,
): Promise<T[]> {
  return await withRLS(
    { user_id: '', account_id: null, is_platform_admin: true },
    fn as never,
  );
}
