/**
 * Capture sync worker — uploads pending captures to the backend when
 * the device has signal. Designed to be called from anywhere
 * (foreground tick, network-reconnect event, manual "Sync now" tap)
 * and be safe to invoke repeatedly: a second call while a sync is in
 * flight is a no-op.
 *
 * Upload protocol (mirrors the web app):
 *
 *   POST /v1/captures              multipart/form-data
 *     file               <binary>
 *     meta               <json>     id + capturedAt + geo + exif + caption
 *     assignment_id      <uuid?>    if the appraiser tagged a workfile
 *     workfile_id        <uuid?>
 *
 * Server returns the persisted capture record + canonical hash. The
 * record's `status` flips to 'synced' and we delete the local binary
 * on next-tick to free disk.
 *
 * Retry policy: simple linear — failed items stay in the queue with
 * status='failed' and lastError set; the next sync pass retries them.
 * Exponential backoff would help on flaky links but adds complexity
 * the v0.1 doesn't need; the appraiser controls "Sync now" manually.
 */

import NetInfo from '@react-native-community/netinfo';

import { uploadCaptureFile } from './api';
import type { CaptureMeta } from './capture';
import { hashFileHex } from './hash-file';
import { loadQueue, pendingItems, reclaimStranded, saveQueue, updateItem } from './queue';
import { capSyncedRows } from './queue-logic';
import { hashesMatch } from './sha256';

let inFlight = false;

export type SyncResult = {
  attempted: number;
  succeeded: number;
  failed: number;
};

/**
 * #516 diagnostic: the outcome of the last `syncNow` run, so the Capture
 * hub can show it on-screen (we can't read device logs remotely). Lets us
 * see whether uploads are firing and surface the real error if they fail.
 */
export type SyncStatus = SyncResult & {
  lastError?: string;
  ranAt?: string;
};
let lastStatus: SyncStatus = { attempted: 0, succeeded: 0, failed: 0 };
export function getLastSyncStatus(): SyncStatus {
  return lastStatus;
}

/**
 * Try to upload every pending item. Skips only if already running.
 * Returns counts for UI display.
 */
export async function syncNow(): Promise<SyncResult> {
  if (inFlight) return { attempted: 0, succeeded: 0, failed: 0 };
  inFlight = true;

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let lastError: string | undefined;

  try {
    // #516: do NOT pre-gate on NetInfo. On Android it can report
    // isInternetReachable=false / isConnected=false even when the app
    // plainly has connectivity (reads succeed), which silently skipped
    // every upload. Just attempt — the per-item catch handles a genuine
    // offline failure and leaves the item queued for the next retry.
    // Self-heal any rows stranded 'uploading' by a previous crashed
    // pass BEFORE computing what's pending — pendingItems() excludes
    // 'uploading', so without this a killed-mid-upload capture would
    // never be retried and would vanish from the on-screen counts.
    // syncNow is single-flight (the inFlight guard above), so any
    // 'uploading' row seen here can only be a leftover, never live.
    await reclaimStranded();
    const queue = await loadQueue();
    const pending = pendingItems(queue);

    for (const item of pending) {
      attempted++;
      try {
        // Remember exactly which bytes this pass uploads so a mid-pass
        // content change is detectable below.
        const uploadedUri = item.localUri;
        await updateItem(item.id, { status: 'uploading' });
        const { serverId, contentHash } = await uploadOne(item);
        // Race guard: a save can flip this row back to 'pending' with
        // FRESH content while the upload was in flight — unconditionally
        // stamping 'synced' here would silently mark those unsaved bytes
        // as uploaded. Re-read the row and only mark it synced when it
        // still holds the exact bytes this pass uploaded; otherwise
        // leave it pending for the next pass. A row that vanished
        // mid-pass (superseded by a newer revision and removed) is left
        // alone entirely.
        const fresh = (await loadQueue()).find((it) => it.id === item.id);
        if (fresh && fresh.localUri === uploadedUri) {
          await updateItem(item.id, {
            status: 'synced',
            lastError: undefined,
            contentHash,
            ...(serverId ? { serverId } : {}),
          });
        } else if (fresh) {
          // Content changed under us — requeue; the next pass uploads
          // the new bytes. (Do NOT record serverId: it identifies the
          // OLD revision's server row, and pairing it with new local
          // bytes would misdirect a later supersede-delete.)
          await updateItem(item.id, { status: 'pending' });
        }
        succeeded++;
      } catch (e) {
        const msg = (e as Error).message ?? 'unknown error';
        await updateItem(item.id, { status: 'failed', lastError: msg });
        lastError = msg;
        failed++;
      }
    }

    // Bound the durable metadata list so a long-lived install doesn't
    // grow it until saveQueue() throws and NEW captures silently fail
    // to persist. Only 'synced' rows past the retention window are
    // dropped; unsynced work (pending/uploading/failed) is always kept.
    const settled = await loadQueue();
    const capped = capSyncedRows(settled);
    if (capped.length !== settled.length) await saveQueue(capped);
  } finally {
    inFlight = false;
  }

  lastStatus = {
    attempted,
    succeeded,
    failed,
    lastError,
    ranAt: new Date().toISOString(),
  };
  return { attempted, succeeded, failed };
}

/**
 * Map a lowercase file extension to its upload content-type. Voice
 * notes (.m4a) MUST NOT be sent as image/jpeg — the server keys audio
 * handling, transcription, and hash provenance off the declared type.
 */
function contentTypeForExt(ext: string): string | undefined {
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'm4a':
      return 'audio/m4a';
    case 'mp4':
      return 'audio/mp4';
    case 'wav':
      return 'audio/wav';
    case 'caf':
      return 'audio/x-caf';
    case 'txt':
      // text_note captures: the body is written to a temp .txt the
      // sync layer uploads as the `file` part (the backend requires a
      // non-empty file — it has no meta-only path). Declaring
      // text/plain keeps the persisted content-type truthful.
      return 'text/plain; charset=utf-8';
    default:
      return undefined;
  }
}

/**
 * Derive the upload filename extension + content-type from the actual
 * recording the camera/recorder wrote. Prefer the real extension on
 * `localUri`; fall back to a sensible default by capture `kind` so a
 * URI without an extension still uploads with a truthful type.
 */
function uploadPartFor(item: CaptureMeta): { ext: string; type: string } {
  // Strip any query/fragment, then read the trailing extension.
  const path = item.localUri.split(/[?#]/)[0];
  const dot = path.lastIndexOf('.');
  const rawExt =
    dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  const fromExt = rawExt ? contentTypeForExt(rawExt) : undefined;
  if (fromExt) return { ext: rawExt, type: fromExt };

  // No usable extension on the URI — fall back by kind.
  if (item.kind === 'voice_note') return { ext: 'm4a', type: 'audio/m4a' };
  if (item.kind === 'text_note') return { ext: 'txt', type: 'text/plain; charset=utf-8' };
  // Sketches are exported as PNG by react-native-view-shot (captureRef
  // `format: 'png'`). The tmpfile URI usually carries a `.png` extension
  // and is handled above; this keeps the type truthful if it doesn't.
  if (item.kind === 'sketch') return { ext: 'png', type: 'image/png' };
  return { ext: 'jpg', type: 'image/jpeg' };
}

/**
 * Upload one capture. On success returns the SERVER capture id (a UUID, when
 * the response body parses — the backend answers both 201-created and
 * 200-idempotent-replay with the persisted capture record; used later to
 * supersede-delete a stale server copy) together with `contentHash`, the
 * on-device SHA-256 of the exact uploaded bytes.
 *
 * Integrity: the backend recomputes SHA-256 over the bytes it received and
 * returns it as `sha256_hex`. This reconciles that against `contentHash`; a
 * mismatch means the sealed record does NOT cover the captured bytes (a
 * truncated/corrupted upload) and THROWS so the caller marks the item failed
 * rather than silently recording it as synced.
 */
async function uploadOne(
  item: CaptureMeta,
): Promise<{ serverId?: string; contentHash: string }> {
  // #516: upload via the native multipart uploader (expo-file-system),
  // NOT RN FormData. RN 0.85 is New-Architecture-only, and the New Arch
  // rejects FormData `{uri,...}` parts with "Unsupported FormDataPart
  // implementation", so the POST never left the device. See
  // api.ts::uploadCaptureFile.

  // Witness the exact bytes on-device BEFORE the upload — the same file the
  // multipart uploader sends, so this hash equals what the server seals.
  const contentHash = await hashFileHex(item.localUri);

  // Derive the content-type from the real recording so voice notes upload
  // as audio, not a mislabeled JPEG. (The filename is the URI basename;
  // the server derives type from meta.kind, so only the mime matters here.)
  const { type } = uploadPartFor(item);

  const parameters: Record<string, string> = {
    // The backend requires a `meta` JSON field — client_id drives upload
    // idempotency and kind must be a known capture kind.
    meta: JSON.stringify({
      client_id: item.id,
      captured_at: item.capturedAt,
      kind: item.kind,
      geo: item.geo,
      exif: item.exif,
      caption: item.caption,
      // #655 additive: sketch-only settings + geo-reference. `undefined`
      // for every non-sketch capture (and for sketches saved before this
      // shipped), so JSON.stringify DROPS the key — the wire shape stays
      // byte-identical to before for photos/voice/text. New optional key
      // only; nothing existing changed.
      sketch: item.sketch && {
        grid_size: item.sketch.gridSize,
        scale_feet_per_square: item.sketch.scaleFeetPerSquare,
        snap_enabled: item.sketch.snapEnabled,
        gps: item.sketch.gps && {
          lat: item.sketch.gps.lat,
          lng: item.sketch.gps.lng,
          accuracy_m: item.sketch.gps.accuracyMeters,
          captured_at: item.sketch.gps.capturedAt,
        },
        heading_deg: item.sketch.headingDeg,
        // #666 additive: the editable vector floor-plan doc. `undefined`
        // for raster-only / older sketches, so JSON.stringify DROPS the
        // key and the wire stays byte-identical for those. Vertices +
        // labels are already plain {x,y}/{x,y,text}; only pxPerFoot is
        // snake-cased to match the rest of the sketch payload.
        vector: item.sketch.vector && {
          version: item.sketch.vector.version,
          px_per_foot: item.sketch.vector.pxPerFoot,
          vertices: item.sketch.vector.vertices,
          labels: item.sketch.vector.labels,
          closed: item.sketch.vector.closed,
        },
      },
    }),
  };
  if (item.assignmentId) parameters.assignment_id = item.assignmentId;
  if (item.workfileId) parameters.workfile_id = item.workfileId;

  const res = await uploadCaptureFile(item.localUri, type, parameters);

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = JSON.parse(res.body) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // body wasn't JSON — keep the HTTP status as the error
    }
    throw new Error(detail);
  }

  let serverId: string | undefined;
  let serverHash: string | undefined;
  try {
    const body = JSON.parse(res.body) as { id?: string; sha256_hex?: string };
    if (typeof body?.id === 'string' && body.id.length > 0) serverId = body.id;
    if (typeof body?.sha256_hex === 'string') serverHash = body.sha256_hex;
  } catch {
    // Body wasn't the expected record — no server id / hash to read.
  }

  // Reconcile OUTSIDE the JSON try so a genuine integrity mismatch is never
  // swallowed by the parse catch. Only enforce when the server actually
  // returned a hash (older backends may not), so this can't break uploads
  // against a server that predates the field.
  if (serverHash && !hashesMatch(contentHash, serverHash)) {
    throw new Error(
      `integrity mismatch: on-device ${contentHash.slice(0, 12)}… != sealed ${serverHash.slice(0, 12)}…`,
    );
  }

  return { serverId, contentHash };
}

/**
 * Register a one-time listener that auto-syncs when the device
 * transitions from offline → online. Returns an unsubscribe fn.
 *
 * Call once from the root layout so the field workflow "just works"
 * when the appraiser walks out of a basement and signal returns.
 */
export function startAutoSyncOnReconnect(): () => void {
  let lastReachable: boolean | null = null;
  return NetInfo.addEventListener((state) => {
    const reachable = state.isConnected && state.isInternetReachable !== false;
    // Only fire on the offline → online edge, not every state change.
    if (reachable && lastReachable === false) {
      // Fire-and-forget; syncNow guards against re-entry.
      void syncNow();
    }
    lastReachable = reachable;
  });
}
