/**
 * API client — talks to the North Star backend at
 * appraisal.athenanorthstar.com. Mirrors the shape of `web/src/lib/api.ts`
 * so the two surfaces stay grep-compatible.
 *
 * Authentication: the backend accepts the session token via the
 * `X-Session-Token` header (native clients can't set `Cookie`), a
 * `Cookie: session=…` header (web), or `Authorization: Bearer …` (API
 * keys). The mobile client sends `X-Session-Token`, reading the token
 * from the login response body and persisting it via {@link saveSession}.
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
    // #380: send the token in a custom header, NOT `Cookie`. `Cookie` is a
    // forbidden request header that React Native (especially Android)
    // silently drops, so the cookie form never reached the server and every
    // authed call 401'd. The backend reads the token from `x-session-token`.
    headers.set('x-session-token', session);
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
  /** Raw session token — present on login/signup responses only (#380). */
  session_token?: string;
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
  // #380: React Native (especially Android) does NOT expose the
  // `Set-Cookie` response header to JS, so reading the token from it
  // silently failed and the session was never stored — login "succeeded"
  // then bounced straight back. The backend now also returns the raw token
  // in the body; read it there. Keep the Set-Cookie path as a web fallback.
  const body = (await res.json()) as AuthMe;
  if (body.session_token) {
    await saveSession(body.session_token);
  } else {
    const setCookie =
      res.headers.get('set-cookie') ?? res.headers.get('Set-Cookie');
    const match = setCookie?.match(/session=([^;]+)/);
    if (match?.[1]) await saveSession(match[1]);
  }
  return body;
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

// ---------------------------------------------------------------------------
// Captures inbox (m6)
//
// The server-side inbox lists captures that have arrived but haven't been
// linked to a case yet. The local AsyncStorage queue tracks in-flight
// uploads; this list shows what the server has actually persisted.
// ---------------------------------------------------------------------------

export type CaptureSummary = {
  id: string;
  kind: 'photo' | 'voice_note' | 'text_note' | 'sketch';
  client_id?: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  sha256_hex: string;
  captured_at: string;
  uploaded_at: string;
  case_id?: string;
  workfile_id?: string;
  geo?: { lat?: number; lon?: number; accuracyMeters?: number };
  caption?: string;
  /**
   * Transcription state for voice notes (null for non-audio captures).
   * queued | in_progress | completed | failed — surfaced read-only;
   * the server runs the transcription pipeline after upload.
   */
  transcript_status?: string;
  /** Typed transcript text once `transcript_status` is `completed`. */
  transcript_text?: string;
};

export async function listCaptureInbox(): Promise<CaptureSummary[]> {
  const res = await apiFetch('/v1/captures');
  if (!res.ok) throw new Error(`listCaptureInbox failed (${res.status})`);
  const body = (await res.json()) as { captures: CaptureSummary[] };
  return body.captures;
}

export async function linkCapture(
  id: string,
  input: { case_id?: string; workfile_id?: string },
): Promise<CaptureSummary> {
  const res = await apiFetch(`/v1/captures/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`linkCapture failed (${res.status})`);
  return (await res.json()) as CaptureSummary;
}

export async function deleteCapture(id: string): Promise<void> {
  const res = await apiFetch(`/v1/captures/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`deleteCapture failed (${res.status})`);
  }
}

/**
 * Re-poll the transcription pipeline for a voice note and return the
 * refreshed capture. The server checks the Transcribe job, persists
 * the typed text when it's done, and hands back the updated summary
 * (with `transcript_status` + `transcript_text`).
 *
 * Surfaces friendly errors for the states the field workflow hits:
 *   - 404: transcription wasn't kicked yet (uploaded moments ago, or
 *          this build of the server has transcription off)
 *   - 409: the job is mid-flight; try again shortly
 *   - 503: the server can't reach storage/transcription right now
 * None of these should crash the screen — the caller shows the message.
 */
export async function refreshTranscript(id: string): Promise<CaptureSummary> {
  const res = await apiFetch(
    `/v1/captures/${encodeURIComponent(id)}/transcribe/refresh`,
    { method: 'POST' },
  );
  if (!res.ok) {
    let detail: string;
    switch (res.status) {
      case 404:
        detail = 'Transcription hasn’t started yet. Try again in a moment.';
        break;
      case 409:
        detail = 'Still transcribing. Pull to refresh again shortly.';
        break;
      case 503:
        detail = 'Transcription is unavailable right now. Try again later.';
        break;
      default:
        detail = `Couldn’t refresh the transcript (HTTP ${res.status}).`;
    }
    // Prefer the server's message when it sent one.
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON body — keep the friendly default
    }
    throw new Error(detail);
  }
  return (await res.json()) as CaptureSummary;
}

export async function getCaptureDownloadUrl(id: string): Promise<{
  url: string;
  expires_at: string;
  content_type: string;
}> {
  const res = await apiFetch(`/v1/captures/${encodeURIComponent(id)}/download`);
  if (!res.ok) throw new Error(`getCaptureDownloadUrl failed (${res.status})`);
  return (await res.json()) as {
    url: string;
    expires_at: string;
    content_type: string;
  };
}

// ---------------------------------------------------------------------------
// Rule catalogs (m7) — appraiser's in-field reference
// ---------------------------------------------------------------------------

export type RuleCatalogSummary = {
  id: string;
  version: string;
  published_at: string;
  published_by: string;
  rule_count: number;
};

export type RuleCitation = {
  source?: string;
  section?: string;
  subsection?: string;
  url?: string;
  effective_from?: string;
};

export type RuleEntry = {
  id: string;
  name?: string;
  jurisdiction?: string;
  severity?: string;
  citation?: RuleCitation;
  message?: { on_pass?: string; on_fail?: string };
};

export async function listRuleCatalogs(): Promise<RuleCatalogSummary[]> {
  const res = await apiFetch('/v1/rule-catalogs');
  if (!res.ok) throw new Error(`listRuleCatalogs failed (${res.status})`);
  const body = (await res.json()) as { catalogs: RuleCatalogSummary[] };
  return body.catalogs;
}

export async function getRuleCatalog(id: string): Promise<{
  summary: RuleCatalogSummary;
  manifest: unknown;
  rules: RuleEntry[];
}> {
  const res = await apiFetch(`/v1/rule-catalogs/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`getRuleCatalog failed (${res.status})`);
  const body = (await res.json()) as RuleCatalogSummary & {
    manifest: unknown;
  };
  const rules = extractRules(body.manifest);
  return {
    summary: {
      id: body.id,
      version: body.version,
      published_at: body.published_at,
      published_by: body.published_by,
      rule_count: body.rule_count,
    },
    manifest: body.manifest,
    rules,
  };
}

// Manifest shape varies a bit by milestone — newer publishes nest
// under `rules`, older ones under `rule_set.rules`. Try both rather
// than fail loudly on a shape we don't recognize.
function extractRules(manifest: unknown): RuleEntry[] {
  if (!manifest || typeof manifest !== 'object') return [];
  const m = manifest as Record<string, unknown>;
  const tryArray = (v: unknown): RuleEntry[] | null => {
    if (!Array.isArray(v)) return null;
    return v.filter(
      (e): e is RuleEntry =>
        !!e && typeof e === 'object' && typeof (e as RuleEntry).id === 'string',
    );
  };
  return (
    tryArray(m.rules) ??
    tryArray((m.rule_set as Record<string, unknown> | undefined)?.rules) ??
    []
  );
}
