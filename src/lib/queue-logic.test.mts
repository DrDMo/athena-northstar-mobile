/**
 * Unit tests for the pure queue transforms (capture-queue durability).
 *
 * Framework: Node's built-in test runner (`node:test` + `node:assert`),
 * same as sketch-model.test.mts — `queue-logic.ts` is framework-free and
 * RN-free on purpose (its only import is `import type`, which the runtime
 * erases), so it runs under plain Node with zero shims.
 *
 * These assert the two silent-data-loss guards:
 *   - stranded 'uploading' rows are reclaimed to 'pending' (else they are
 *     never retried and vanish from the on-screen counts), and
 *   - the synced-row retention cap keeps unsynced work while bounding the
 *     AsyncStorage metadata list (else saveQueue eventually throws and new
 *     captures silently fail to persist).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CaptureMeta } from './capture.ts';
import {
  MAX_SYNCED_RETAINED,
  capSyncedRows,
  hasStrandedRows,
  reclaimStrandedRows,
} from './queue-logic.ts';

type Status = CaptureMeta['status'];

function row(id: string, status: Status): CaptureMeta {
  return {
    id,
    kind: 'photo',
    localUri: `file:///tmp/${id}.jpg`,
    capturedAt: new Date(0).toISOString(),
    status,
  };
}

test('reclaimStrandedRows flips uploading → pending and leaves others', () => {
  const input = [
    row('a', 'uploading'),
    row('b', 'pending'),
    row('c', 'synced'),
    row('d', 'failed'),
    row('e', 'uploading'),
  ];
  const out = reclaimStrandedRows(input);
  assert.deepEqual(
    out.map((r) => r.status),
    ['pending', 'pending', 'synced', 'failed', 'pending'],
  );
  // Same length + ids, order preserved.
  assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'c', 'd', 'e']);
});

test('hasStrandedRows detects the uploading state only', () => {
  assert.equal(hasStrandedRows([row('a', 'uploading')]), true);
  assert.equal(
    hasStrandedRows([row('a', 'pending'), row('b', 'synced'), row('c', 'failed')]),
    false,
  );
  assert.equal(hasStrandedRows([]), false);
});

test('capSyncedRows keeps unsynced work and the newest synced rows', () => {
  // Newest-first (enqueue prepends). s1 is newer than s2 is newer than s3.
  const input = [
    row('p', 'pending'),
    row('s1', 'synced'),
    row('f', 'failed'),
    row('s2', 'synced'),
    row('u', 'uploading'),
    row('s3', 'synced'),
  ];
  const out = capSyncedRows(input, 2);
  // All unsynced rows survive; only the 2 newest synced (s1, s2) are kept.
  assert.deepEqual(out.map((r) => r.id), ['p', 's1', 'f', 's2', 'u']);
});

test('capSyncedRows never drops unsynced rows even past the cap', () => {
  const input = [
    row('p1', 'pending'),
    row('p2', 'pending'),
    row('p3', 'failed'),
  ];
  const out = capSyncedRows(input, 0);
  assert.deepEqual(out.map((r) => r.id), ['p1', 'p2', 'p3']);
});

test('capSyncedRows is a no-op below the cap', () => {
  const input = [row('s1', 'synced'), row('p', 'pending'), row('s2', 'synced')];
  const out = capSyncedRows(input, MAX_SYNCED_RETAINED);
  assert.deepEqual(out, input);
});
