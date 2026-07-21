/**
 * Unit tests for the vault's pure crypto core (PII P0 Phase 3).
 *
 * Framework: Node's built-in test runner, same as sha256.test.mts —
 * vault-crypto.ts is RN-free (@noble/ciphers is pure JS and
 * `crypto.getRandomValues` is global in Node), so it runs under plain
 * Node with zero shims.
 *
 * What these pin down: a sealed capture never exposes its plaintext on
 * disk, a tampered or wrong-key payload THROWS rather than returning
 * garbage, and legacy (pre-encryption) plaintext passes through — the
 * dual-read contract the upload path and the startup migration rely on.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bytesToHex,
  hexToBytes,
  isSealed,
  openBytes,
  openQueueString,
  QUEUE_PREFIX,
  SEAL_MAGIC,
  sealBytes,
  sealQueueString,
} from './vault-crypto.ts';

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(8);
const PLAINTEXT = new TextEncoder().encode(
  'SUBJECT PROPERTY: 2628 Florida St — appraisal photo bytes',
);

test('seal → open round-trips the exact bytes', () => {
  const sealed = sealBytes(KEY, PLAINTEXT);
  assert.deepEqual(openBytes(KEY, sealed), PLAINTEXT);
});

test('sealed payload carries the NSV1 marker and hides the plaintext', () => {
  const sealed = sealBytes(KEY, PLAINTEXT);
  assert.ok(isSealed(sealed));
  assert.deepEqual(sealed.slice(0, 4), SEAL_MAGIC);
  // The plaintext must not appear anywhere in the sealed bytes.
  const hay = bytesToHex(sealed);
  const needle = bytesToHex(PLAINTEXT);
  assert.ok(!hay.includes(needle), 'plaintext leaked into sealed payload');
});

test('two seals of the same bytes differ (fresh nonce each time)', () => {
  const a = sealBytes(KEY, PLAINTEXT);
  const b = sealBytes(KEY, PLAINTEXT);
  assert.notDeepEqual(a, b);
});

test('legacy plaintext (no marker) passes through open unchanged', () => {
  const legacy = new TextEncoder().encode('%PDF-1.7 legacy capture');
  assert.ok(!isSealed(legacy));
  assert.deepEqual(openBytes(KEY, legacy), legacy);
});

test('short payloads are treated as legacy plaintext, not sealed', () => {
  const tiny = new Uint8Array([0x4e, 0x53]); // "NS" — shorter than a header
  assert.ok(!isSealed(tiny));
  assert.deepEqual(openBytes(KEY, tiny), tiny);
});

test('a flipped byte fails the AEAD tag — open throws, never garbage', () => {
  const sealed = sealBytes(KEY, PLAINTEXT);
  sealed[sealed.length - 1] ^= 0x01;
  assert.throws(() => openBytes(KEY, sealed));
});

test('the wrong key throws', () => {
  const sealed = sealBytes(KEY, PLAINTEXT);
  assert.throws(() => openBytes(OTHER_KEY, sealed));
});

test('queue blob: seal → open round-trips the JSON', () => {
  const json = JSON.stringify([
    { id: 'cap_1', geo: { lat: 46.14, lon: -122.93 }, caption: '2628 Florida St' },
  ]);
  const stored = sealQueueString(KEY, json);
  assert.ok(stored.startsWith(QUEUE_PREFIX));
  assert.ok(!stored.includes('Florida'), 'queue PII leaked into stored value');
  assert.equal(openQueueString(KEY, stored), json);
});

test('queue blob: legacy plaintext JSON passes through', () => {
  const legacy = '[{"id":"cap_1"}]';
  assert.equal(openQueueString(KEY, legacy), legacy);
});

test('queue blob: corrupted hex throws instead of parsing garbage', () => {
  const stored = sealQueueString(KEY, '[]');
  const corrupted =
    stored.slice(0, -2) + (stored.endsWith('00') ? 'ff' : '00');
  assert.throws(() => openQueueString(KEY, corrupted));
});

test('hex helpers round-trip', () => {
  const bytes = new Uint8Array([0, 1, 15, 16, 127, 128, 255]);
  assert.deepEqual(hexToBytes(bytesToHex(bytes)), bytes);
});
