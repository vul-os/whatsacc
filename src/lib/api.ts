// Lightweight API client for the whatsacc backend.
// Handles base URL, bearer auth, JSON, and one-shot refresh-on-401.

const ACCESS_KEY = 'whatsacc.access_token';
const REFRESH_KEY = 'whatsacc.refresh_token';

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
export const API_BASE_URL = (env.VITE_API_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');

export type ApiErrorBody = {
  error: string;
  detail?: string;
};

export class ApiError extends Error {
  status: number;
  code: string;
  detail?: string;
  constructor(status: number, body: ApiErrorBody | any) {
    let code: string = 'error';
    let detail: string | undefined = undefined;

    if (typeof body === 'string') {
      code = body;
    } else if (body && typeof body === 'object') {
      // 1. Handle standard { error, detail } shape
      if (typeof body.error === 'string') {
        code = body.error;
        detail = typeof body.detail === 'string' ? body.detail : undefined;
      } 
      // 2. Handle Hono/Zod error shape: { success: false, error: { issues: [...], name: 'ZodError' } }
      else if (body.error && typeof body.error === 'object' && Array.isArray(body.error.issues)) {
        code = 'validation_error';
        detail = body.error.issues[0]?.message;
      }
      // 3. Fallback for other objects
      else {
        code = body.error ? String(body.error) : 'error';
        detail = body.detail ? String(body.detail) : undefined;
      }
    }

    super(detail ? `${code}: ${detail}` : code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const tokenStore = {
  get access(): string | null {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh(): string | null {
    return localStorage.getItem(REFRESH_KEY);
  },
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

type FetchInit = Omit<RequestInit, 'body'> & { body?: unknown };

let refreshing: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (refreshing) return refreshing;
  const refresh = tokenStore.refresh;
  if (!refresh) return false;
  refreshing = (async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      });
      if (!res.ok) {
        tokenStore.clear();
        return false;
      }
      const j = (await res.json()) as { access_token: string; refresh_token: string };
      tokenStore.set(j.access_token, j.refresh_token);
      return true;
    } catch {
      tokenStore.clear();
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function apiFetch<T>(path: string, init: FetchInit = {}): Promise<T> {
  const { body, headers, ...rest } = init;
  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;

  const doRequest = async (): Promise<Response> => {
    const h = new Headers(headers as HeadersInit | undefined);
    if (body !== undefined && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
    const access = tokenStore.access;
    if (access && !h.has('Authorization')) h.set('Authorization', `Bearer ${access}`);
    return await fetch(url, {
      ...rest,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  let res = await doRequest();
  if (res.status === 401 && tokenStore.refresh) {
    const refreshed = await refreshAccessToken();
    if (refreshed) res = await doRequest();
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('Content-Type') ?? '';
  const isJson = ct.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    if (isJson && payload && typeof payload === 'object' && 'error' in payload) {
      throw new ApiError(res.status, payload as ApiErrorBody);
    }
    throw new ApiError(res.status, typeof payload === 'string' ? payload : `http_${res.status}`);
  }
  return payload as T;
}

async function apiBlob(path: string): Promise<Blob> {
  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;
  const request = async () => {
    const h = new Headers();
    const access = tokenStore.access;
    if (access) h.set('Authorization', `Bearer ${access}`);
    return await fetch(url, { headers: h });
  };
  let res = await request();
  if (res.status === 401 && tokenStore.refresh) {
    const refreshed = await refreshAccessToken();
    if (refreshed) res = await request();
  }
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => `http_${res.status}`));
  return await res.blob();
}

// Typed surface ------------------------------------------------------------

export type AuthTokens = {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
};

export type MeResponse = {
  user: {
    id: string;
    email: string;
    status: string;
    email_verified_at: string | null;
    is_platform_admin: boolean;
  };
  profile: {
    id: string;
    display_name: string | null;
    avatar_url: string | null;
    locale: string | null;
    slack_user_id: string | null;
    slack_handle: string | null;
  } | null;
  phones: Array<{
    id: string;
    phone_e164: string;
    verified_at: string | null;
    is_primary: boolean;
  }>;
  accounts: Array<{
    account_id: string;
    name: string;
    billing_type: string;
    role: string;
    status: string;
  }>;
};

export type CountryRef = {
  code: string;
  name: string;
  flag: string;
  currency_code: string;
  msg_cost_zar: number;
};

export const api = {
  login: (body: { email: string; password: string }) =>
    apiFetch<AuthTokens>('/auth/login', { method: 'POST', body }),

  register: (body: {
    email: string;
    password: string;
    display_name: string;
    phone_e164?: string;
    location_name?: string;
    country_code: string;
    account_type: 'personal' | 'business';
    referral_slug?: string;
    invite_token?: string;
  }) => apiFetch<AuthTokens & { id: string; account_id: string }>('/auth/register', { method: 'POST', body }),

  refresh: (refresh_token: string) =>
    apiFetch<AuthTokens>('/auth/refresh', { method: 'POST', body: { refresh_token } }),

  logout: (refresh_token: string) =>
    apiFetch<void>('/auth/logout', { method: 'POST', body: { refresh_token } }),

  me: () => apiFetch<MeResponse>('/auth/me'),

  phones: () => apiFetch<{ phones: MeResponse['phones'] }>('/phones/me/phones'),

  phoneAdd: (body: { phone_e164: string; is_primary?: boolean }) =>
    apiFetch<{ id: string }>('/phones/me/phones', { method: 'POST', body }),

  slackUpdate: (body: { slack_user_id?: string; slack_handle?: string }) =>
    apiFetch<void>('/auth/me/slack', { method: 'PUT', body }),

  forgotPassword: (email: string) =>
    apiFetch<void>('/auth/forgot-password', { method: 'POST', body: { email } }),

  resetPassword: (token: string, new_password: string) =>
    apiFetch<void>('/auth/reset-password', {
      method: 'POST',
      body: { token, new_password },
    }),

  verifyEmail: (token: string) =>
    apiFetch<void>('/auth/verify-email', {
      method: 'POST',
      body: { token },
    }),

  updatePassword: (current_password: string, new_password: string) =>
    apiFetch<void>('/auth/update-password', {
      method: 'POST',
      body: { current_password, new_password },
    }),

  countries: () => apiFetch<{ countries: CountryRef[] }>('/reference/countries'),

  googleStartUrl: () => `${API_BASE_URL}/auth/google/start`,

  accountBilling: (accountId: string) =>
    apiFetch<AccountBilling>(`/billing/accounts/${accountId}/billing`),

  accountUpdate: (accountId: string, body: { name?: string }) =>
    apiFetch<void>(`/accounts/${accountId}`, { method: 'PATCH', body }),

  walletTopup: (body: { account_id: string; amount_cents: number; callback_path?: string }) =>
    apiFetch<TopupResponse>('/billing/wallet/topup', { method: 'POST', body }),

  walletVerify: (reference: string) =>
    apiFetch<WalletVerifyResponse>(
      `/billing/wallet/verify?reference=${encodeURIComponent(reference)}`,
    ),

  changePlan: (accountId: string, plan_code: string) =>
    apiFetch<{ plan_code: string; price_cents: number }>(
      `/billing/accounts/${accountId}/plan`,
      { method: 'POST', body: { plan_code } },
    ),

  subscriptionCheckout: (accountId: string, plan_code: string) =>
    apiFetch<TopupResponse>(
      `/billing/accounts/${accountId}/subscription-checkout`,
      { method: 'POST', body: { plan_code } },
    ),

  invoices: (accountId: string) =>
    apiFetch<{ invoices: InvoiceSummary[] }>(`/billing/accounts/${accountId}/invoices`),

  invoicePdfUrl: (id: string) =>
    `${API_BASE_URL}/billing/invoices/${encodeURIComponent(id)}.pdf`,

  invoicePdf: (id: string) =>
    apiBlob(`/billing/invoices/${encodeURIComponent(id)}.pdf`),

  accessPoints: (accountId?: string) => {
    const qs = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
    return apiFetch<{ access_points: AccessPointDetail[] }>(`/access/access-points${qs}`);
  },

  accessPoint: (id: string) =>
    apiFetch<AccessPointDetail>(`/access/access-points/${id}`),

  accessPointCreate: (body: {
    location_id: string;
    name: string;
    kind: 'gate' | 'door' | 'barrier' | 'other';
    device_id?: string | null;
    lat?: number;
    long?: number;
  }) =>
    apiFetch<AccessPointDetail>('/access/access-points', { method: 'POST', body }),

  maintenanceList: (id: string) =>
    apiFetch<{ events: MaintenanceEvent[] }>(`/access/access-points/${id}/maintenance`),

  maintenanceCreate: (id: string, body: MaintenanceCreateInput) =>
    apiFetch<MaintenanceEvent>(`/access/access-points/${id}/maintenance`, {
      method: 'POST',
      body,
    }),

  referralResolve: (slug: string) =>
    apiFetch<ReferralResolve>(`/referrals/resolve/${encodeURIComponent(slug)}`),

  referralMe: () => apiFetch<ReferralMe>('/referrals/me'),

  referralUpdateSlug: (slug: string) =>
    apiFetch<{ slug: string }>('/referrals/slug', { method: 'PUT', body: { slug } }),

  kycGet: () =>
    apiFetch<{ kyc: KycProfile | null; complete: boolean }>('/referrals/kyc'),

  kycPut: (body: Partial<KycProfile>) =>
    apiFetch<{ kyc: KycProfile | null; complete: boolean }>('/referrals/kyc', {
      method: 'PUT',
      body,
    }),

  payoutRequest: (amount_zar_cents: number) =>
    apiFetch<{ id: string }>('/referrals/payouts', {
      method: 'POST',
      body: { amount_zar_cents },
    }),

  payoutCancel: (id: string) =>
    apiFetch<void>(`/referrals/payouts/${id}/cancel`, { method: 'POST' }),

  grants: (q: { account_id?: string; phone_e164?: string; status?: 'active' | 'revoked' } = {}) => {
    const qs = new URLSearchParams();
    if (q.account_id) qs.set('account_id', q.account_id);
    if (q.phone_e164) qs.set('phone_e164', q.phone_e164);
    if (q.status) qs.set('status', q.status);
    const s = qs.toString();
    return apiFetch<{ grants: TemporaryAccessGrant[] }>(`/access/grants${s ? `?${s}` : ''}`);
  },

  grant: (id: string) => apiFetch<TemporaryAccessGrant>(`/access/grants/${id}`),

  grantCreate: (body: GrantCreateInput) =>
    apiFetch<TemporaryAccessGrant>('/access/grants', { method: 'POST', body }),

  grantRevoke: (id: string) =>
    apiFetch<TemporaryAccessGrant>(`/access/grants/${id}/revoke`, { method: 'POST' }),

  // Locations
  locationsList: (accountId: string) =>
    apiFetch<{ locations: LocationRow[] }>(`/locations/accounts/${accountId}/locations`),

  locationCreate: (
    accountId: string,
    body: {
      type: 'house' | 'complex' | 'building' | 'other';
      name: string;
      slug?: string;
      parent_location_id?: string;
      address?: Record<string, unknown>;
      lat?: number;
      long?: number;
    },
  ) => apiFetch<{ id: string }>(`/locations/accounts/${accountId}/locations`, { method: 'POST', body }),

  // Top-level: each location is its own account+location (no shared org).
  locationCreateNew: (body: {
    name: string;
    type?: 'house' | 'complex' | 'building' | 'other';
    country_code?: string;
    address?: Record<string, unknown>;
    lat?: number;
    long?: number;
  }) => apiFetch<{ id: string; account_id: string }>('/locations', { method: 'POST', body }),

  locationDelete: (id: string) =>
    apiFetch<{ deleted: string; account_dropped: boolean }>(
      `/locations/${id}`,
      { method: 'DELETE' },
    ),

  locationUpdate: (
    id: string,
    body: {
      name?: string;
      address?: Record<string, unknown>;
      lat?: number;
      long?: number;
      status?: string;
    },
  ) => apiFetch<void>(`/locations/${id}`, { method: 'PATCH', body }),

  // Devices
  devicesList: (filter?: { location_id?: string; account_id?: string }) => {
    const params = new URLSearchParams();
    if (filter?.location_id) params.set('location_id', filter.location_id);
    if (filter?.account_id) params.set('account_id', filter.account_id);
    const qs = params.toString();
    return apiFetch<{ devices: DeviceRow[] }>(`/devices${qs ? `?${qs}` : ''}`);
  },

  deviceCreate: (body: { location_id: string; label?: string; claim_ttl_seconds?: number }) =>
    apiFetch<DeviceCreateResponse>('/devices', { method: 'POST', body }),

  deviceClaim: (claim_token: string, public_key?: string) =>
    apiFetch<{ id: string }>('/devices/claim', { method: 'POST', body: { claim_token, public_key } }),

  // Members
  accountMembers: (accountId: string) =>
    apiFetch<{ members: AccountMemberRow[] }>(`/accounts/${accountId}/members`),

  inviteCreate: (accountId: string, body: { email: string; role?: 'owner' | 'admin' | 'member' | 'viewer'; phone_e164: string }) =>
    apiFetch<{ id: string; accept_url: string; email_sent: boolean; whatsapp_sent: boolean }>(
      `/accounts/${accountId}/invites`,
      { method: 'POST', body },
    ),

  inviteAccept: (token: string, phone_e164?: string) =>
    apiFetch<{ account_id: string; role: string }>(
      `/accounts/invites/${encodeURIComponent(token)}/accept`,
      { method: 'POST', body: { phone_e164 } },
    ),

  // Access ops
  accessOpen: (id: string, body: { lat?: number; long?: number; source?: 'web' | 'whatsapp' | 'telegram' | 'slack' | 'api' } = {}) =>
    apiFetch<{ ok: boolean; command: 'open' }>(`/access/access-points/${id}/open`, {
      method: 'POST',
      body: { source: 'web', ...body },
    }),

  accessClose: (id: string, body: { lat?: number; long?: number; source?: 'web' | 'whatsapp' | 'telegram' | 'slack' | 'api' } = {}) =>
    apiFetch<{ ok: boolean; command: 'close' }>(`/access/access-points/${id}/close`, {
      method: 'POST',
      body: { source: 'web', ...body },
    }),

  // Analytics
  accountSummary: (accountId: string) =>
    apiFetch<AccountSummary>(`/analytics/accounts/${accountId}/summary`),

  tiers: (opts: { country?: string; region?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.country) qs.set('country', opts.country);
    if (opts.region) qs.set('region', opts.region);
    const s = qs.toString();
    return apiFetch<BillingTiersResponse>(`/billing/tiers${s ? `?${s}` : ''}`);
  },
};

export type LocationRow = {
  id: string;
  parent_location_id: string | null;
  type: 'house' | 'complex' | 'building' | 'other';
  name: string;
  slug: string | null;
  status: string;
  address: { city?: string; [k: string]: unknown } | null;
  access_point_count: number;
  member_count: number;
  last_opened_at: string | null;
};

export type DeviceRow = {
  id: string;
  location_id: string;
  label: string | null;
  status: 'unpaired' | 'active' | 'offline' | string;
  paired_at: string | null;
  last_seen_at: string | null;
  claim_expires_at: string | null;
  created_at: string;
};

export type DeviceCreateResponse = {
  id: string;
  location_id: string;
  label: string | null;
  status: string;
  claim_token: string;
  claim_expires_at: string;
};

export type AccountMemberRow = {
  user_id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  status: string;
  email: string;
  display_name: string | null;
};

export type AccountSummary = {
  account_id: string;
  opens_today: number;
  opens_yesterday: number;
  location_count: number;
  member_count: number;
  recent_activity: Array<{
    id: string;
    ts: string;
    command: string;
    success: boolean;
    source: string | null;
    access_point_name: string | null;
    location_name: string | null;
    actor_email: string | null;
  }>;
};

export type TemporaryAccessGrant = {
  id: string;
  account_id: string;
  granted_by_user_id: string | null;
  phone_e164: string;
  visitor_name: string | null;
  starts_at: string;
  ends_at: string;
  max_uses: number | null;
  uses_count: number;
  status: 'active' | 'revoked';
  effective_status: 'pending' | 'active' | 'expired' | 'exhausted' | 'revoked';
  revoked_at: string | null;
  notes: string | null;
  last_used_at: string | null;
  access_point_ids: string[];
  created_at: string;
};

export type GrantCreateInput = {
  phone_e164: string;
  visitor_name?: string;
  starts_at?: string;
  ends_at: string;
  max_uses?: number;
  access_point_ids: string[];
  notes?: string;
};

export type ReferralResolve = {
  slug: string;
  display_name: string;
  avatar_url: string | null;
};

export type KycProfile = {
  user_id: string;
  full_name: string | null;
  contact_email: string | null;
  cellphone: string | null;
  id_kind: 'za_id' | 'passport' | null;
  id_number: string | null;
  bank_name: string | null;
  bank_branch_code: string | null;
  bank_account_number: string | null;
  bank_account_holder: string | null;
  bank_account_type: 'cheque' | 'savings' | 'transmission' | null;
  verified_at: string | null;
};

export type ReferralEarning = {
  id: string;
  amount_zar_cents: number;
  source_kind: string;
  rate_bps: number;
  created_at: string;
  referee_email_masked: string;
};

export type PayoutRow = {
  id: string;
  amount_zar_cents: number;
  status: 'pending' | 'approved' | 'paid' | 'rejected' | 'cancelled';
  requested_at: string;
  processed_at: string | null;
  notes: string | null;
};

export type ReferralMe = {
  slug: string | null;
  slug_updated_at: string | null;
  referred_by_user_id: string | null;
  balance: {
    earned_cents: number;
    paid_out_cents: number;
    pending_cents: number;
    available_cents: number;
  };
  counts: {
    referees_total: number;
    referees_active_30d: number;
  };
  recent_earnings: ReferralEarning[];
  payouts: PayoutRow[];
  kyc_status: { complete: boolean; verified_at: string | null };
  min_payout_cents: number;
};

export type AccessPointDetail = {
  id: string;
  location_id: string;
  name: string;
  kind: string;
  device_id: string | null;
  status: string;
  meter: {
    movement_m: number;
    total_opens: number;
    total_closes: number;
    last_op_at: string | null;
  };
  maintenance: {
    last_serviced_at: string | null;
    last_service_movement_m: number | null;
    next_due_movement_m: number | null;
    next_due_at: string | null;
    due_now: boolean;
    movement_remaining_m: number | null;
    pct_used: number | null;
  };
};

export type MaintenanceEvent = {
  id: string;
  access_point_id: string;
  kind: 'inspection' | 'service' | 'repair' | 'replacement';
  performed_at: string;
  performed_by: string | null;
  technician_name: string | null;
  notes: string | null;
  parts: unknown;
  cost_zar_cents: number | null;
  movement_m_at_event: number | null;
  next_due_movement_m: number | null;
  next_due_at: string | null;
  created_at: string;
};

export type MaintenanceCreateInput = {
  kind: 'inspection' | 'service' | 'repair' | 'replacement';
  performed_at?: string;
  technician_name?: string;
  notes?: string;
  parts?: Array<{ name: string; qty?: number; cost_zar_cents?: number }>;
  cost_zar_cents?: number;
  next_due_movement_m?: number;
  next_due_at?: string;
  next_due_in_days?: number;
};

export type AccountBilling = {
  subscription: {
    plan_code: string;
    status: string;
    current_period_start: string | null;
    current_period_end: string | null;
  } | null;
  wallet: { balance_cents: number; currency: string } | null;
  payment_method: {
    card_last4: string | null;
    card_brand: string | null;
    has_authorization: boolean;
  } | null;
  recent_intents: Array<{
    id: string;
    amount_cents: number;
    currency: string;
    status: 'pending' | 'succeeded' | 'failed' | 'abandoned';
    created_at: string;
    completed_at: string | null;
    provider_reference: string;
    invoice_id: string | null;
  }>;
};

export type InvoiceSummary = {
  id: string;
  number: string;
  kind: string;
  currency: string;
  subtotal_cents: number;
  vat_rate_bps: number;
  vat_cents: number;
  total_cents: number;
  status: string;
  issued_at: string;
  paid_at: string | null;
};

export type TopupResponse = {
  intent_id: string;
  reference: string;
  authorization_url: string;
  access_code: string;
};

export type WalletVerifyResponse = {
  status: 'succeeded' | 'failed' | 'abandoned';
  intent_id: string;
  account_id: string;
  amount_cents: number;
  currency: string;
  already_credited: boolean;
  plan_activated: string | null;
};

export type BillingTier = {
  code: string;
  name: string;
  price: number;
  currency: string;
  included_opens: number;
  included_residents: number;
  included_devices: number;
  included_locations: number;
  web_portal: boolean;
  blurb: string;
};

export type BillingTiersResponse = {
  region: string;
  region_name: string;
  currency: string;
  countries: readonly string[];
  payg_open_price: number;
  tiers: BillingTier[];
};
