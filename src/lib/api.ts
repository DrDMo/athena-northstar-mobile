/**
 * API client — talks to the North Star backend at
 * appraisal.athenanorthstar.com. Mirrors the shape of `web/src/lib/api.ts`
 * so the two surfaces stay grep-compatible.
 *
 * Authentication: the backend accepts either a `Cookie: session=…`
 * header (web app) or an `Authorization: Bearer …` API key
 * (programmatic clients). The mobile client uses the cookie form,
 * persisting the token via {@link saveSession} from `./session`.
 *
 * The API base URL is sourced from `app.json` → `expo.extra.apiBase`.
 * Override in dev by editing app.json directly.
 */

import Constants from 'expo-constants';
import { loadSession, saveSession, clearSession } from './session';

const API_BASE: string =
  (Constants.expoConfig?.extra as { apiBase?: string } | undefined)?.apiBase ??
  'https://appraisal.athenanorthstar.com';

// ---------------------------------------------------------------------------
// Low-level fetch with session cookie injection.
// ---------------------------------------------------------------------------

export async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${API_BASE}${path}`;
  const session = await loadSession();
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  if (session) {
    headers.set('cookie', `session=${session}`);
  }
  return fetch(url, { ...init, headers });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type AuthMe = {
  user_id?: string;
  email?: string;
  display_name?: string;
  tenant_id: string;
  tenant_slug: string;
  role?: 'tenant_user' | 'admin';
  session_expires_at?: string;
};

/**
 * Log in by posting credentials. Captures the session token from
 * Set-Cookie and saves it via SecureStore so subsequent calls are
 * authenticated automatically.
 */
export async function login(input: {
  email: string;
  password: string;
}): Promise<AuthMe> {
  const res = await fetch(`${API_BASE}/v1/auth/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: 'login failed' }));
    throw new Error(body.message ?? `login failed (${res.status})`);
  }
  const setCookie =
    // RN puts Set-Cookie under the same name; on web it's hidden.
    res.headers.get('set-cookie') ?? res.headers.get('Set-Cookie');
  if (setCookie) {
    const match = setCookie.match(/session=([^;]+)/);
    if (match?.[1]) {
      await saveSession(match[1]);
    }
  }
  return (await res.json()) as AuthMe;
}

export async function logout(): Promise<void> {
  try {
    await apiFetch('/v1/auth/sessions', { method: 'DELETE' });
  } finally {
    await clearSession();
  }
}

export async function fetchMe(): Promise<AuthMe | null> {
  const res = await apiFetch('/v1/auth/me');
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/v1/auth/me returned ${res.status}`);
  return (await res.json()) as AuthMe;
}

// ---------------------------------------------------------------------------
// Assignments (= cases on the backend; renamed in m197)
// ---------------------------------------------------------------------------

export type AssignmentSummary = {
  id: string;
  name?: string;
  domain: string;
  jurisdiction?: string;
  state: string;
  created_at: string;
};

export async function listAssignments(): Promise<AssignmentSummary[]> {
  const res = await apiFetch('/v1/cases');
  if (!res.ok) throw new Error(`listAssignments failed (${res.status})`);
  const body = (await res.json()) as { cases: AssignmentSummary[] };
  return body.cases;
}

export async function getAssignment(id: string): Promise<AssignmentSummary> {
  const res = await apiFetch(`/v1/cases/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`getAssignment failed (${res.status})`);
  return (await res.json()) as AssignmentSummary;
}

export async function createAssignment(input: {
  domain?: string;
  jurisdiction?: string;
}): Promise<AssignmentSummary> {
  const res = await apiFetch('/v1/cases', {
    method: 'POST',
    body: JSON.stringify({
      domain: input.domain ?? 'appraisal',
      jurisdiction: input.jurisdiction ?? 'US-WA',
    }),
  });
  if (!res.ok) throw new Error(`createAssignment failed (${res.status})`);
  return (await res.json()) as AssignmentSummary;
}
