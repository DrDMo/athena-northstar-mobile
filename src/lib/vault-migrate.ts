/**
 * One-shot startup migration for the capture vault (PII P0 Phase 3).
 *
 * Own module (not vault.ts) purely to keep the import graph acyclic:
 * queue.ts → vault.ts for the sealed queue blob, and this needs
 * queue.ts — so it sits above both.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { loadQueue, saveQueue } from './queue';
import {
  classifyCaptureFile,
  findExistingSealedUri,
  sealCaptureFile,
  sweepPlaintextTemps,
} from './vault';

/** AsyncStorage flag: the one-shot legacy re-seal sweep has completed. */
const MIGRATED_FLAG = 'northstar.vault.migrated.v1';

/**
 * Startup hygiene + one-shot migration. Await this BEFORE the first
 * `syncNow()` so an upload never races the re-seal:
 *
 * 1. Every launch: sweep crash-leftover plaintext temps (vault.ts).
 * 2. Once ever (flag-gated): re-seal legacy plaintext capture files
 *    referenced by the queue and rewrite their `localUri`s, then
 *    re-save the queue — which also seals the queue blob itself. A row
 *    whose file vanished but whose SEALED copy exists (crash between a
 *    prior run's re-seal and its queue save) is repointed at the
 *    sealed copy instead of failing every upload forever.
 *
 * Best-effort throughout: a single unreadable file stays legacy (the
 * dual-read upload path still handles it); a failure retries next
 * launch. Never blocks startup on an error.
 */
export async function migrateVaultAtStartup(): Promise<void> {
  sweepPlaintextTemps();
  try {
    if (await AsyncStorage.getItem(MIGRATED_FLAG)) return;
    const snapshot = await loadQueue();
    // Only localUri rewrites, keyed by row id — merged below against a
    // FRESH load so a capture enqueued while this loop ran (re-sealing
    // a big backlog takes real time) is never clobbered by our stale
    // snapshot.
    const rewrites = new Map<string, string>();
    for (const item of snapshot) {
      try {
        const kind = await classifyCaptureFile(item.localUri);
        if (kind === 'sealed') continue;
        if (kind === 'missing') {
          const sealed = findExistingSealedUri(item.localUri);
          if (sealed) rewrites.set(item.id, sealed);
          continue;
        }
        rewrites.set(item.id, await sealCaptureFile(item.localUri));
      } catch {
        // this file stays legacy-plaintext; dual-read still uploads it
      }
    }
    const current = await loadQueue();
    const merged = current.map((it) => {
      const uri = rewrites.get(it.id);
      return uri ? { ...it, localUri: uri } : it;
    });
    // Re-save even when nothing changed: this seals the queue blob
    // itself (the pre-encryption value was plaintext JSON).
    await saveQueue(merged);
    await AsyncStorage.setItem(MIGRATED_FLAG, '1');
  } catch {
    // Migration retries next launch; captures still dual-read fine.
  }
}
