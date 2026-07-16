/**
 * Vector floor-plan model + geometry (#666, SLICE 1).
 *
 * This is the editable document a field appraiser assembles on the
 * sketch surface, plus the pure geometry helpers that turn it into real
 * measurements (segment lengths, perimeter, enclosed area). It replaces
 * the old freehand-raster tool, whose PNG threw the geometry away.
 *
 * Design rules:
 *   - FRAMEWORK-FREE. No react / react-native imports so the exact same
 *     module can be reused on the web later and unit-tested under plain
 *     Node (`node --test`) with no native/RN shims.
 *   - Coordinates are CANVAS PIXELS. `pxPerFoot` is the single conversion
 *     factor between pixels and real feet; it is stored ON the document
 *     so lengths/area are computable from the doc alone, with no access
 *     to the grid/scale UI state that produced it.
 *   - Pure + total. Every helper is deterministic and guards its inputs
 *     (a zero/negative `pxPerFoot`, an open or degenerate polygon, etc.) so the
 *     UI never has to defend against a throw mid-render.
 */

/** A polyline vertex in canvas-pixel coordinates. */
export type SketchVertex = { x: number; y: number };

/** A free-floating text annotation in canvas-pixel coordinates. */
export type SketchLabel = { x: number; y: number; text: string };

/**
 * The editable sketch document. Persisted on `meta.sketch.vector` so a
 * sketch round-trips and can be re-opened and edited later — the whole
 * point of going vector.
 */
export type SketchDoc = {
  /** Schema version — bump on any breaking shape change. */
  version: 1;
  /**
   * Canvas pixels per real-world foot. Derive from the grid via
   * {@link pxPerFootFromGrid} (grid spacing px ÷ feet-per-square) and
   * store it so every length/area is computable from the doc alone.
   */
  pxPerFoot: number;
  /** Polyline / polygon vertices, in draw order. */
  vertices: SketchVertex[];
  /** Free-floating text labels. */
  labels: SketchLabel[];
  /** True once the shape is closed (last vertex connects back to first). */
  closed: boolean;
};

/**
 * The 8 SCREEN-RELATIVE directions for keyboard distance entry. These
 * are NOT compass cardinals — `up` is screen-up (−y), `right` is
 * screen-right (+x). Appraisers pace a perimeter ("20 ft up, 12 ft
 * right…") relative to how the sketch sits on screen.
 */
export type Dir8 =
  | 'up'
  | 'up-right'
  | 'right'
  | 'down-right'
  | 'down'
  | 'down-left'
  | 'left'
  | 'up-left';

/** All 8 directions, in clockwise order starting from screen-up. */
export const DIR8: readonly Dir8[] = [
  'up',
  'up-right',
  'right',
  'down-right',
  'down',
  'down-left',
  'left',
  'up-left',
] as const;

/** 1/√2 — the per-axis component of a unit diagonal. */
const INV_SQRT2 = Math.SQRT1_2; // 0.70710678…

/**
 * Screen-relative unit vectors for each direction. Screen coords: +x is
 * right, +y is DOWN (so `up` is −y). Diagonals use the 1/√2 component so
 * the resulting move has unit length — a `feet`-foot diagonal is `feet`
 * feet along the hypotenuse, not `feet` per axis.
 */
const DIR8_UNIT: Record<Dir8, { ux: number; uy: number }> = {
  up: { ux: 0, uy: -1 },
  down: { ux: 0, uy: 1 },
  right: { ux: 1, uy: 0 },
  left: { ux: -1, uy: 0 },
  'up-right': { ux: INV_SQRT2, uy: -INV_SQRT2 },
  'up-left': { ux: -INV_SQRT2, uy: -INV_SQRT2 },
  'down-right': { ux: INV_SQRT2, uy: INV_SQRT2 },
  'down-left': { ux: -INV_SQRT2, uy: INV_SQRT2 },
};

/**
 * Canvas pixels per real-world foot from the grid: grid spacing (px) ÷
 * feet represented by one grid square. E.g. a 24 px grid at 2 ft/square
 * → 12 px/ft. Returns 0 for a non-positive spacing or scale (caller
 * should fall back to a nominal spacing when the grid is hidden).
 */
export function pxPerFootFromGrid(
  gridSpacingPx: number,
  scaleFeetPerSquare: number,
): number {
  if (gridSpacingPx <= 0 || scaleFeetPerSquare <= 0) return 0;
  return gridSpacingPx / scaleFeetPerSquare;
}

/**
 * Real-world length in feet of the segment a→b: Euclidean pixel distance
 * ÷ pxPerFoot. Returns 0 when pxPerFoot is non-positive (uncalibrated).
 */
export function segmentLengthFeet(
  a: SketchVertex,
  b: SketchVertex,
  pxPerFoot: number,
): number {
  if (pxPerFoot <= 0) return 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.hypot(dx, dy) / pxPerFoot;
}

/** One drawn edge with its endpoints, measured length, and midpoint. */
export type SketchSegment = {
  a: SketchVertex;
  b: SketchVertex;
  /** Length in real feet. */
  feet: number;
  /** Midpoint (for placing the dimension label). */
  mid: SketchVertex;
};

/**
 * The edges of the doc, in draw order. Consecutive vertices form the
 * open path; when `closed` (and there are ≥3 vertices) the closing edge
 * (last→first) is appended so the polygon reads as a loop.
 */
export function segments(doc: SketchDoc): SketchSegment[] {
  const { vertices, pxPerFoot } = doc;
  const out: SketchSegment[] = [];
  const mk = (a: SketchVertex, b: SketchVertex): SketchSegment => ({
    a,
    b,
    feet: segmentLengthFeet(a, b, pxPerFoot),
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  });
  for (let i = 0; i < vertices.length - 1; i++) {
    out.push(mk(vertices[i], vertices[i + 1]));
  }
  // Closing edge only makes sense for a real polygon (≥3 vertices);
  // for 2 it would just duplicate the single edge.
  if (doc.closed && vertices.length >= 3) {
    out.push(mk(vertices[vertices.length - 1], vertices[0]));
  }
  return out;
}

/**
 * Total length of every edge, in feet. For an open path this is the
 * traced distance; for a closed shape it is the polygon perimeter
 * (the closing edge is included via {@link segments}).
 */
export function perimeterFeet(doc: SketchDoc): number {
  return segments(doc).reduce((sum, s) => sum + s.feet, 0);
}

/**
 * Enclosed area in square feet via the shoelace (surveyor's) formula on
 * the vertices, converted to feet² by dividing the pixel area by
 * pxPerFoot². Only meaningful for a CLOSED polygon of ≥3 vertices;
 * returns 0 otherwise (or when uncalibrated). The absolute value is
 * taken so winding order (clockwise vs counter-clockwise) doesn't flip
 * the sign.
 */
export function areaSquareFeet(doc: SketchDoc): number {
  const { vertices, pxPerFoot } = doc;
  if (!doc.closed || vertices.length < 3 || pxPerFoot <= 0) return 0;
  let twiceArea = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  const pixelArea = Math.abs(twiceArea) / 2;
  return pixelArea / (pxPerFoot * pxPerFoot);
}

/**
 * Pixel offset for the 8-direction distance entry: given a screen
 * direction and a distance in feet, the {dx,dy} to add to the anchor
 * vertex. Orthogonals move the full `feet·pxPerFoot` along one axis;
 * diagonals move `feet·pxPerFoot·(1/√2)` per axis so the SEGMENT length
 * equals `feet` (the hypotenuse), which is what the appraiser measured.
 * Screen coords: +x right, +y down, so `up` is −y.
 */
export function endpointOffset(
  dir: Dir8,
  feet: number,
  pxPerFoot: number,
): { dx: number; dy: number } {
  const { ux, uy } = DIR8_UNIT[dir];
  const px = feet * pxPerFoot;
  return { dx: ux * px, dy: uy * px };
}

/** An empty document calibrated at `pxPerFoot`. */
export function emptyDoc(pxPerFoot: number): SketchDoc {
  return { version: 1, pxPerFoot, vertices: [], labels: [], closed: false };
}
