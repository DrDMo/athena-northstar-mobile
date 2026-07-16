/**
 * Unit tests for the pure vector floor-plan geometry (#666, SLICE 1).
 *
 * Framework: Node's BUILT-IN test runner (`node:test` + `node:assert`),
 * chosen because the repo ships no jest/vitest and adding one would pull
 * a native/registry dependency this offline-first RN app doesn't need.
 * `src/lib/sketch-model.ts` is framework-free on purpose, so it runs
 * under plain Node (≥ 23.6 strips the TS types natively) with zero shims.
 *
 * The file is `.mts` (ESM) so (a) Node runs it without a "typeless
 * package" warning and (b) the app tsconfig's `include` glob (which
 * only matches `.ts`, not `.mts`) does NOT pick it up — keeping
 * `npx tsc --noEmit` on the RN app clean of node-only types.
 * `tsconfig.test.json` type-checks it with `@types/node`.
 *
 * Run:  npm test   (→ tsc -p tsconfig.test.json && node --test …)
 * Or:   node --test src/lib/sketch-model.test.mts
 *
 * These assert the measurements an appraiser depends on: a 20×15 ft
 * rectangle = 300 sq ft, a 6×8 right triangle = 24 sq ft, the perimeter
 * of a closed square, and the 8-direction offset math (esp. diagonals).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  areaSquareFeet,
  type Dir8,
  emptyDoc,
  endpointOffset,
  perimeterFeet,
  pxPerFootFromGrid,
  segmentLengthFeet,
  segments,
  type SketchDoc,
  type SketchVertex,
} from './sketch-model.ts';

const APPROX = 1e-9;

/** Build a closed polygon doc from vertices at a given pxPerFoot. */
function closedDoc(pxPerFoot: number, vertices: SketchVertex[]): SketchDoc {
  return { version: 1, pxPerFoot, vertices, labels: [], closed: true };
}

test('pxPerFootFromGrid: spacing / feet-per-square', () => {
  assert.equal(pxPerFootFromGrid(24, 1), 24);
  assert.equal(pxPerFootFromGrid(24, 2), 12);
  assert.equal(pxPerFootFromGrid(40, 5), 8);
  // Guards: non-positive inputs -> 0 (uncalibrated).
  assert.equal(pxPerFootFromGrid(0, 1), 0);
  assert.equal(pxPerFootFromGrid(24, 0), 0);
});

test('segmentLengthFeet: pixel distance / pxPerFoot', () => {
  // 3-4-5 triangle: hypotenuse 5 units. At 10 px/ft -> 50 px -> 5 ft.
  assert.equal(segmentLengthFeet({ x: 0, y: 0 }, { x: 30, y: 40 }, 10), 5);
  // Horizontal 480 px at 24 px/ft -> 20 ft.
  assert.equal(segmentLengthFeet({ x: 0, y: 0 }, { x: 480, y: 0 }, 24), 20);
  // Uncalibrated -> 0, never a divide-by-zero Infinity.
  assert.equal(segmentLengthFeet({ x: 0, y: 0 }, { x: 10, y: 0 }, 0), 0);
});

test('area: a 20 ft x 15 ft rectangle = 300 sq ft', () => {
  // 24 px/ft -> 20 ft = 480 px wide, 15 ft = 360 px tall.
  const doc = closedDoc(24, [
    { x: 0, y: 0 },
    { x: 480, y: 0 },
    { x: 480, y: 360 },
    { x: 0, y: 360 },
  ]);
  assert.ok(Math.abs(areaSquareFeet(doc) - 300) < APPROX);
  // Perimeter = 2*(20+15) = 70 ft.
  assert.ok(Math.abs(perimeterFeet(doc) - 70) < APPROX);
});

test('area: a 6 ft x 8 ft right triangle = 24 sq ft', () => {
  // 10 px/ft -> legs 60 px and 80 px.
  const doc = closedDoc(10, [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 0, y: 80 },
  ]);
  assert.ok(Math.abs(areaSquareFeet(doc) - 24) < APPROX);
  // Perimeter = 6 + 8 + 10 (hypotenuse) = 24 ft.
  assert.ok(Math.abs(perimeterFeet(doc) - 24) < APPROX);
});

test('area: winding order does not flip the sign', () => {
  const cw = closedDoc(24, [
    { x: 0, y: 0 },
    { x: 480, y: 0 },
    { x: 480, y: 360 },
    { x: 0, y: 360 },
  ]);
  const ccw = closedDoc(24, [
    { x: 0, y: 0 },
    { x: 0, y: 360 },
    { x: 480, y: 360 },
    { x: 480, y: 0 },
  ]);
  assert.ok(Math.abs(areaSquareFeet(cw) - areaSquareFeet(ccw)) < APPROX);
  assert.ok(Math.abs(areaSquareFeet(cw) - 300) < APPROX);
});

test('area: returns 0 for open or degenerate shapes', () => {
  const openTri: SketchDoc = {
    version: 1,
    pxPerFoot: 10,
    vertices: [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 0, y: 80 },
    ],
    labels: [],
    closed: false, // not closed -> no area
  };
  assert.equal(areaSquareFeet(openTri), 0);
  // Closed but < 3 vertices -> 0.
  assert.equal(
    areaSquareFeet(closedDoc(10, [{ x: 0, y: 0 }, { x: 60, y: 0 }])),
    0,
  );
  // Uncalibrated -> 0.
  assert.equal(
    areaSquareFeet(
      closedDoc(0, [
        { x: 0, y: 0 },
        { x: 480, y: 0 },
        { x: 480, y: 360 },
      ]),
    ),
    0,
  );
});

test('perimeter: a closed 10 ft square = 40 ft', () => {
  // 12 px/ft -> 10 ft = 120 px sides.
  const doc = closedDoc(12, [
    { x: 0, y: 0 },
    { x: 120, y: 0 },
    { x: 120, y: 120 },
    { x: 0, y: 120 },
  ]);
  assert.ok(Math.abs(perimeterFeet(doc) - 40) < APPROX);
});

test('segments: open path has n-1 edges; closing edge appears only when closed', () => {
  const verts: SketchVertex[] = [
    { x: 0, y: 0 },
    { x: 120, y: 0 },
    { x: 120, y: 120 },
    { x: 0, y: 120 },
  ];
  const open: SketchDoc = {
    version: 1,
    pxPerFoot: 12,
    vertices: verts,
    labels: [],
    closed: false,
  };
  assert.equal(segments(open).length, 3); // 4 vertices -> 3 edges
  const closed = closedDoc(12, verts);
  assert.equal(segments(closed).length, 4); // + closing edge
  // Open traced length = 3 sides = 30 ft; closed adds the 4th -> 40 ft.
  assert.ok(Math.abs(perimeterFeet(open) - 30) < APPROX);
  assert.ok(Math.abs(perimeterFeet(closed) - 40) < APPROX);
});

test('segments: midpoints land halfway between endpoints', () => {
  const doc: SketchDoc = {
    version: 1,
    pxPerFoot: 10,
    vertices: [
      { x: 0, y: 0 },
      { x: 100, y: 40 },
    ],
    labels: [],
    closed: false,
  };
  const [seg] = segments(doc);
  assert.deepEqual(seg.mid, { x: 50, y: 20 });
});

test('endpointOffset: orthogonals move the full distance on one axis', () => {
  const ppf = 24;
  // up = -y, right = +x, down = +y, left = -x.
  assert.deepEqual(endpointOffset('up', 10, ppf), { dx: 0, dy: -240 });
  assert.deepEqual(endpointOffset('down', 10, ppf), { dx: 0, dy: 240 });
  assert.deepEqual(endpointOffset('right', 10, ppf), { dx: 240, dy: 0 });
  assert.deepEqual(endpointOffset('left', 10, ppf), { dx: -240, dy: 0 });
});

test('endpointOffset: a diagonal segment is `feet` long along the hypotenuse', () => {
  const ppf = 10;
  const feet = 14;
  for (const dir of [
    'up-right',
    'up-left',
    'down-right',
    'down-left',
  ] as Dir8[]) {
    const { dx, dy } = endpointOffset(dir, feet, ppf);
    // The resulting move, measured back through the same pxPerFoot,
    // must equal the entered distance -- NOT feet*sqrt(2).
    const measured = segmentLengthFeet({ x: 0, y: 0 }, { x: dx, y: dy }, ppf);
    assert.ok(
      Math.abs(measured - feet) < 1e-9,
      `${dir}: measured ${measured} ft, expected ${feet} ft`,
    );
    // Each axis component is feet*ppf/sqrt(2).
    assert.ok(Math.abs(Math.abs(dx) - (feet * ppf) / Math.SQRT2) < 1e-9);
    assert.ok(Math.abs(Math.abs(dy) - (feet * ppf) / Math.SQRT2) < 1e-9);
  }
});

test('endpointOffset: appraiser round-trip -- pace a 20x15 rectangle by arrows', () => {
  // Start at origin; pace right 20, down 15, left 20, up 15 -> back home,
  // enclosing 300 sq ft. This mirrors the on-device precise-entry flow.
  const ppf = pxPerFootFromGrid(24, 1); // 24 px/ft
  let cur: SketchVertex = { x: 100, y: 100 };
  const verts: SketchVertex[] = [cur];
  const moves: [Dir8, number][] = [
    ['right', 20],
    ['down', 15],
    ['left', 20],
    ['up', 15],
  ];
  for (const [dir, feet] of moves) {
    const { dx, dy } = endpointOffset(dir, feet, ppf);
    cur = { x: cur.x + dx, y: cur.y + dy };
    verts.push(cur);
  }
  // Last vertex should coincide with the start (within fp epsilon).
  const start = verts[0];
  const last = verts[verts.length - 1];
  assert.ok(Math.abs(last.x - start.x) < 1e-9);
  assert.ok(Math.abs(last.y - start.y) < 1e-9);
  // Drop the duplicate closing vertex, close, and check area/perimeter.
  const doc = closedDoc(ppf, verts.slice(0, -1));
  assert.ok(Math.abs(areaSquareFeet(doc) - 300) < APPROX);
  assert.ok(Math.abs(perimeterFeet(doc) - 70) < APPROX);
});

test('emptyDoc: calibrated, empty, open', () => {
  const doc = emptyDoc(12);
  assert.deepEqual(doc, {
    version: 1,
    pxPerFoot: 12,
    vertices: [],
    labels: [],
    closed: false,
  });
  assert.equal(areaSquareFeet(doc), 0);
  assert.equal(perimeterFeet(doc), 0);
  assert.equal(segments(doc).length, 0);
});
