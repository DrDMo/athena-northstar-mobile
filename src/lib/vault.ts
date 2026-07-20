/**
 * At-rest encryption for captured PII (PII P0 Phase 3) — the device
 * side of the vault. Pure crypto lives in vault-crypto.ts (node-
 * testable); this module owns the key and the filesystem.
 *
 * Field captures — photos of the subject property (EXIF/GPS), voice
 * notes, sketches, address/MLS text notes — used to sit as plaintext
 * files in the OS cache dir until sync (and linger after). A lost or
 * stolen device gave up every capture. Now capture bytes are sealed
 * with ChaCha20-Poly1305 under a 256-bit data-encryption key (DEK)
 * held in the platform keychain/keystore via expo-secure-store — the
 * same posture as the session token (`session.ts`).
 *
 * Sealed files live under `Paths.document/vault/` (app-controlled,
 * survives cache reclaim — strictly better durability than the old
 * library-chosen cache paths). Plaintext exists on disk only (a) for
 * the instant between a capture library writing its temp file and
 * `sealCaptureFile` deleting it, and (b) as short-lived upload/preview
 * temps under `Paths.cache/vault-tmp/`, deleted after use and swept at
 * every app start.
 */

import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

import {
  bytesToHex,
  hexToBytes,
  isSealed,
  openBytes,
  openQueueString,
  randomBytes,
  sealBytes,
  sealQueueString,
  setRandomSource,
} from './vault-crypto';

export { isSealed } from './vault-crypto';

// Hermes has no global WebCrypto — expo-crypto's native getRandomValues
// is the CSPRNG for keys + nonces. Registered at module load so every
// seal path has it before first use.
setRandomSource((out) => Crypto.getRandomValues(out));

/** SecureStore key holding the hex-encoded 256-bit vault DEK. */
const DEK_KEY = 'northstar.vault-dek';

/** Suffix on sealed capture files: `<name>.<origExt>.nsv`. */
export const SEALED_EXT = '.nsv';

// -- DEK management ---------------------------------------------------------

let keyPromise: Promise<Uint8Array> | null = null;

/**
 * Load the vault DEK from SecureStore, generating + persisting a fresh
 * 256-bit key on first use. The in-flight PROMISE is cached (not just
 * the resolved key) so two concurrent first-ever calls can never both
 * generate a key and silently orphan whichever `set` loses — data
 * sealed under a lost key is undecryptable forever. A failed load
 * clears the cache so a transient SecureStore error can retry.
 */
export function getVaultKey(): Promise<Uint8Array> {
  keyPromise ??= (async () => {
    const existing = await SecureStore.getItemAsync(DEK_KEY);
    if (existing) return hexToBytes(existing);
    const fresh = randomBytes(32);
    await SecureStore.setItemAsync(DEK_KEY, bytesToHex(fresh), {
      // Same posture as the session token: this-device-only, available
      // once unlocked (captures happen with the phone in hand).
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return fresh;
  })().catch((e: unknown) => {
    keyPromise = null;
    throw e;
  });
  return keyPromise;
}

// -- directories ------------------------------------------------------------

/** App-controlled home of sealed capture files. */
function vaultDir(): Directory {
  return new Directory(Paths.document, 'vault');
}

/** Short-lived plaintext temps (upload/preview); swept at startup. */
function tmpDir(): Directory {
  return new Directory(Paths.cache, 'vault-tmp');
}

function ensureDir(dir: Directory): void {
  dir.create({ intermediates: true, idempotent: true });
}

/** Basename of a file:// URI, query/fragment stripped. */
function uriBasename(uri: string): string {
  const path = uri.split(/[?#]/)[0];
  return path.slice(path.lastIndexOf('/') + 1);
}

// -- file-level API ---------------------------------------------------------

/** Seal `plain` under `<vault>/<name>.nsv` and return the URI. */
function writeSealed(key: Uint8Array, name: string, plain: Uint8Array): string {
  const sealed = sealBytes(key, plain);
  ensureDir(vaultDir());
  const dst = new File(vaultDir(), `${name}${SEALED_EXT}`);
  if (!dst.exists) dst.create();
  dst.write(sealed);
  return dst.uri;
}

/**
 * Write a short-lived plaintext temp. Each temp gets its OWN random
 * subdir under `vault-tmp/` so two consumers of the same capture (an
 * upload racing a preview) can never share a path — a dispose from one
 * must not delete the file under the other. The basename is preserved
 * so upload filenames + extension-derived content-types stay truthful.
 */
function writePlainTemp(
  name: string,
  plain: Uint8Array,
): { uri: string; dispose: () => void } {
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const dir = new Directory(tmpDir(), token);
  ensureDir(dir);
  const tmp = new File(dir, name);
  if (!tmp.exists) tmp.create();
  tmp.write(plain);
  return {
    uri: tmp.uri,
    dispose: () => {
      try {
        tmp.delete();
        dir.delete();
      } catch {
        // swallowed — swept at next app start
      }
    },
  };
}

/**
 * Seal a freshly captured file into the vault and DELETE the plaintext
 * original the capture library wrote. Returns the sealed file's URI —
 * what belongs in `CaptureMeta.localUri`. The sealed name keeps the
 * original extension (`cap_x.jpg` → `cap_x.jpg.nsv`) so the upload
 * layer can recover the true content-type.
 */
export async function sealCaptureFile(plainUri: string): Promise<string> {
  return (await sealCaptureFileInner(plainUri, false)).uri;
}

/**
 * Like {@link sealCaptureFile}, but ALSO writes a session-scoped
 * plaintext preview temp from the bytes already in hand — for the
 * photo screen's thumb strip — instead of the caller paying a full
 * decrypt right after the encrypt.
 */
export async function sealCaptureFileWithPreview(plainUri: string): Promise<{
  uri: string;
  previewUri: string;
  disposePreview: () => void;
}> {
  const out = await sealCaptureFileInner(plainUri, true);
  return {
    uri: out.uri,
    previewUri: out.preview!.uri,
    disposePreview: out.preview!.dispose,
  };
}

async function sealCaptureFileInner(
  plainUri: string,
  withPreview: boolean,
): Promise<{ uri: string; preview?: { uri: string; dispose: () => void } }> {
  const key = await getVaultKey();
  const src = new File(plainUri);
  const plain = await src.bytes();
  const name = uriBasename(plainUri);
  const uri = writeSealed(key, name, plain);
  // Best-effort: losing the delete leaves a plaintext temp for the
  // startup sweep; it must not fail the capture itself.
  try {
    src.delete();
  } catch {
    // swallowed — swept at next app start
  }
  return withPreview ? { uri, preview: writePlainTemp(name, plain) } : { uri };
}

/**
 * Seal a text body (text notes / MLS / address captures) straight into
 * the vault — the plaintext never touches disk at all. Returns the
 * sealed file's URI.
 */
export async function sealTextToVault(
  filename: string,
  body: string,
): Promise<string> {
  const key = await getVaultKey();
  return writeSealed(key, filename, new TextEncoder().encode(body));
}

/**
 * Materialize a capture as a short-lived plaintext temp file for
 * consumers that need a real `file://` URI (the native multipart
 * uploader, the in-session `<Image>` preview). Call `dispose()` as
 * soon as the consumer is done; the startup sweep catches anything a
 * crash leaves behind.
 *
 * Legacy plaintext files are returned as-is with a no-op dispose.
 */
export async function openCaptureAsTempFile(
  uri: string,
): Promise<{ uri: string; dispose: () => void }> {
  const stored = await new File(uri).bytes();
  if (!isSealed(stored)) {
    return { uri, dispose: () => {} };
  }
  const key = await getVaultKey();
  const plain = openBytes(key, stored);
  let name = uriBasename(uri);
  if (name.endsWith(SEALED_EXT)) name = name.slice(0, -SEALED_EXT.length);
  return writePlainTemp(name, plain);
}

/**
 * Best-effort delete of a capture's sealed vault file when its queue
 * row is dropped (retention cap / supersede). Sealed files live in the
 * document directory, which the OS never reclaims — without this they
 * would accumulate forever. Never throws.
 */
export function deleteVaultFile(uri: string): void {
  try {
    new File(uri).delete();
  } catch {
    // already gone, or a legacy cache path the OS owns — fine either way
  }
}

// -- queue blob (AsyncStorage) ----------------------------------------------

/** Seal the capture-queue JSON for AsyncStorage. */
export async function encryptQueueBlob(json: string): Promise<string> {
  return sealQueueString(await getVaultKey(), json);
}

/**
 * Open a stored queue value back to JSON — legacy plaintext passes
 * through. Throws on a wrong key or corrupted value (the caller treats
 * that as an empty queue rather than parsing garbage).
 */
export async function decryptQueueBlob(stored: string): Promise<string> {
  return openQueueString(await getVaultKey(), stored);
}

// -- startup sweep ----------------------------------------------------------

let sweptThisLaunch = false;

/**
 * Delete plaintext temps under `vault-tmp/` that a crash mid-upload /
 * mid-preview left behind. Runs at most once per launch (so a re-run
 * can never race an in-flight upload's temp); best-effort throughout.
 */
export function sweepPlaintextTemps(): void {
  if (sweptThisLaunch) return;
  sweptThisLaunch = true;
  try {
    const dir = tmpDir();
    if (!dir.exists) return;
    for (const entry of dir.list()) {
      try {
        entry.delete();
      } catch {
        // one stuck temp must not stop the sweep
      }
    }
  } catch {
    // sweep is best-effort by design
  }
}

/**
 * What the startup migration (vault-migrate.ts) needs to know about a
 * queue row's file: gone, already sealed, or legacy plaintext.
 */
export async function classifyCaptureFile(
  uri: string,
): Promise<'missing' | 'sealed' | 'plaintext'> {
  const f = new File(uri);
  if (!f.exists) return 'missing';
  return isSealed(await f.bytes()) ? 'sealed' : 'plaintext';
}

/**
 * Crash recovery for the startup migration: the sealed vault file a
 * given plaintext URI WOULD have been sealed to, if it exists. A crash
 * between `sealCaptureFile` (original deleted) and the queue re-save
 * leaves the row pointing at the deleted original; this finds the
 * orphaned sealed copy so the row can be repointed instead of failing
 * every upload forever.
 */
export function findExistingSealedUri(plainUri: string): string | null {
  const f = new File(vaultDir(), `${uriBasename(plainUri)}${SEALED_EXT}`);
  return f.exists ? f.uri : null;
}
