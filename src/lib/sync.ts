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

import { apiFetch } from './api';
import type { CaptureMeta } from './capture';
import { loadQueue, pendingItems, updateItem } from './queue';

let inFlight = false;

export type SyncResult = {
  attempted: number;
  succeeded: number;
  failed: number;
};

/**
 * Try to upload every pending item. Skips work if already running or
 * if the device reports no internet. Returns counts for UI display.
 */
export async function syncNow(): Promise<SyncResult> {
  if (inFlight) return { attempted: 0, succeeded: 0, failed: 0 };
  inFlight = true;

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  try {
    const net = await NetInfo.fetch();
    if (!net.isConnected || net.isInternetReachable === false) {
      return { attempted: 0, succeeded: 0, failed: 0 };
    }

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
        failed++;
      }
    }
  } finally {
    inFlight = false;
  }

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
  return { ext: 'jpg', type: 'image/jpeg' };
}

async function uploadOne(item: CaptureMeta): Promise<void> {
  // React Native FormData supports the {uri, name, type} blob shape
  // for file uploads, which is what expo-camera writes. No need to
  // read the file into JS first.
  const form = new FormData();

  // Derive the filename + content-type from the real recording so
  // voice notes upload as audio, not a mislabeled JPEG.
  const { ext, type } = uploadPartFor(item);

  // The cast is required because RN's FormData typings don't match
  // the W3C spec; the runtime accepts {uri,name,type}.
  form.append(
    'file',
    {
      uri: item.localUri,
      name: `${item.id}.${ext}`,
      type,
    } as unknown as Blob,
  );

  form.append(
    'meta',
    JSON.stringify({
      client_id: item.id,
      captured_at: item.capturedAt,
      kind: item.kind,
      geo: item.geo,
      exif: item.exif,
      caption: item.caption,
    }),
  );

  if (item.assignmentId) form.append('assignment_id', item.assignmentId);
  if (item.workfileId) form.append('workfile_id', item.workfileId);

  const res = await apiFetch('/v1/captures', {
    method: 'POST',
    body: form,
    // DON'T set content-type; the platform fetch adds the multipart
    // boundary automatically. Forcing it here drops the boundary and
    // the server fails to parse.
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
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
