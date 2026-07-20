/**
 * Unit tests for the pure-JS SHA-256 (on-device capture integrity hash).
 *
 * Framework: Node's built-in test runner (`node:test` + `node:assert`), same
 * as sketch-model.test.mts — sha256.ts is framework-free and RN-free, so it
 * runs under plain Node with zero shims.
 *
 * These pin correctness against the standard NIST / RFC test vectors, which is
 * what makes the client hash trustworthy: if these pass, the app's lowercase
 * hex equals the backend's `hex::encode(Sha256::digest(bytes))`, so an
 * on-device hash reconciled against the server's `sha256_hex` is a real
 * integrity check (detects a truncated/corrupted upload) rather than a
 * feel-good badge.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashesMatch, sha256Hex, sha256HexUtf8 } from './sha256.ts';

test('NIST vector: empty input', () => {
  assert.equal(
    sha256Hex(new Uint8Array(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('NIST vector: "abc"', () => {
  assert.equal(
    sha256HexUtf8('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('NIST vector: 56-byte two-block message (padding boundary)', () => {
  assert.equal(
    sha256HexUtf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('vector: the quick brown fox', () => {
  assert.equal(
    sha256HexUtf8('The quick brown fox jumps over the lazy dog'),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
  );
});

test('binary bytes hash correctly (0x00..0xff)', () => {
  // 256 sequential bytes — exercises multi-block + full byte range, not just
  // ASCII. Value cross-checked against a reference SHA-256 implementation.
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  assert.equal(
    sha256Hex(bytes),
    '40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880',
  );
});

test('hashesMatch: case-insensitive on a full 64-hex digest, rejects junk', () => {
  const h = sha256HexUtf8('abc');
  assert.equal(hashesMatch(h, h.toUpperCase()), true, 'case-insensitive');
  assert.equal(hashesMatch(h, 'deadbeef'), false, 'wrong length is not a match');
  assert.equal(hashesMatch('', h), false, 'empty local is not a match');
  assert.equal(hashesMatch(h, `${h.slice(0, 63)}f`), false, 'one nibble off');
});
