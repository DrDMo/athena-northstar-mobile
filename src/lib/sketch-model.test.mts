/**
 * Unit tests for the pure vector floor-plan geometry (#666, SLICE 1;
 * multi-shape #686).
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
  docFromShapes,
  docShapes,
  emptyDoc,
  endpointOffset,
  hasSelfIntersection,
  perimeterFeet,
  pxPerFootFromGrid,
  rescaleDoc,
  segmentLengthFeet,
  segments,
  shapeAreaSquareFeet,
  shapeCentroid,
  shapePerimeterFeet,
  shapeSegments,
  type SketchDoc,
  type SketchShape,
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

test('rescaleDoc: a 20 ft wall stays 20 ft across a 1 ft → 5 ft scale change', () => {
  // The calibration-instability bug: same 24 px grid, scale flips 1 ft
  // → 5 ft per square. pxPerFoot goes 24 → 4.8, factor = 4.8/24 = 0.2.
  const oldPpf = pxPerFootFromGrid(24, 1); // 24 px/ft
  const newPpf = pxPerFootFromGrid(24, 5); // 4.8 px/ft
  const doc: SketchDoc = {
    version: 1,
    pxPerFoot: oldPpf,
    vertices: [
      { x: 0, y: 0 },
      { x: 480, y: 0 }, // 480 px at 24 px/ft = 20 ft
    ],
    labels: [{ x: 240, y: -10, text: 'Front wall' }],
    closed: false,
  };
  assert.ok(Math.abs(segments(doc)[0].feet - 20) < APPROX);

  const out = rescaleDoc(doc, newPpf / oldPpf);
  // Calibration followed the factor…
  assert.ok(Math.abs(out.pxPerFoot - newPpf) < APPROX);
  // …geometry scaled about the origin…
  assert.ok(Math.abs(out.vertices[1].x - 96) < APPROX);
  assert.ok(Math.abs(out.labels[0].x - 48) < APPROX);
  assert.ok(Math.abs(out.labels[0].y - -2) < APPROX);
  assert.equal(out.labels[0].text, 'Front wall');
  // …so the REAL measurement is invariant: still exactly 20 ft.
  assert.ok(Math.abs(segments(out)[0].feet - 20) < APPROX);
});

test('rescaleDoc: area and perimeter are invariant', () => {
  // 20 x 15 ft rectangle at 24 px/ft = 300 sq ft, 70 ft perimeter.
  const doc = closedDoc(24, [
    { x: 0, y: 0 },
    { x: 480, y: 0 },
    { x: 480, y: 360 },
    { x: 0, y: 360 },
  ]);
  const out = rescaleDoc(doc, 0.2);
  assert.ok(Math.abs(areaSquareFeet(out) - 300) < APPROX);
  assert.ok(Math.abs(perimeterFeet(out) - 70) < APPROX);
  // Round-trip back to the original calibration is also invariant.
  const back = rescaleDoc(out, 5);
  assert.ok(Math.abs(areaSquareFeet(back) - 300) < APPROX);
  assert.ok(Math.abs(back.pxPerFoot - 24) < APPROX);
});

test('rescaleDoc: identity / invalid factors return the doc unchanged', () => {
  const doc = closedDoc(24, [
    { x: 0, y: 0 },
    { x: 480, y: 0 },
    { x: 480, y: 360 },
  ]);
  assert.equal(rescaleDoc(doc, 1), doc); // same reference — no churn
  assert.equal(rescaleDoc(doc, 0), doc);
  assert.equal(rescaleDoc(doc, -2), doc);
  assert.equal(rescaleDoc(doc, Number.NaN), doc);
  assert.equal(rescaleDoc(doc, Number.POSITIVE_INFINITY), doc);
});

test('hasSelfIntersection: bowtie true, rectangle false', () => {
  // Bowtie: edges (0,0)-(10,10) and (10,0)-(0,10) cross at (5,5).
  const bowtie: SketchVertex[] = [
    { x: 0, y: 0 },
    { x: 10, y: 10 },
    { x: 10, y: 0 },
    { x: 0, y: 10 },
  ];
  assert.equal(hasSelfIntersection(bowtie, true), true);

  const rect: SketchVertex[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.equal(hasSelfIntersection(rect, true), false);
  assert.equal(hasSelfIntersection(rect, false), false);
});

test('hasSelfIntersection: adjacent edges sharing a vertex do not count', () => {
  // A simple right angle — consecutive edges meet at (10,0) by design.
  const corner: SketchVertex[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];
  assert.equal(hasSelfIntersection(corner, false), false);
  // Closed triangle: closing edge shares endpoints with first/last edge.
  assert.equal(hasSelfIntersection(corner, true), false);
});

test('hasSelfIntersection: open-path crossing detected', () => {
  // Edge (4,4)-(2,-2) crosses edge (0,0)-(4,0) at (8/3, 0).
  const zig: SketchVertex[] = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 2, y: -2 },
  ];
  assert.equal(hasSelfIntersection(zig, false), true);
});

test('hasSelfIntersection: closing edge counted only when closed', () => {
  // Open, no edge pair crosses. Closing edge (10,10)→(0,0) crosses the
  // (10,0)→(5,15) edge at (7.5, 7.5).
  const verts: SketchVertex[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 5, y: 15 },
    { x: 10, y: 10 },
  ];
  assert.equal(hasSelfIntersection(verts, false), false);
  assert.equal(hasSelfIntersection(verts, true), true);
});

test('hasSelfIntersection: degenerate inputs are safe', () => {
  assert.equal(hasSelfIntersection([], false), false);
  assert.equal(hasSelfIntersection([{ x: 0, y: 0 }], true), false);
  assert.equal(
    hasSelfIntersection([{ x: 0, y: 0 }, { x: 5, y: 5 }], true),
    false,
  );
});

test('emptyDoc: calibrated, empty, open — with the shapes mirror in place', () => {
  const doc = emptyDoc(12);
  assert.deepEqual(doc, {
    version: 1,
    pxPerFoot: 12,
    vertices: [],
    labels: [],
    closed: false,
    shapes: [{ vertices: [], closed: false }],
  });
  assert.equal(areaSquareFeet(doc), 0);
  assert.equal(perimeterFeet(doc), 0);
  assert.equal(segments(doc).length, 0);
});

// --- Multi-shape (#686) ---

test('docShapes: a legacy doc (no shapes key) loads as ONE shape', () => {
  // A doc saved before #686 shipped: top-level vertices/closed only.
  const legacy: SketchDoc = {
    version: 1,
    pxPerFoot: 24,
    vertices: [
      { x: 0, y: 0 },
      { x: 480, y: 0 },
      { x: 480, y: 360 },
      { x: 0, y: 360 },
    ],
    labels: [],
    closed: true,
  };
  const shapes = docShapes(legacy);
  assert.equal(shapes.length, 1);
  // Same arrays, not copies — the legacy fields ARE the single shape.
  assert.equal(shapes[0].vertices, legacy.vertices);
  assert.equal(shapes[0].closed, true);
  // Its measurements are the doc-level ones.
  assert.ok(
    Math.abs(shapeAreaSquareFeet(shapes[0], 24) - areaSquareFeet(legacy)) <
      APPROX,
  );
});

test('docShapes: a modern doc returns its shapes; empty shapes falls back to legacy', () => {
  const house: SketchShape = {
    vertices: [
      { x: 0, y: 0 },
      { x: 480, y: 0 },
      { x: 480, y: 360 },
      { x: 0, y: 360 },
    ],
    closed: true,
  };
  const garage: SketchShape = {
    vertices: [
      { x: 600, y: 0 },
      { x: 840, y: 0 },
      { x: 840, y: 240 },
      { x: 600, y: 240 },
    ],
    closed: true,
  };
  const doc = docFromShapes(24, [house, garage], []);
  assert.equal(docShapes(doc), doc.shapes);
  assert.equal(docShapes(doc).length, 2);
  // `shapes: []` is a writer bug, not worth throwing over: fall back to
  // the legacy mirror as the single shape.
  const buggy: SketchDoc = {
    version: 1,
    pxPerFoot: 24,
    vertices: [{ x: 1, y: 2 }],
    labels: [],
    closed: false,
    shapes: [],
  };
  const fallback = docShapes(buggy);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].vertices, buggy.vertices);
});

test('docFromShapes: legacy vertices/closed ALWAYS mirror shapes[0] on serialize', () => {
  const first: SketchShape = {
    vertices: [
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 120, y: 120 },
    ],
    closed: true,
  };
  const second: SketchShape = {
    vertices: [
      { x: 200, y: 0 },
      { x: 260, y: 0 },
    ],
    closed: false,
  };
  const doc = docFromShapes(12, [first, second], [
    { x: 60, y: 60, text: 'House' },
  ]);
  // The mirror invariant — a pre-#686 reader sees the first outline.
  assert.equal(doc.vertices, first.vertices);
  assert.equal(doc.closed, first.closed);
  assert.equal(doc.shapes?.length, 2);
  assert.equal(doc.shapes?.[1], second);
  assert.equal(doc.labels.length, 1);
  // An empty shape list normalizes to one empty open shape so the
  // mirror always has a shapes[0] to point at.
  const blank = docFromShapes(12, [], []);
  assert.deepEqual(blank.shapes, [{ vertices: [], closed: false }]);
  assert.deepEqual(blank.vertices, []);
  assert.equal(blank.closed, false);
});

test('shape-level geometry matches the doc-level legacy delegates', () => {
  const verts: SketchVertex[] = [
    { x: 0, y: 0 },
    { x: 120, y: 0 },
    { x: 120, y: 120 },
    { x: 0, y: 120 },
  ];
  const doc = closedDoc(12, verts);
  const shape: SketchShape = { vertices: verts, closed: true };
  assert.deepEqual(shapeSegments(shape, 12), segments(doc));
  assert.equal(shapePerimeterFeet(shape, 12), perimeterFeet(doc));
  assert.equal(shapeAreaSquareFeet(shape, 12), areaSquareFeet(doc));
});

test('multi-shape: area of the SECOND shape (the garage) measures independently', () => {
  // 24 px/ft. House 20x15 ft = 300 sq ft; garage 10x10 ft = 100 sq ft.
  const house: SketchShape = {
    vertices: [
      { x: 0, y: 0 },
      { x: 480, y: 0 },
      { x: 480, y: 360 },
      { x: 0, y: 360 },
    ],
    closed: true,
  };
  const garage: SketchShape = {
    vertices: [
      { x: 600, y: 0 },
      { x: 840, y: 0 },
      { x: 840, y: 240 },
      { x: 600, y: 240 },
    ],
    closed: true,
  };
  const doc = docFromShapes(24, [house, garage], []);
  const shapes = docShapes(doc);
  assert.ok(Math.abs(shapeAreaSquareFeet(shapes[0], doc.pxPerFoot) - 300) < APPROX);
  assert.ok(Math.abs(shapeAreaSquareFeet(shapes[1], doc.pxPerFoot) - 100) < APPROX);
  assert.ok(Math.abs(shapePerimeterFeet(shapes[1], doc.pxPerFoot) - 40) < APPROX);
  // The doc-level (legacy-mirror) area still reads shape[0] only — a
  // pre-#686 reader sees the house, never a house+garage sum.
  assert.ok(Math.abs(areaSquareFeet(doc) - 300) < APPROX);
});

test('multi-shape: an OPEN second shape has no area but a traced path length', () => {
  const house: SketchShape = {
    vertices: [
      { x: 0, y: 0 },
      { x: 240, y: 0 },
      { x: 240, y: 240 },
      { x: 0, y: 240 },
    ],
    closed: true,
  };
  // Deck being traced: two 10 ft walls at 24 px/ft, not yet closed.
  const deck: SketchShape = {
    vertices: [
      { x: 300, y: 0 },
      { x: 540, y: 0 },
      { x: 540, y: 240 },
    ],
    closed: false,
  };
  const doc = docFromShapes(24, [house, deck], []);
  const shapes = docShapes(doc);
  assert.equal(shapeAreaSquareFeet(shapes[1], doc.pxPerFoot), 0);
  assert.ok(Math.abs(shapePerimeterFeet(shapes[1], doc.pxPerFoot) - 20) < APPROX);
});

test('rescaleDoc: transforms EVERY shape, keeping each shape\'s feet invariant', () => {
  // Same 24 px grid, scale flips 1 ft → 5 ft per square: factor 0.2.
  const oldPpf = pxPerFootFromGrid(24, 1);
  const newPpf = pxPerFootFromGrid(24, 5);
  const house: SketchShape = {
    vertices: [
      { x: 0, y: 0 },
      { x: 480, y: 0 },
      { x: 480, y: 360 },
      { x: 0, y: 360 },
    ],
    closed: true,
  };
  const garage: SketchShape = {
    vertices: [
      { x: 600, y: 0 },
      { x: 840, y: 0 },
      { x: 840, y: 240 },
      { x: 600, y: 240 },
    ],
    closed: true,
  };
  const doc = docFromShapes(oldPpf, [house, garage], [
    { x: 240, y: 180, text: 'House' },
  ]);
  const out = rescaleDoc(doc, newPpf / oldPpf);
  assert.ok(Math.abs(out.pxPerFoot - newPpf) < APPROX);
  // Both shapes' pixel geometry scaled about the origin…
  assert.ok(Math.abs((out.shapes?.[0].vertices[1].x ?? NaN) - 96) < APPROX);
  assert.ok(Math.abs((out.shapes?.[1].vertices[0].x ?? NaN) - 120) < APPROX);
  // …and the legacy mirror scaled with them (same values as shapes[0]).
  assert.deepEqual(out.vertices, out.shapes?.[0].vertices);
  assert.equal(out.closed, out.shapes?.[0].closed);
  // Real measurements are invariant PER SHAPE: 300 + 100 sq ft.
  const shapes = docShapes(out);
  assert.ok(Math.abs(shapeAreaSquareFeet(shapes[0], out.pxPerFoot) - 300) < APPROX);
  assert.ok(Math.abs(shapeAreaSquareFeet(shapes[1], out.pxPerFoot) - 100) < APPROX);
  assert.ok(Math.abs(shapePerimeterFeet(shapes[1], out.pxPerFoot) - 40) < APPROX);
});

test('rescaleDoc: a legacy doc (no shapes key) stays legacy after rescale', () => {
  const doc = closedDoc(24, [
    { x: 0, y: 0 },
    { x: 480, y: 0 },
    { x: 480, y: 360 },
  ]);
  assert.equal(doc.shapes, undefined);
  const out = rescaleDoc(doc, 0.5);
  // Rescale never invents the key — additive evolution is the writer's
  // (docFromShapes') job, not a side effect of recalibration.
  assert.equal(out.shapes, undefined);
  // But docShapes still normalizes it to one shape with scaled geometry.
  const shapes = docShapes(out);
  assert.equal(shapes.length, 1);
  assert.ok(Math.abs(shapes[0].vertices[1].x - 240) < APPROX);
});

test('hasSelfIntersection: judged PER SHAPE — a bowtie garage does not taint the house', () => {
  const house: SketchShape = {
    vertices: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    closed: true,
  };
  const bowtieGarage: SketchShape = {
    vertices: [
      { x: 200, y: 0 },
      { x: 300, y: 100 },
      { x: 300, y: 0 },
      { x: 200, y: 100 },
    ],
    closed: true,
  };
  const doc = docFromShapes(10, [house, bowtieGarage], []);
  const shapes = docShapes(doc);
  assert.equal(hasSelfIntersection(shapes[0].vertices, shapes[0].closed), false);
  assert.equal(hasSelfIntersection(shapes[1].vertices, shapes[1].closed), true);
  // Two shapes that OVERLAP each other are fine — a deck tucked against
  // the house is normal, so cross-shape intersection is not a defect
  // (each shape is judged alone).
  const overlappingDeck: SketchShape = {
    vertices: [
      { x: 50, y: 50 },
      { x: 150, y: 50 },
      { x: 150, y: 150 },
      { x: 50, y: 150 },
    ],
    closed: true,
  };
  assert.equal(
    hasSelfIntersection(overlappingDeck.vertices, overlappingDeck.closed),
    false,
  );
});

test('shapeCentroid: rectangle centroid lands at its center', () => {
  const c = shapeCentroid([
    { x: 0, y: 0 },
    { x: 480, y: 0 },
    { x: 480, y: 360 },
    { x: 0, y: 360 },
  ]);
  assert.ok(c != null);
  assert.ok(Math.abs(c.x - 240) < APPROX);
  assert.ok(Math.abs(c.y - 180) < APPROX);
  // Winding order doesn't move it.
  const cc = shapeCentroid([
    { x: 0, y: 0 },
    { x: 0, y: 360 },
    { x: 480, y: 360 },
    { x: 480, y: 0 },
  ]);
  assert.ok(cc != null);
  assert.ok(Math.abs(cc.x - 240) < APPROX);
  assert.ok(Math.abs(cc.y - 180) < APPROX);
});

test('shapeCentroid: L-shape centroid is area-weighted, not the vertex mean', () => {
  // An L: 2x2 square with a 1x1 notch removed from the top-right.
  // Area = 3; centroid = (sum of sub-rect centroids weighted by area):
  // bottom 2x1 at (1, 1.5) area 2; top-left 1x1 at (0.5, 0.5) area 1
  // → ((2*1 + 1*0.5)/3, (2*1.5 + 1*0.5)/3) = (5/6, 7/6).
  const c = shapeCentroid([
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
  ]);
  assert.ok(c != null);
  assert.ok(Math.abs(c.x - 5 / 6) < APPROX);
  assert.ok(Math.abs(c.y - 7 / 6) < APPROX);
});

test('shapeCentroid: degenerate inputs fall back safely', () => {
  assert.equal(shapeCentroid([]), null);
  // One point → that point; two points → the midpoint (vertex mean).
  assert.deepEqual(shapeCentroid([{ x: 3, y: 4 }]), { x: 3, y: 4 });
  assert.deepEqual(
    shapeCentroid([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
    { x: 5, y: 0 },
  );
  // Collinear (zero-area) polygon → vertex mean, not NaN.
  const c = shapeCentroid([
    { x: 0, y: 0 },
    { x: 5, y: 5 },
    { x: 10, y: 10 },
  ]);
  assert.ok(c != null);
  assert.ok(Math.abs(c.x - 5) < APPROX);
  assert.ok(Math.abs(c.y - 5) < APPROX);
});
