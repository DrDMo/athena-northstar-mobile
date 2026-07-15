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
import { loadQueue, pendingItems, updateItem } from './queue';

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
    const queue = await loadQueue();
    const pending = pendingItems(queue);

    for (const item of pending) {
      attempted++;
      try {
        await updateItem(item.id, { status: 'uploading' });
        await uploadOne(item);
        await updateItem(item.id, {
          status: 'synced',
          lastError: undefined,
        });
        succeeded++;
      } catch (e) {
        const msg = (e as Error).message ?? 'unknown error';
        await updateItem(item.id, { status: 'failed', lastError: msg });
        lastError = msg;
        failed++;
      }
    }
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

async function uploadOne(item: CaptureMeta): Promise<void> {
  // #516: upload via the native multipart uploader (expo-file-system),
  // NOT RN FormData. RN 0.85 is New-Architecture-only, and the New Arch
  // rejects FormData `{uri,...}` parts with "Unsupported FormDataPart
  // implementation", so the POST never left the device. See
  // api.ts::uploadCaptureFile.

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
