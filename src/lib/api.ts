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
  // #516: do NOT force application/json on FormData uploads — doing so
  // clobbers the multipart boundary fetch sets automatically, so the
  // capture upload (`POST /v1/captures`) arrives unparseable and never
  // syncs. Only default the JSON content-type for non-FormData bodies.
  const isFormData =
    typeof FormData !== 'undefined' && init.body instanceof FormData;
  if (!headers.has('content-type') && init.body && !isFormData) {
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
  /**
   * Pay-to-activate: `"pending"` until the assignment's $99 hosted-
   * Checkout payment clears, then `"paid"`. `GET /v1/cases`
   * (`case_files::list_for_tenant`) has no `payment_status` filter, so it
   * returns pending drafts alongside paid assignments — the client
   * decides how to surface them. Rows predating the column read as
   * `"paid"` (the server's serde default), so this is optional on the
   * wire. The mobile list badges `"pending"` rows rather than hiding
   * them, so a draft created on the phone (see {@link createAssignment})
   * is visible until the user pays for it on the web app.
   */
  payment_status?: string;

  /**
   * Domain-pack payload (the wire's `domain_extension`). Raw JSON; the
   * matching domain pack owns its shape. For the appraisal pack this
   * carries `property_address`, `report_type`, etc. Present on
   * `GET /v1/cases/{id}` (and the list); the appraisal web app reads
   * `domain_extension.property_address` to label an assignment.
   *
   * Typed loosely as a record because the client only ever merges into
   * it (see {@link setAssignmentProperty}) — it never interprets the
   * other keys, and must preserve any it doesn't recognize.
   */
  domain_extension?: Record<string, unknown> | null;
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

/**
 * Result of {@link setAssignmentProperty}: the refreshed assignment plus
 * whether the subject address actually landed in `domain_extension`.
 *
 * `persisted` is computed by re-reading the assignment after the PATCH
 * and checking that `domain_extension.property_address` now equals the
 * address we sent. See the note on {@link setAssignmentProperty} for why
 * this round-trip matters.
 */
export type SetPropertyResult = {
  assignment: AssignmentSummary;
  persisted: boolean;
};

/**
 * Set the subject **property address** on an assignment by merging it
 * into the assignment's `domain_extension`, then PATCHing the whole
 * object back.
 *
 * GET-merge-PATCH — never a blind PATCH. The backend's case-patch path
 * treats `domain_extension` as a whole-object field: it does not
 * deep-merge, so a PATCH carrying only `{ property_address }` would (if
 * accepted) REPLACE the extension wholesale and drop `report_type`,
 * `due_date`, and every other key the appraisal pack stored. So we:
 *
 *   1. GET the assignment to read its current `domain_extension`.
 *   2. Merge `{ ...current, property_address: address }` — preserving
 *      every existing key, overwriting only `property_address`.
 *   3. PATCH the full merged object.
 *
 * IMPORTANT — backend capability gap: the deployed `PATCH /v1/cases/{id}`
 * handler's request DTO (`CasePatchRequest`) has
 * `#[serde(deny_unknown_fields)]` and exposes ONLY a `name` field. So a
 * PATCH body carrying `domain_extension` is REJECTED outright with
 * `422 Unprocessable Entity` — it is not silently dropped. (A backend
 * change to add a `domain_extension` patch field is being made in
 * parallel; this client is already written to persist the instant that
 * lands.) `property_address` IS settable on the CREATE path
 * (`POST /v1/cases`) and IS returned by `GET /v1/cases/{id}` — only
 * PATCH-of-extension is missing today.
 *
 * Because the 422 is expected (not an error to surface), this function
 * is GRACEFUL: on a non-ok PATCH it returns `{ assignment: current,
 * persisted: false }` rather than throwing, so the caller can show the
 * calm "subject-property field isn't settable from the app yet" message
 * instead of a raw "(422)" error. The GET-merge-PATCH below is kept
 * correct-by-construction so it persists the moment the backend accepts
 * the field. Regardless of `persisted`, the address text_note written by
 * the address-capture screen remains the durable, audit-chained record.
 */
export async function setAssignmentProperty(
  assignmentId: string,
  address: string,
): Promise<SetPropertyResult> {
  // 1. Read current state so we merge, not clobber.
  const current = await getAssignment(assignmentId);
  const currentExt: Record<string, unknown> =
    current.domain_extension && typeof current.domain_extension === 'object'
      ? current.domain_extension
      : {};

  // 2. Merge — preserve every existing key; set only property_address.
  const merged: Record<string, unknown> = {
    ...currentExt,
    property_address: address,
  };

  // 3. PATCH the whole merged extension back.
  const res = await apiFetch(`/v1/cases/${encodeURIComponent(assignmentId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ domain_extension: merged }),
  });
  // The deployed handler rejects an unknown `domain_extension` field with
  // 422 (deny_unknown_fields; see the doc note). That's EXPECTED today —
  // don't throw. Report `persisted: false` against the current state so
  // the caller shows the calm "not settable from the app yet" message
  // rather than a raw error. We hand back `current` (already in hand) to
  // avoid a needless extra GET on the known-non-persisting path.
  if (!res.ok) {
    return { assignment: current, persisted: false };
  }

  // 4. Verify: re-read and confirm the address actually landed. Even a
  //    2xx here does NOT prove the write took (the handler could accept
  //    and ignore), so always verify against a fresh read.
  const refreshed = await getAssignment(assignmentId);
  const landed =
    refreshed.domain_extension &&
    typeof refreshed.domain_extension === 'object' &&
    (refreshed.domain_extension as Record<string, unknown>).property_address ===
      address;

  return { assignment: refreshed, persisted: Boolean(landed) };
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

/**
 * List the captures already filed to one assignment (= case on the
 * backend), newest first.
 *
 * Uses the dedicated `GET /v1/cases/{id}/captures` endpoint rather than
 * filtering {@link listCaptureInbox}: the inbox only returns *unfiled*
 * captures (`case_id IS NULL`), so a client-side filter for filed
 * captures would always come back empty. Mirrors the web app's
 * `listCapturesForCase`.
 */
export async function listAssignmentCaptures(
  assignmentId: string,
): Promise<CaptureSummary[]> {
  const res = await apiFetch(
    `/v1/cases/${encodeURIComponent(assignmentId)}/captures`,
  );
  if (!res.ok) {
    throw new Error(`listAssignmentCaptures failed (${res.status})`);
  }
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
