/**
 * Pure, framework-free queue transforms — NO AsyncStorage, NO React
 * Native imports — so they run under `node --test` (mirroring
 * `sketch-model.ts`) and are trivially unit-testable. `queue.ts` wraps
 * these with the AsyncStorage load/save round-trip; `sync.ts` applies
 * the retention cap after a sync pass.
 *
 * The only import is `import type { CaptureMeta }`, which the runtime
 * erases — so importing this file never pulls in `capture.ts`'s native
 * (expo-file-system / expo-location) dependencies.
 */

import type { CaptureMeta } from './capture';

/**
 * Retention cap on 'synced' rows kept in the on-device queue.
 *
 * The queue's durable metadata list lives in AsyncStorage (~6 MB quota
 * on Android). 'synced' rows are never re-uploaded, but before this cap
 * they accumulated forever, so a long-lived install would eventually
 * make `saveQueue()` throw — at which point NEW captures silently failed
 * to persist. We keep the most-recent N synced rows (enough to preserve
 * the recent supersede-delete window, which relies on `serverId`) and
 * drop older ones. Dropping a synced row is safe: the bytes are on the
 * server, and the only thing lost is the best-effort delete of a
 * superseded server copy — which the capture model already documents as
 * harmless ("an old revision lingers server-side, harmlessly").
 */
export const MAX_SYNCED_RETAINED = 200;

/**
 * Revert rows stranded in the transient 'uploading' state back to
 * 'pending'. A row is 'uploading' only for the brief window of a single
 * in-flight POST inside `syncNow`; if the app is killed or crashes
 * mid-upload it is left 'uploading' forever, and because
 * `pendingItems()` excludes 'uploading' the sync worker never retries it
 * and the on-screen counts never see it — the capture is silently
 * stranded. Re-upload is safe: the backend is idempotent on
 * `meta.client_id`, so replaying a capture that already reached the
 * server returns the same record rather than duplicating it.
 */
export function reclaimStrandedRows(items: CaptureMeta[]): CaptureMeta[] {
  return items.map((it): CaptureMeta =>
    it.status === 'uploading' ? { ...it, status: 'pending' } : it,
  );
}

/** True if any row is stranded 'uploading' (lets callers skip a write). */
export function hasStrandedRows(items: CaptureMeta[]): boolean {
  return items.some((it) => it.status === 'uploading');
}

/**
 * Bound the queue's 'synced' rows to the most recent `cap`
 * ({@link MAX_SYNCED_RETAINED} by default). Input is newest-first
 * (`enqueue` prepends), so the first `cap` synced rows encountered are
 * the most recent — kept — and older synced rows are dropped. Unsynced
 * work (pending / uploading / failed) is ALWAYS kept, regardless of the
 * cap, so this can never discard un-uploaded evidence.
 */
export function capSyncedRows(
  items: CaptureMeta[],
  cap: number = MAX_SYNCED_RETAINED,
): CaptureMeta[] {
  let keptSynced = 0;
  const out: CaptureMeta[] = [];
  for (const it of items) {
    if (it.status === 'synced') {
      if (keptSynced >= cap) continue;
      keptSynced++;
    }
    out.push(it);
  }
  return out;
}
