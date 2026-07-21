/**
 * Capture queue persistence — keeps in-flight captures durable across
 * app cold-starts. Built on AsyncStorage rather than SQLite because:
 *
 *   - A single appraiser's daily working set is at most low-hundreds
 *     of items; AsyncStorage handles that fine.
 *   - SQLite would require a native rebuild, which complicates the
 *     Expo Go dev loop. Sticking to JS-only storage for v0.1.
 *
 * If we hit AsyncStorage's quota (~6 MB on Android), the binary
 * payloads aren't the problem — those live on the FS — but the
 * metadata-list itself. We'll switch to expo-sqlite when we see
 * the first user crowd it.
 *
 * Concurrency model: all reads/writes go through this module so the
 * load → mutate → save round-trip is serialized by JS's single
 * thread. There's still a race if two screens fire mutations at the
 * exact same tick; for the v0.1 single-screen capture flow that's
 * not yet a concern. When sync runs in the background we'll switch
 * to an in-memory cache with a debounced flush.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { CaptureMeta } from './capture';
import { hasStrandedRows, reclaimStrandedRows } from './queue-logic';
import { decryptQueueBlob, deleteVaultFile, encryptQueueBlob } from './vault';

const KEY = 'northstar.queue.v1';

export async function loadQueue(): Promise<CaptureMeta[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  try {
    // PII P0 Phase 3: the stored value is sealed (the metadata carries
    // GPS fixes, EXIF, address captions, and sketch geometry). Legacy
    // plaintext JSON passes through unchanged (dual-read).
    const json = await decryptQueueBlob(raw);
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    // Light shape-check — anything missing required fields is dropped
    // rather than crashing the app.
    return parsed.filter(
      (it): it is CaptureMeta =>
        it &&
        typeof it.id === 'string' &&
        typeof it.localUri === 'string' &&
        typeof it.capturedAt === 'string' &&
        typeof it.status === 'string',
    );
  } catch {
    // Undecryptable or corrupted queue value (lost DEK, tampering,
    // malformed legacy JSON). Keep a recovery copy for support BEFORE
    // the next save overwrites it — this is un-uploaded field evidence.
    try {
      await AsyncStorage.setItem(`${KEY}.recovery`, raw);
    } catch {
      // best-effort only
    }
    return [];
  }
}

export async function saveQueue(items: CaptureMeta[]): Promise<void> {
  // Always sealed on write; loadQueue dual-reads pre-encryption values.
  await AsyncStorage.setItem(KEY, await encryptQueueBlob(JSON.stringify(items)));
}

export async function enqueue(item: CaptureMeta): Promise<CaptureMeta[]> {
  const current = await loadQueue();
  // Prepend so the most recent capture sits at index 0 — matches the
  // photo-capture screen's FlatList order.
  const next = [item, ...current];
  await saveQueue(next);
  return next;
}

export async function updateItem(
  id: string,
  patch: Partial<CaptureMeta>,
): Promise<CaptureMeta[]> {
  const current = await loadQueue();
  const next = current.map((it) => (it.id === id ? { ...it, ...patch } : it));
  await saveQueue(next);
  return next;
}

export async function removeItem(id: string): Promise<CaptureMeta[]> {
  const current = await loadQueue();
  const next = current.filter((it) => it.id !== id);
  // Sealed vault files live in the document dir (never OS-reclaimed) —
  // delete the dropped row's file so superseded captures don't
  // accumulate forever. Best-effort; legacy cache paths tolerate it.
  for (const it of current) {
    if (it.id === id) deleteVaultFile(it.localUri);
  }
  await saveQueue(next);
  return next;
}

export async function clearQueue(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}

/**
 * Self-heal any rows stranded in the 'uploading' state (see
 * {@link reclaimStrandedRows}) by reverting them to 'pending' so the
 * sync worker retries them. A cheap no-op — and no write — when there
 * are none. Called at the start of every sync pass so a crash
 * mid-upload never permanently strands a capture.
 */
export async function reclaimStranded(): Promise<CaptureMeta[]> {
  const current = await loadQueue();
  if (!hasStrandedRows(current)) return current;
  const next = reclaimStrandedRows(current);
  await saveQueue(next);
  return next;
}

/**
 * Filter helper used by the sync worker to find items that should be
 * uploaded on this pass. Excludes anything currently in flight
 * ('uploading') or already done ('synced').
 */
export function pendingItems(items: CaptureMeta[]): CaptureMeta[] {
  return items.filter((it) => it.status === 'pending' || it.status === 'failed');
}
