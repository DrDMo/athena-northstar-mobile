/**
 * Pure crypto core of the capture vault (PII P0 Phase 3) — sealing and
 * opening byte payloads with ChaCha20-Poly1305. NO Expo imports, so it
 * runs under plain `node --test` like sha256.ts; all key storage and
 * filesystem I/O live in vault.ts.
 *
 * Sealed format (identical to the desktop agent's vault):
 *
 *   `NSV1 || nonce(12) || ciphertext+tag`
 *
 * Bytes without the `NSV1` marker are legacy plaintext and pass
 * through on open (dual-read). Opening a sealed payload with the wrong
 * key or a flipped bit THROWS (the AEAD tag fails) — it never returns
 * garbage.
 *
 * `@noble/ciphers` is pure JS (audited), so this ships in an OTA
 * update with NO native rebuild — the same reason sha256.ts is pure
 * JS. Nonces/keys come from `crypto.getRandomValues` (provided
 * globally by Expo SDK 56's Winter runtime and by Node) — NOT
 * Math.random.
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

/** 4-byte marker prefixing every sealed payload (North Star Vault v1). */
export const SEAL_MAGIC = new Uint8Array([0x4e, 0x53, 0x56, 0x31]); // "NSV1"

const NONCE_LEN = 12;
const HEADER_LEN = SEAL_MAGIC.length + NONCE_LEN;

/** Marker prefixing a sealed queue value in AsyncStorage. */
export const QUEUE_PREFIX = 'NSQ1:';

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * The CSPRNG behind key + nonce generation. Hermes/RN provides NO
 * global WebCrypto, so the app side (vault.ts) registers expo-crypto's
 * native `getRandomValues` at load; under Node (tests) the global
 * exists and is used directly. There is deliberately NO weak fallback
 * — better to fail loudly than seal with Math.random.
 */
let fillRandom: ((out: Uint8Array) => void) | null =
  typeof globalThis.crypto?.getRandomValues === 'function'
    ? // The cast bridges TS 5.7's `Uint8Array<ArrayBuffer>` generic in
      // Node's webcrypto typings — runtime-identical.
      (out) => globalThis.crypto.getRandomValues(out as Uint8Array<ArrayBuffer>)
    : null;

/** Register the platform CSPRNG (called once by vault.ts at load). */
export function setRandomSource(fill: (out: Uint8Array) => void): void {
  fillRandom = fill;
}

export function randomBytes(len: number): Uint8Array {
  if (!fillRandom) {
    throw new Error('vault: no CSPRNG registered (expo-crypto missing?)');
  }
  const out = new Uint8Array(len);
  fillRandom(out);
  return out;
}

/** Seal plaintext → `NSV1 || nonce || ciphertext+tag`. */
export function sealBytes(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_LEN);
  const ct = chacha20poly1305(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(HEADER_LEN + ct.length);
  out.set(SEAL_MAGIC, 0);
  out.set(nonce, SEAL_MAGIC.length);
  out.set(ct, HEADER_LEN);
  return out;
}

/** Whether stored bytes carry the sealed-vault marker. */
export function isSealed(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_LEN) return false;
  for (let i = 0; i < SEAL_MAGIC.length; i++) {
    if (bytes[i] !== SEAL_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Open sealed bytes back to plaintext. Dual-read: bytes without the
 * `NSV1` marker are legacy plaintext, returned as-is. Throws on a
 * wrong key or tampered payload.
 */
export function openBytes(key: Uint8Array, stored: Uint8Array): Uint8Array {
  if (!isSealed(stored)) return stored;
  const nonce = stored.slice(SEAL_MAGIC.length, HEADER_LEN);
  return chacha20poly1305(key, nonce).decrypt(stored.slice(HEADER_LEN));
}

/**
 * Seal the AsyncStorage capture-queue JSON (the metadata is PII even
 * without the media bytes: GPS fixes of the subject property, EXIF,
 * address-bearing captions, sketch geometry). Stored shape:
 * `NSQ1:<hex of sealed bytes>`.
 */
export function sealQueueString(key: Uint8Array, json: string): string {
  return QUEUE_PREFIX + bytesToHex(sealBytes(key, new TextEncoder().encode(json)));
}

/**
 * Open a stored queue value back to JSON. Values without the `NSQ1:`
 * prefix are legacy plaintext JSON and pass through (dual-read).
 * Throws on a wrong key or corrupted value.
 */
export function openQueueString(key: Uint8Array, stored: string): string {
  if (!stored.startsWith(QUEUE_PREFIX)) return stored;
  const plain = openBytes(key, hexToBytes(stored.slice(QUEUE_PREFIX.length)));
  return new TextDecoder().decode(plain);
}
