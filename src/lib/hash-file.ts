import { File } from 'expo-file-system';

import { sha256Hex } from './sha256';

/**
 * Compute the lowercase-hex SHA-256 of a local file's EXACT bytes — the same
 * bytes the native multipart uploader (`api.ts::uploadCaptureFile`) sends — so
 * the result matches the backend's sealed `sha256_hex`
 * (`hex::encode(Sha256::digest(received_bytes))`) and can be reconciled
 * against it after upload.
 *
 * Reads the whole file into memory via the SDK 56 File/Blob `arrayBuffer()`.
 * Field captures (photos, voice notes, sketches, short text) are small and
 * this runs off the capture hot path inside the sync worker, so a full read is
 * fine. If large media ever makes this a concern, swap `sha256Hex` for a
 * streaming/native digest — the reconciliation contract is unchanged.
 */
export async function hashFileHex(uri: string): Promise<string> {
  const buffer = await new File(uri).arrayBuffer();
  return sha256Hex(new Uint8Array(buffer));
}
