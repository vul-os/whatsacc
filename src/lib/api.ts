// Lightweight API client for the lintel backend.
// Handles base URL, bearer auth, JSON, and one-shot refresh-on-401.
//
// IMPORTANT — this targets the Go gateway (gateway/internal/httpapi), which
// is the product that actually ships (embedded into the gateway binary as
// the portal, and reused by the Tauri desktop shell). It does NOT target
// backend/src/app.ts (the historical Cloudflare Workers reference — kept in
// the repo for behavioral-spec purposes only, never deployed as the product).
// See gateway/README.md for the route-porting map.

import { gatewayFetch, getApiBaseUrl } from './gateway';

const ACCESS_KEY = 'lintel.access_token';
const REFRESH_KEY = 'lintel.refresh_token';

// The base URL is resolved per-request (not a build-time constant) so the
// desktop app can point at any gateway. Resolution order: the user's stored
// gateway ('lintel.gateway_url'), then VITE_API_BASE_URL, then localhost.
export { getApiBaseUrl } from './gateway';

// Every route below lives under this prefix on the gateway (see
// gateway/internal/httpapi/server.go's Router() — every mux.Handle(Func) call
// registers "METHOD /v1/..."). Centralized here — NOT repeated in each path
// string below — so a new endpoint can't be added without it; the
// alternative (baking /v1 into each path literal) is exactly the kind of
// per-call-site detail that's easy to forget and was part of how this
// portal drifted from the gateway in the first place. `getApiBaseUrl()`
// itself stays un-prefixed because a couple of gateway routes (/health, the
// controller-pairing endpoints) are intentionally NOT under /v1.
//
// gateway/cmd/routegen and src/lib/__tests__/routeParity.test.ts both import
// this constant so the parity test can't drift from what apiFetch actually
// sends.
export const API_VERSION_PREFIX = '/v1';

export type ApiErrorBody = {
  error: string;
  detail?: string;
  /** Present on 429 responses (rate limit / quota); seconds until retry. */
  retry_after_s?: number;
};

export class ApiError extends Error {
  status: number;
  code: string;
  detail?: string;
  /** Seconds until the request may be retried (429 only). */
  retryAfterS?: number;
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
    if (body && typeof body === 'object' && typeof body.retry_after_s === 'number') {
      this.retryAfterS = body.retry_after_s;
    }
  }
}

/**
 * Sentinel ApiError code thrown by apiFetch when a 2xx response isn't JSON.
 * Every gateway endpoint below returns either JSON or 204 — a non-JSON 2xx
 * only happens when `path` doesn't match any registered gateway route: the
 * embedded portal's SPA fallback (gateway/internal/portal) answers
 * everything unmatched with 200 + index.html rather than 404, so treating
 * "the request didn't throw" as success would silently render that HTML
 * page's bytes as if they were real API data. This is the guard against
 * that trap — every call site that hits a route the gateway genuinely
 * doesn't implement yet (see gateway/README.md's porting map) should expect
 * this code and degrade to an explicit "not available" state, never an
 * infinite spinner or fabricated data.
 */
export const UNAVAILABLE_CODE = 'gateway_route_unavailable';

export function isUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.code === UNAVAILABLE_CODE;
}

/** Friendly, ready-to-render message for any error apiFetch can throw. */
export function friendlyApiError(err: unknown, fallback = 'Something went wrong.'): string {
  if (isUnavailable(err)) return "This isn't available on this gateway yet.";
  if (err instanceof ApiError) return err.detail ?? err.code;
  if (err instanceof Error) return err.message;
  return fallback;
}

export type RateLimitDenial = {
  reason: 'rate_limited' | 'quota_exceeded';
  retryAfterS: number;
};

/**
 * Narrow an unknown error to a 429 denial. Returns the denial reason and a
 * clean retry hint (seconds, ≥1) or null when the error is anything else.
 */
export function rateLimitInfo(err: unknown): RateLimitDenial | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  return {
    reason: err.code === 'quota_exceeded' ? 'quota_exceeded' : 'rate_limited',
    retryAfterS: Math.max(1, Math.ceil(err.retryAfterS ?? 30)),
  };
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
      const res = await gatewayFetch(`${getApiBaseUrl()}${API_VERSION_PREFIX}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      });
      if (!res.ok) {
        tokenStore.clear();
        return false;
      }
      const ct = res.headers.get('Content-Type') ?? '';
      if (!ct.includes('application/json')) {
        tokenStore.clear();
        return false;
      }
      const j = (await res.json().catch(() => null)) as RefreshResponse | null;
      if (!j?.tokens?.access_token || !j.tokens.refresh_token) {
        tokenStore.clear();
        return false;
      }
      tokenStore.set(j.tokens.access_token, j.tokens.refresh_token);
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
  const url = path.startsWith('http') ? path : `${getApiBaseUrl()}${API_VERSION_PREFIX}${path}`;

  const doRequest = async (): Promise<Response> => {
    const h = new Headers(headers as HeadersInit | undefined);
    if (body !== undefined && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
    const access = tokenStore.access;
    if (access && !h.has('Authorization')) h.set('Authorization', `Bearer ${access}`);
    return await gatewayFetch(url, {
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

  // SPA-fallback trap guard (see UNAVAILABLE_CODE's doc comment above): a
  // 2xx that isn't JSON is never a real answer from this API — it's the
  // embedded portal's catch-all. Fail loudly instead of returning HTML bytes
  // typed as T.
  if (res.ok && !isJson) {
    throw new ApiError(res.status, UNAVAILABLE_CODE);
  }

  const payload = isJson ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    const err =
      isJson && payload && typeof payload === 'object' && 'error' in payload
        ? new ApiError(res.status, payload as ApiErrorBody)
        : new ApiError(res.status, typeof payload === 'string' ? payload : `http_${res.status}`);
    // Fall back to the Retry-After header when the body didn't carry the hint.
    if (err.retryAfterS === undefined) {
      const ra = res.headers.get('Retry-After');
      if (ra && /^\d+$/.test(ra)) err.retryAfterS = Number(ra);
    }
    throw err;
  }
  return payload as T;
}

// Typed surface ------------------------------------------------------------
//
// Gateway timestamps are Unix seconds (int64 / sql.NullInt64 on the Go
// side — see gateway/internal/store), NOT ISO-8601 strings. The one
// exception is LocationLimits.usage.day_start, which the gateway explicitly
// formats via time.Format(time.RFC3339) — see handleLocationLimitsGet.
export type UnixSeconds = number;

// Tokens are nested under `tokens` (not flattened onto the response), per
// gateway/internal/httpapi/auth.go's issueTokensCtx.
export type AuthTokens = {
  access_token: string;
  refresh_token: string;
};

export type LoginResponse = {
  user: { id: string; email: string; is_platform_admin: boolean };
  tokens: AuthTokens;
  token_type: 'Bearer';
};

export type RegisterResponse = {
  user: { id: string; email: string };
  account: { id: string; name: string };
  location: { id: string; name: string; slug: string | null };
  tokens: AuthTokens;
  token_type: 'Bearer';
};

export type RefreshResponse = {
  tokens: AuthTokens;
  token_type: 'Bearer';
};

// GET /v1/auth/me — the gateway's skeleton auth (see gateway/internal/httpapi/auth.go's
// handleMe) does not carry profile/phones/email-verification/Slack/avatar
// data; none of that is implemented on this backend yet (no /auth/me/profile,
// /auth/me/slack, or /phones/me/phones routes exist). Keep this type honest
// to what the gateway actually returns rather than the richer shape the old
// Workers backend (backend/src/routes/auth.ts) used to send.
export type MeResponse = {
  user: {
    id: string;
    email: string;
    is_platform_admin: boolean;
  };
  accounts: Array<{
    id: string;
    name: string;
    role: string;
  }>;
};

export type CountryRef = {
  code: string;
  name: string;
  flag: string;
};

export const api = {
  login: (body: { email: string; password: string }) =>
    apiFetch<LoginResponse>('/auth/login', { method: 'POST', body }),

  // account_type and invite_token are UI-only concerns the gateway's
  // registerReq (gateway/internal/httpapi/auth.go) doesn't accept — and
  // because readJSON there calls json.Decoder.DisallowUnknownFields(),
  // sending them at all would 400 the whole request, not just get ignored.
  // phone_e164 is accepted by the parameter for call-site compatibility but
  // is similarly dropped: there is no /phones route on the gateway to attach
  // it to. Invite acceptance is a separate explicit api.inviteAccept() call
  // (see src/pages/Signup.tsx) — the gateway registers accounts+invites as
  // two independent steps, not one atomic register-and-join.
  register: (body: {
    email: string;
    password: string;
    display_name: string;
    phone_e164?: string;
    location_name?: string;
    country_code: string;
    account_type?: 'personal' | 'business';
    invite_token?: string;
  }) =>
    apiFetch<RegisterResponse>('/auth/register', {
      method: 'POST',
      body: {
        email: body.email,
        password: body.password,
        display_name: body.display_name,
        location_name: body.location_name,
        country_code: body.country_code,
      },
    }),

  refresh: (refresh_token: string) =>
    apiFetch<RefreshResponse>('/auth/refresh', { method: 'POST', body: { refresh_token } }),

  logout: (refresh_token: string) =>
    apiFetch<{ ok: boolean }>('/auth/logout', { method: 'POST', body: { refresh_token } }),

  me: () => apiFetch<MeResponse>('/auth/me'),

  // NOT IMPLEMENTED on the gateway (no /phones route at all). Kept so call
  // sites can attempt it and get a clean UNAVAILABLE_CODE ApiError instead
  // of a dead link; UI must treat failure as "not available", not an error.
  phones: () => apiFetch<{ phones: Array<{ id: string; phone_e164: string; verified_at: string | null; is_primary: boolean }> }>('/phones/me/phones'),
  phoneAdd: (body: { phone_e164: string; is_primary?: boolean }) =>
    apiFetch<{ id: string }>('/phones/me/phones', { method: 'POST', body }),

  // NOT IMPLEMENTED on the gateway (no /auth/me/slack route).
  slackUpdate: (body: { slack_user_id?: string; slack_handle?: string }) =>
    apiFetch<void>('/auth/me/slack', { method: 'PUT', body }),

  // NOT IMPLEMENTED on the gateway (no /auth/me/profile route).
  profileUpdate: (body: { display_name?: string; avatar_url?: string | null }) =>
    apiFetch<{ profile: { id: string; display_name: string | null; avatar_url: string | null } }>(
      '/auth/me/profile',
      { method: 'PATCH', body },
    ),

  // NOT IMPLEMENTED on the gateway — no password-reset/verify-email ceremony
  // ported yet (see gateway/internal/httpapi/auth.go's doc comment: "the
  // ceremony around them... is deferred").
  forgotPassword: (email: string) =>
    apiFetch<void>('/auth/forgot-password', { method: 'POST', body: { email } }),
  resetPassword: (token: string, new_password: string) =>
    apiFetch<void>('/auth/reset-password', { method: 'POST', body: { token, new_password } }),
  verifyEmail: (token: string) =>
    apiFetch<void>('/auth/verify-email', { method: 'POST', body: { token } }),
  updatePassword: (current_password: string, new_password: string) =>
    apiFetch<void>('/auth/update-password', {
      method: 'POST',
      body: { current_password, new_password },
    }),

  // NOT IMPLEMENTED on the gateway (no /reference/countries route). Callers
  // already fall back to a static list on failure (see src/pages/Signup.tsx).
  countries: () => apiFetch<{ countries: CountryRef[] }>('/reference/countries'),

  // NOT IMPLEMENTED on the gateway — no OAuth routes exist at all. Google
  // sign-in is unconditionally disabled in the UI (Login.tsx / Signup.tsx)
  // rather than pointed at a dead link.
  googleStartUrl: () => `${getApiBaseUrl()}${API_VERSION_PREFIX}/auth/google/start`,

  accountUpdate: (accountId: string, body: { name?: string }) =>
    apiFetch<void>(`/accounts/${accountId}`, { method: 'PATCH', body }),

  accessPoints: (accountId?: string) => {
    const qs = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
    return apiFetch<{ access_points: AccessPointDetail[] }>(`/access-points${qs}`);
  },

  accessPoint: (id: string) => apiFetch<AccessPointDetail>(`/access-points/${id}`),

  accessPointCreate: (body: {
    location_id: string;
    name: string;
    kind: 'gate' | 'door' | 'barrier' | 'other';
    device_id?: string | null;
    lat?: number;
    long?: number;
  }) => apiFetch<AccessPointDetail>('/access-points', { method: 'POST', body }),

  // NOT IMPLEMENTED on the gateway — movement metering + maintenance
  // scheduling is a documented deviation (see accessPointJSON's comment in
  // gateway/internal/httpapi/access.go: "maintenance block carries the
  // 'nothing recorded' shape"). No /access-points/{id}/maintenance route
  // exists to list or log against.
  maintenanceList: (id: string) =>
    apiFetch<{ events: MaintenanceEvent[] }>(`/access-points/${id}/maintenance`),
  maintenanceCreate: (id: string, body: MaintenanceCreateInput) =>
    apiFetch<MaintenanceEvent>(`/access-points/${id}/maintenance`, { method: 'POST', body }),

  grants: (q: { account_id?: string; phone_e164?: string; status?: 'active' | 'revoked' } = {}) => {
    const qs = new URLSearchParams();
    if (q.account_id) qs.set('account_id', q.account_id);
    if (q.phone_e164) qs.set('phone_e164', q.phone_e164);
    if (q.status) qs.set('status', q.status);
    const s = qs.toString();
    return apiFetch<{ grants: TemporaryAccessGrant[] }>(`/grants${s ? `?${s}` : ''}`);
  },

  grant: (id: string) => apiFetch<TemporaryAccessGrant>(`/grants/${id}`),

  grantCreate: (body: GrantCreateInput) =>
    apiFetch<TemporaryAccessGrant>('/grants', { method: 'POST', body }),

  grantRevoke: (id: string) =>
    apiFetch<TemporaryAccessGrant>(`/grants/${id}/revoke`, { method: 'POST' }),

  // Locations — nested under /accounts/{id}/locations on the gateway, NOT
  // /locations/accounts/{id}/locations (the old Workers backend's shape).
  locationsList: (accountId: string) =>
    apiFetch<{ locations: LocationRow[] }>(`/accounts/${accountId}/locations`),

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
  ) => apiFetch<{ id: string }>(`/accounts/${accountId}/locations`, { method: 'POST', body }),

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

  // Abuse-protection quotas + today's usage (member-visible).
  locationLimits: (id: string) => apiFetch<LocationLimits>(`/locations/${id}/limits`),

  // Admin-only. null clears a cap (= unlimited); omitted fields are unchanged.
  locationLimitsUpdate: (id: string, body: LocationQuotaPatch) =>
    apiFetch<{ location_id: string; quotas: LocationQuotas }>(`/locations/${id}/limits`, {
      method: 'PATCH',
      body,
    }),

  // NOT IMPLEMENTED on the gateway (no /analytics route group ported yet).
  locationSummary: (id: string) =>
    apiFetch<LocationSummary>(`/analytics/locations/${id}/summary`),

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

  // Members
  accountMembers: (accountId: string) =>
    apiFetch<{ members: AccountMemberRow[] }>(`/accounts/${accountId}/members`),

  inviteCreate: (accountId: string, body: { email: string; role?: 'owner' | 'admin' | 'member' | 'viewer'; phone_e164: string }) =>
    apiFetch<{ id: string; email_sent: boolean; whatsapp_sent: boolean }>(
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
    apiFetch<{ ok: boolean; command: 'open'; delivery: string }>(`/access-points/${id}/open`, {
      method: 'POST',
      body: { source: 'web', ...body },
    }),

  accessClose: (id: string, body: { lat?: number; long?: number; source?: 'web' | 'whatsapp' | 'telegram' | 'slack' | 'api' } = {}) =>
    apiFetch<{ ok: boolean; command: 'close'; delivery: string }>(`/access-points/${id}/close`, {
      method: 'POST',
      body: { source: 'web', ...body },
    }),

  // NOT IMPLEMENTED on the gateway (no /analytics route group ported yet).
  accountSummary: (accountId: string) =>
    apiFetch<AccountSummary>(`/analytics/accounts/${accountId}/summary`),
  accountInsights: (accountId: string) =>
    apiFetch<AccountInsights>(`/analytics/accounts/${accountId}/insights`),

  // Instance admin (gateway operator) — everything under /admin is gated by
  // users.is_platform_admin except the one-time claim endpoints.
  adminClaimState: () => apiFetch<AdminClaimState>('/admin/claim'),

  adminClaim: (token: string) =>
    apiFetch<{ ok: boolean; user_id: string; is_platform_admin: boolean }>('/admin/claim', {
      method: 'POST',
      body: { token },
    }),

  adminOverview: () => apiFetch<AdminOverview>('/admin/overview'),

  adminAccounts: (q: AdminListQuery = {}) =>
    apiFetch<AdminAccountsResponse>(`/admin/accounts${adminListQs(q)}`),

  adminAccount: (id: string) => apiFetch<AdminAccountDetail>(`/admin/accounts/${id}`),

  adminAccountSetStatus: (id: string, status: 'active' | 'suspended') =>
    apiFetch<{ account: AdminAccountDetail['account'] }>(`/admin/accounts/${id}`, {
      method: 'PATCH',
      body: { status },
    }),

  adminUsers: (q: AdminListQuery = {}) =>
    apiFetch<AdminUsersResponse>(`/admin/users${adminListQs(q)}`),

  adminUserSetStatus: (id: string, status: 'active' | 'disabled') =>
    apiFetch<{ user: AdminUserSummary }>(`/admin/users/${id}`, {
      method: 'PATCH',
      body: { status },
    }),

  adminUserSetPlatformAdmin: (id: string, grant: boolean) =>
    apiFetch<{ user: AdminUserSummary }>(`/admin/users/${id}/platform-admin`, {
      method: 'POST',
      body: { grant },
    }),

  adminLimits: () => apiFetch<AdminLimitsResponse>('/admin/limits'),

  // Partial patch; null clears an override (falls back to env/default).
  adminLimitsUpdate: (patch: AdminLimitsPatch) =>
    apiFetch<AdminLimitsResponse>('/admin/limits', { method: 'PATCH', body: patch }),

  adminAudit: (q: { limit?: number; offset?: number; kind?: AdminAuditKind } = {}) => {
    const qs = new URLSearchParams();
    if (q.limit !== undefined) qs.set('limit', String(q.limit));
    if (q.offset !== undefined) qs.set('offset', String(q.offset));
    if (q.kind) qs.set('kind', q.kind);
    const s = qs.toString();
    return apiFetch<AdminAuditResponse>(`/admin/audit${s ? `?${s}` : ''}`);
  },

  adminAuditActions: (q: { limit?: number; offset?: number } = {}) =>
    apiFetch<AdminAuditActionsResponse>(`/admin/audit/actions${adminListQs(q)}`),
};

function adminListQs(q: AdminListQuery): string {
  const qs = new URLSearchParams();
  if (q.query) qs.set('query', q.query);
  if (q.limit !== undefined) qs.set('limit', String(q.limit));
  if (q.offset !== undefined) qs.set('offset', String(q.offset));
  const s = qs.toString();
  return s ? `?${s}` : '';
}

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
  last_opened_at: UnixSeconds | null;
};

export type LocationQuotas = {
  max_opens_per_member_per_day: number | null;
  max_opens_per_location_per_day: number | null;
};

export type LocationQuotaPatch = {
  max_opens_per_member_per_day?: number | null;
  max_opens_per_location_per_day?: number | null;
};

export type LocationLimits = {
  location_id: string;
  quotas: LocationQuotas;
  usage: {
    // Formatted server-side via time.RFC3339 (handleLocationLimitsGet) — an
    // actual ISO string, unlike the UnixSeconds fields elsewhere in this file.
    day_start: string;
    location_opens_today: number;
    my_opens_today: number;
    members: Array<{
      user_id: string | null;
      email: string | null;
      opens_today: number;
    }>;
  };
};

export type LocationSummary = {
  location_id: string;
  opens: number;
  closes: number;
  total: number;
  today: {
    day_start: string;
    opens: number;
    max_opens_per_member_per_day: number | null;
    max_opens_per_location_per_day: number | null;
  };
};

export type DeviceRow = {
  id: string;
  location_id: string;
  label: string | null;
  status: 'unpaired' | 'active' | 'offline' | string;
  paired_at: UnixSeconds | null;
  last_seen_at: UnixSeconds | null;
  claim_expires_at: UnixSeconds | null;
  created_at: UnixSeconds;
};

export type DeviceCreateResponse = {
  id: string;
  location_id: string;
  label: string | null;
  status: string;
  claim_token: string;
  claim_expires_at: UnixSeconds;
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
    ts: UnixSeconds;
    command: string;
    success: boolean;
    source: string | null;
    access_point_name: string | null;
    location_name: string | null;
    actor_email: string | null;
  }>;
};

export type AccountInsights = {
  account_id: string;
  days: Array<{ day: string; opens: number; denied: number }>;
  breakdown: Array<{
    access_point_id: string;
    access_point_name: string | null;
    location_name: string | null;
    opens: number;
  }>;
  totals: {
    opens_7d: number;
    denied_7d: number;
    closes_7d: number;
    opens_prev_7d: number;
  };
  members: {
    member_count: number;
    active_members_7d: number;
  };
};

export type TemporaryAccessGrant = {
  id: string;
  account_id: string;
  granted_by_user_id: string | null;
  phone_e164: string;
  visitor_name: string | null;
  starts_at: UnixSeconds;
  ends_at: UnixSeconds;
  max_uses: number | null;
  uses_count: number;
  status: 'active' | 'revoked';
  effective_status: 'pending' | 'active' | 'expired' | 'exhausted' | 'revoked';
  revoked_at: UnixSeconds | null;
  notes: string | null;
  last_used_at: UnixSeconds | null;
  access_point_ids: string[];
  created_at: UnixSeconds;
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
    last_op_at: UnixSeconds | null;
  };
  maintenance: {
    last_serviced_at: UnixSeconds | null;
    last_service_movement_m: number | null;
    next_due_movement_m: number | null;
    next_due_at: UnixSeconds | null;
    due_now: boolean;
    movement_remaining_m: number | null;
    pct_used: number | null;
  };
};

export type MaintenanceEvent = {
  id: string;
  access_point_id: string;
  kind: 'inspection' | 'service' | 'repair' | 'replacement';
  performed_at: UnixSeconds;
  performed_by: string | null;
  technician_name: string | null;
  notes: string | null;
  parts: unknown;
  cost_zar_cents: number | null;
  movement_m_at_event: number | null;
  next_due_movement_m: number | null;
  next_due_at: UnixSeconds | null;
  created_at: UnixSeconds;
};

// ── Instance admin (gateway operator) ───────────────────────────────────────

export type AdminListQuery = { query?: string; limit?: number; offset?: number };

export type AdminClaimState = {
  /** true once any platform admin exists (or a claim was ever redeemed). */
  claimed: boolean;
  /** true when ADMIN_CLAIM_TOKEN is configured and the claim is still open. */
  claimable: boolean;
};

export type AdminOverview = {
  totals: {
    users: number;
    accounts: number;
    locations: number;
    devices: number;
    access_points: number;
  };
  opens: { today: number; last_7d: number };
  denials_today: {
    total: number;
    rate_limited: number;
    quota_exceeded: number;
    account_suspended: number;
    other: number;
  };
  recent_signups: Array<{
    id: string;
    email: string;
    display_name: string | null;
    status: string;
    is_platform_admin: boolean;
    created_at: UnixSeconds;
  }>;
};

export type AdminAccountRow = {
  id: string;
  name: string;
  status: 'active' | 'suspended' | string;
  country_code: string;
  created_at: UnixSeconds;
  member_count: number;
  location_count: number;
  opens_7d: number;
};

export type AdminAccountsResponse = {
  accounts: AdminAccountRow[];
  total: number;
  limit: number;
  offset: number;
};

export type AdminAccessLogEntry = {
  id: string;
  ts: UnixSeconds;
  command: string | null;
  source: string | null;
  success: boolean;
  error: string | null;
  account_id: string | null;
  account_name: string | null;
  location_id: string | null;
  location_name: string | null;
  access_point_id: string | null;
  access_point_name: string | null;
  user_id: string | null;
  user_email: string | null;
};

export type AdminAccountDetail = {
  account: {
    id: string;
    name: string;
    status: 'active' | 'suspended' | string;
    country_code: string;
    created_at: UnixSeconds;
  };
  members: Array<{
    user_id: string;
    email: string;
    display_name: string | null;
    role: string;
    status: string;
  }>;
  locations: Array<{
    id: string;
    name: string;
    type: string;
    slug: string | null;
    status: string;
  }>;
  recent_access_logs: AdminAccessLogEntry[];
};

export type AdminUserRow = {
  id: string;
  email: string;
  status: 'active' | 'disabled' | string;
  is_platform_admin: boolean;
  created_at: UnixSeconds;
  display_name: string | null;
  accounts: Array<{ account_id: string; name: string; role: string }>;
  last_access_at: UnixSeconds | null;
};

export type AdminUsersResponse = {
  users: AdminUserRow[];
  total: number;
  limit: number;
  offset: number;
};

/** Shape returned by user-mutating admin endpoints. */
export type AdminUserSummary = {
  id: string;
  email: string;
  status: string;
  is_platform_admin: boolean;
};

export type AdminLimitField =
  | 'open_cooldown_s'
  | 'opens_per_hour'
  | 'chat_msgs_per_min'
  | 'account_opens_per_hour';

export type AdminLimitValues = Record<AdminLimitField, number>;

export type AdminLimitsResponse = {
  defaults: AdminLimitValues;
  env: AdminLimitValues;
  overrides: Record<AdminLimitField, number | null>;
  effective: AdminLimitValues;
};

// Setting opens_per_hour / account_opens_per_hour to 0 is an instance-wide
// kill switch — the backend rejects it (400 kill_switch_confirmation_required)
// unless confirm_kill_switch: true accompanies the patch.
export type AdminLimitsPatch = Partial<Record<AdminLimitField, number | null>> & {
  confirm_kill_switch?: boolean;
};

export type AdminAuditKind =
  | 'all'
  | 'denied'
  | 'success'
  | 'open'
  | 'close'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'account_suspended';

export type AdminAuditResponse = {
  entries: AdminAccessLogEntry[];
  total: number;
  limit: number;
  offset: number;
  kind: AdminAuditKind;
};

export type AdminAuditActionRow = {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  allowed: boolean;
  detail: unknown;
  created_at: UnixSeconds;
};

export type AdminAuditActionsResponse = {
  actions: AdminAuditActionRow[];
  total: number;
  limit: number;
  offset: number;
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
