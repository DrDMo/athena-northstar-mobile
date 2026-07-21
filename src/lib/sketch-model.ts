/**
 * Vector floor-plan model + geometry (#666, SLICE 1; multi-shape #686).
 *
 * This is the editable document a field appraiser assembles on the
 * sketch surface, plus the pure geometry helpers that turn it into real
 * measurements (segment lengths, perimeter, enclosed area). It replaces
 * the old freehand-raster tool, whose PNG threw the geometry away.
 * Since #686 a document holds MULTIPLE shapes (house + garage + deck);
 * see the SketchDoc mirror invariant for how that stayed wire-additive.
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
 * One drawn outline (#686): an open polyline while it is being traced,
 * a closed polygon once its last vertex connects back to its first. A
 * document holds several of these — house + garage + deck — where the
 * pre-#686 editor held exactly one.
 */
export type SketchShape = {
  /** Polyline / polygon vertices, in draw order. */
  vertices: SketchVertex[];
  /** True once the shape is closed (last vertex connects back to first). */
  closed: boolean;
};

/**
 * The editable sketch document. Persisted on `meta.sketch.vector` so a
 * sketch round-trips and can be re-opened and edited later — the whole
 * point of going vector.
 *
 * MULTI-SHAPE INVARIANT (#686, additive evolution): `shapes` is the
 * full outline list; the legacy top-level `vertices` + `closed` ALWAYS
 * mirror `shapes[0]`. Writers set both (see {@link docFromShapes});
 * readers that predate `shapes` keep working off the mirror, and
 * readers that know about `shapes` normalize through {@link docShapes},
 * which treats a legacy doc (no `shapes` key) as a single-shape doc.
 * The wire only ever GAINS keys — `shapes` is a new optional key, and
 * nothing existing changed meaning.
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
  /**
   * Polyline / polygon vertices of the FIRST shape, in draw order.
   * Legacy mirror of `shapes[0].vertices` — see the invariant above.
   */
  vertices: SketchVertex[];
  /** Free-floating text labels (one document-wide pool, not per-shape). */
  labels: SketchLabel[];
  /**
   * True once the first shape is closed. Legacy mirror of
   * `shapes[0].closed` — see the invariant above.
   */
  closed: boolean;
  /**
   * Every drawn outline (#686). Optional + additive: docs saved before
   * multi-shape shipped omit it, and {@link docShapes} treats those as
   * a single shape built from the legacy `vertices`/`closed` mirror.
   */
  shapes?: SketchShape[];
};

/**
 * Normalized shape list for a document — THE load path for multi-shape
 * (#686). A modern doc returns its `shapes` array; a legacy doc (or one
 * with an empty `shapes` — a writer bug, but never worth throwing over)
 * is treated as the single shape its top-level `vertices`/`closed`
 * describe. Every consumer that iterates shapes goes through this so
 * pre-#686 docs keep rendering and measuring identically.
 */
export function docShapes(doc: SketchDoc): SketchShape[] {
  if (doc.shapes && doc.shapes.length > 0) return doc.shapes;
  return [{ vertices: doc.vertices, closed: doc.closed }];
}

/**
 * Build a document from a shape list, WRITING THE MIRROR INVARIANT: the
 * legacy top-level `vertices`/`closed` are set from `shapes[0]` so a
 * pre-#686 reader (older app build, the web viewer before it learns
 * `shapes`) still sees the first outline exactly as before. An empty
 * shape list normalizes to one empty open shape so the invariant always
 * has a `shapes[0]` to mirror.
 */
export function docFromShapes(
  pxPerFoot: number,
  shapes: SketchShape[],
  labels: SketchLabel[],
): SketchDoc {
  const list: SketchShape[] =
    shapes.length > 0 ? shapes : [{ vertices: [], closed: false }];
  return {
    version: 1,
    pxPerFoot,
    vertices: list[0].vertices,
    closed: list[0].closed,
    labels,
    shapes: list,
  };
}

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
 * The edges of one shape, in draw order. Consecutive vertices form the
 * open path; when `closed` (and there are ≥3 vertices) the closing edge
 * (last→first) is appended so the polygon reads as a loop. This is the
 * per-shape primitive (#686) — {@link segments} keeps the historic
 * doc-level signature by delegating with the legacy mirror fields.
 */
export function shapeSegments(
  shape: SketchShape,
  pxPerFoot: number,
): SketchSegment[] {
  const { vertices } = shape;
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
  if (shape.closed && vertices.length >= 3) {
    out.push(mk(vertices[vertices.length - 1], vertices[0]));
  }
  return out;
}

/**
 * The edges of the doc's FIRST shape (the legacy mirror), in draw
 * order. Pre-#686 callers measured "the" outline through this; it now
 * reads `shapes[0]` via the mirror invariant, so its meaning is
 * unchanged for every doc that existed before multi-shape.
 */
export function segments(doc: SketchDoc): SketchSegment[] {
  return shapeSegments(
    { vertices: doc.vertices, closed: doc.closed },
    doc.pxPerFoot,
  );
}

/**
 * Total length of one shape's edges, in feet. For an open path this is
 * the traced distance; for a closed shape it is the polygon perimeter
 * (the closing edge is included via {@link shapeSegments}).
 */
export function shapePerimeterFeet(
  shape: SketchShape,
  pxPerFoot: number,
): number {
  return shapeSegments(shape, pxPerFoot).reduce((sum, s) => sum + s.feet, 0);
}

/**
 * Perimeter of the doc's FIRST shape (legacy mirror) — see
 * {@link segments} for why the doc-level signature survives.
 */
export function perimeterFeet(doc: SketchDoc): number {
  return shapePerimeterFeet(
    { vertices: doc.vertices, closed: doc.closed },
    doc.pxPerFoot,
  );
}

/**
 * Enclosed area of one shape in square feet via the shoelace
 * (surveyor's) formula, converted to feet² by dividing the pixel area
 * by pxPerFoot². Only meaningful for a CLOSED polygon of ≥3 vertices;
 * returns 0 otherwise (or when uncalibrated). The absolute value is
 * taken so winding order (clockwise vs counter-clockwise) doesn't flip
 * the sign.
 */
export function shapeAreaSquareFeet(
  shape: SketchShape,
  pxPerFoot: number,
): number {
  const { vertices } = shape;
  if (!shape.closed || vertices.length < 3 || pxPerFoot <= 0) return 0;
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
 * Area of the doc's FIRST shape (legacy mirror) — see {@link segments}
 * for why the doc-level signature survives.
 */
export function areaSquareFeet(doc: SketchDoc): number {
  return shapeAreaSquareFeet(
    { vertices: doc.vertices, closed: doc.closed },
    doc.pxPerFoot,
  );
}

/**
 * Centroid of a polygon's vertices (canvas px) — where the editor
 * anchors a closed shape's on-canvas area caption (#686), so "House
 * 1,240 sq ft" sits INSIDE the house, not at some corner. Uses the
 * standard area-weighted polygon centroid; for a degenerate polygon
 * (near-zero area — collinear points, a 2-vertex "shape") it falls back
 * to the plain vertex mean, which is still a sensible label anchor.
 * Returns null only when there are no vertices at all.
 */
export function shapeCentroid(vertices: SketchVertex[]): SketchVertex | null {
  const n = vertices.length;
  if (n === 0) return null;
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(twiceArea) <= GEOM_EPS) {
    let sx = 0;
    let sy = 0;
    for (const p of vertices) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / n, y: sy / n };
  }
  return { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) };
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

/** An empty document (one empty open shape) calibrated at `pxPerFoot`. */
export function emptyDoc(pxPerFoot: number): SketchDoc {
  return docFromShapes(pxPerFoot, [], []);
}

/**
 * Rescale a document's pixel space by `factor` about the origin (0,0):
 * every vertex and label coordinate — across EVERY shape (#686) — is
 * multiplied by `factor`, and so is `pxPerFoot`. Because both the pixel
 * geometry AND the calibration scale together, every real-world
 * measurement (segment feet, perimeter, area) is INVARIANT — this is
 * how the editor recalibrates when the user changes grid density or
 * drawing scale after drawing: a 20 ft wall stays a 20 ft wall, in the
 * garage as much as in the house.
 *
 * A non-finite, non-positive, or identity factor returns the document
 * unchanged (same reference) so callers can apply it unconditionally.
 * A legacy doc (no `shapes` key) stays legacy — rescaling never
 * invents the key, so shape identity is preserved for callers that
 * compare before/after.
 */
export function rescaleDoc(doc: SketchDoc, factor: number): SketchDoc {
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return doc;
  const scaleV = (p: SketchVertex): SketchVertex => ({
    x: p.x * factor,
    y: p.y * factor,
  });
  const out: SketchDoc = {
    ...doc,
    pxPerFoot: doc.pxPerFoot * factor,
    vertices: doc.vertices.map(scaleV),
    labels: doc.labels.map((l) => ({ ...l, x: l.x * factor, y: l.y * factor })),
  };
  if (doc.shapes) {
    out.shapes = doc.shapes.map((s) => ({
      closed: s.closed,
      vertices: s.vertices.map(scaleV),
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Start-point snapping (#711 part 3)
// ---------------------------------------------------------------------------

/**
 * What a resolved placement snapped to, in priority order: an existing
 * vertex beats a point on a wall segment beats a grid intersection
 * beats nothing. The editor keys its highlight-ring feedback off this.
 */
export type SnapKind = 'vertex' | 'segment' | 'grid' | 'none';

/** A resolved placement: the (possibly moved) point + what it snapped to. */
export type SnapResult = { point: SketchVertex; kind: SnapKind };

/**
 * Nearest point ON the segment a→b to `p` — the perpendicular
 * projection, clamped to the segment's endpoints (a degenerate zero-
 * length segment returns `a`). Pure geometry; the wall-snap candidate
 * generator below runs it per edge.
 */
export function closestPointOnSegment(
  a: SketchVertex,
  b: SketchVertex,
  p: SketchVertex,
): SketchVertex {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq <= GEOM_EPS) return { x: a.x, y: a.y };
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq),
  );
  return { x: a.x + t * abx, y: a.y + t * aby };
}

/** `p` snapped to the nearest grid intersection at `spacing` px. */
export function snapToGrid(p: SketchVertex, spacing: number): SketchVertex {
  if (spacing <= 0) return p;
  return {
    x: Math.round(p.x / spacing) * spacing,
    y: Math.round(p.y / spacing) * spacing,
  };
}

/**
 * Resolve where a tapped point should actually land (#711 part 3):
 *
 *   1. The nearest existing vertex of ANY shape within
 *      `vertexTolerance` — continuing a wall from an existing corner is
 *      the common case when a new shape (a garage off the house) starts
 *      on existing geometry, so corners win over everything.
 *   2. Else the nearest point ON any wall segment (every shape's edges,
 *      including a closed shape's closing edge) within
 *      `segmentTolerance` — starting mid-wall is the next-most-likely
 *      intent.
 *   3. Else the grid intersection, when `gridSpacing` > 0 (the caller
 *      passes 0 when grid snap is off).
 *   4. Else the raw point, untouched.
 *
 * ALL tolerances are WORLD pixels. The editor works in screen dp, so it
 * converts before calling (tolerance_world = tolerance_dp / viewScale)
 * — a generous 24 dp fingertip stays 24 dp on screen at every zoom.
 *
 * `exclude` lists vertices that must NOT attract the point — the active
 * shape's current anchor (its last open vertex), or a snap there would
 * mint a zero-length wall. A segment candidate landing within
 * `vertexTolerance` of an excluded vertex is rejected for the same
 * reason (the edges touching the anchor pass right through it).
 * Matching is by exact coordinates, not reference, so callers can pass
 * values that survived a state-map clone.
 */
export function resolveSnapPoint(
  p: SketchVertex,
  shapes: SketchShape[],
  opts: {
    vertexTolerance: number;
    segmentTolerance: number;
    gridSpacing?: number;
    exclude?: SketchVertex[];
  },
): SnapResult {
  const excluded = (v: SketchVertex): boolean =>
    (opts.exclude ?? []).some((e) => e.x === v.x && e.y === v.y);

  // 1. Nearest non-excluded vertex of any shape within tolerance.
  if (opts.vertexTolerance > 0) {
    let best: SketchVertex | null = null;
    let bestDist = opts.vertexTolerance;
    for (const shape of shapes) {
      for (const v of shape.vertices) {
        if (excluded(v)) continue;
        const d = Math.hypot(v.x - p.x, v.y - p.y);
        if (d <= bestDist) {
          best = v;
          bestDist = d;
        }
      }
    }
    if (best) return { point: { x: best.x, y: best.y }, kind: 'vertex' };
  }

  // 2. Nearest on-segment projection within tolerance, across every
  // shape's edges (closing edge included for closed polygons).
  if (opts.segmentTolerance > 0) {
    let best: SketchVertex | null = null;
    let bestDist = opts.segmentTolerance;
    for (const shape of shapes) {
      const verts = shape.vertices;
      const edgeCount =
        verts.length - 1 + (shape.closed && verts.length >= 3 ? 1 : 0);
      for (let i = 0; i < edgeCount; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        const q = closestPointOnSegment(a, b, p);
        // A projection hugging an excluded vertex would still mint a
        // (near-)zero-length wall — reject it like the vertex itself.
        const nearExcluded = (opts.exclude ?? []).some(
          (e) => Math.hypot(e.x - q.x, e.y - q.y) <= opts.vertexTolerance,
        );
        if (nearExcluded) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d <= bestDist) {
          best = q;
          bestDist = d;
        }
      }
    }
    if (best) return { point: best, kind: 'segment' };
  }

  // 3. Grid, when the caller has snap-to-grid active.
  if (opts.gridSpacing && opts.gridSpacing > 0) {
    return { point: snapToGrid(p, opts.gridSpacing), kind: 'grid' };
  }

  return { point: p, kind: 'none' };
}

// ---------------------------------------------------------------------------
// Fit-to-content + dynamic zoom floor (#711 part 4)
// ---------------------------------------------------------------------------

/** A pan/zoom transform: screen = world * scale + (tx, ty). */
export type FitTransform = { tx: number; ty: number; scale: number };

/**
 * Fit-to-content transform: the bounding box of the given points
 * (every shape's vertices flattened, plus label anchors), padded
 * `padPx` screen px, scaled and centered into a w×h viewport. Scale is
 * capped at `maxScale` so a tiny sketch isn't blown up absurdly, but
 * has NO lower clamp — a building bigger than the viewport must shrink
 * to fit rather than crop. Returns null for an empty point set or a
 * degenerate viewport. Extracted from the editor (#711) so the dynamic
 * zoom floor below shares the exact fit math Save and Recenter use.
 */
export function fitTransformForContent(
  points: SketchVertex[],
  w: number,
  h: number,
  padPx: number,
  maxScale: number,
): FitTransform | null {
  if (w <= 0 || h <= 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return null; // no content
  const bw = Math.max(maxX - minX, 1); // guard zero-size bbox (one point)
  const bh = Math.max(maxY - minY, 1);
  const availW = Math.max(w - padPx * 2, 1);
  const availH = Math.max(h - padPx * 2, 1);
  const s = Math.min(availW / bw, availH / bh, maxScale);
  return {
    scale: s,
    tx: (w - bw * s) / 2 - minX * s,
    ty: (h - bh * s) / 2 - minY * s,
  };
}

/**
 * The zoom-out floor for the editor (#711 part 4): a FIXED minimum made
 * a large sketch un-viewable — fit-to-content can legitimately land
 * below it, and once there, pinch fought the clamp. The floor is
 * dynamic: low enough to zoom out to HALF the fit-all-content view
 * (breathing room around the whole drawing), but never above the
 * static minimum a small sketch has always had. Pass the current fit
 * transform's scale (null when the canvas is empty → the static floor).
 */
export function dynamicMinScale(
  fitScale: number | null,
  staticMin: number,
): number {
  if (fitScale == null || !Number.isFinite(fitScale) || fitScale <= 0) {
    return staticMin;
  }
  return Math.min(staticMin, fitScale * 0.5);
}

// ---------------------------------------------------------------------------
// Wire parsing (#711 part 2 — edit an existing capture's sketch)
// ---------------------------------------------------------------------------

/**
 * The `meta.sketch` object as the BACKEND stores and returns it —
 * snake_case, every field optional, passed through opaquely (the server
 * never validates the interior). The mobile in-memory model is
 * camelCase (`SketchMeta` in capture.ts); sync.ts translates outbound,
 * and {@link parseSketchVector} is the defensive inbound path.
 */
export type SketchMetaWire = {
  grid_size?: string;
  scale_feet_per_square?: number;
  snap_enabled?: boolean;
  gps?: {
    lat?: number;
    lng?: number;
    accuracy_m?: number;
    captured_at?: string;
  };
  heading_deg?: number;
  /** The vector doc — parse via {@link parseSketchVector}, never cast. */
  vector?: unknown;
};

/**
 * Defensive read of a capture's `meta.sketch.vector` from an untyped
 * value into a clean camelCase {@link SketchDoc} — THE inbound path for
 * re-opening a saved sketch (#711). Nothing upstream guarantees the
 * shape (the backend stores it opaquely), so every field the editor
 * depends on is validated; junk returns `null` (an old raster-only
 * sketch, a photo, corrupted data — a friendly not-editable, never a
 * crash). Accepts the wire's `px_per_foot` AND the local queue's
 * camelCase `pxPerFoot`, so one parser covers both sources. Size caps
 * mirror the web editor's: hasSelfIntersection is O(n²) per shape, so
 * a pathological doc must read as not-editable rather than freeze the
 * UI thread.
 */
export function parseSketchVector(value: unknown): SketchDoc | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return null;
  const ppf = v.px_per_foot ?? v.pxPerFoot;
  if (typeof ppf !== 'number' || !Number.isFinite(ppf) || ppf <= 0) {
    return null;
  }
  if (!Array.isArray(v.vertices) || !Array.isArray(v.labels)) return null;
  if (v.vertices.length > 2000 || v.labels.length > 500) return null;
  const readVertex = (raw: unknown): SketchVertex | null => {
    const q = raw as Record<string, unknown> | null;
    if (
      q == null ||
      typeof q.x !== 'number' ||
      typeof q.y !== 'number' ||
      !Number.isFinite(q.x) ||
      !Number.isFinite(q.y)
    ) {
      return null;
    }
    return { x: q.x, y: q.y };
  };
  const vertices: SketchVertex[] = [];
  for (const raw of v.vertices) {
    const p = readVertex(raw);
    if (!p) return null;
    vertices.push(p);
  }
  const labels: SketchLabel[] = [];
  for (const raw of v.labels) {
    const q = raw as Record<string, unknown> | null;
    const p = readVertex(raw);
    if (!p || typeof q?.text !== 'string') return null;
    labels.push({ x: p.x, y: p.y, text: q.text });
  }
  // #686: optional multi-shape array. Strict like everything else — a
  // malformed shapes entry means a corrupt doc, not a shrug (silently
  // dropping a garage on the next save would be data loss).
  let shapes: SketchShape[] | undefined;
  if (v.shapes !== undefined) {
    if (!Array.isArray(v.shapes) || v.shapes.length > 50) return null;
    let totalVerts = vertices.length;
    const parsed: SketchShape[] = [];
    for (const raw of v.shapes) {
      const sh = raw as Record<string, unknown> | null;
      if (sh == null || !Array.isArray(sh.vertices)) return null;
      const verts: SketchVertex[] = [];
      for (const pnt of sh.vertices) {
        const p = readVertex(pnt);
        if (!p) return null;
        verts.push(p);
      }
      totalVerts += verts.length;
      if (totalVerts > 4000) return null;
      parsed.push({ vertices: verts, closed: sh.closed === true });
    }
    if (parsed.length > 0) shapes = parsed;
  }
  return {
    version: 1,
    pxPerFoot: ppf,
    vertices,
    labels,
    closed: v.closed === true,
    ...(shapes ? { shapes } : {}),
  };
}

/** Tolerance for the orientation / bounding-box predicates below. */
const GEOM_EPS = 1e-9;

/**
 * Orientation of the ordered triplet (a, b, c) via the cross product of
 * ab × ac: +1 / −1 for the two turn directions, 0 for (near-)collinear.
 */
function orientation(a: SketchVertex, b: SketchVertex, c: SketchVertex): number {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(v) <= GEOM_EPS) return 0;
  return v > 0 ? 1 : -1;
}

/** Whether p (known collinear with a–b) lies within a–b's bounding box. */
function onSegment(a: SketchVertex, b: SketchVertex, p: SketchVertex): boolean {
  return (
    Math.min(a.x, b.x) - GEOM_EPS <= p.x &&
    p.x <= Math.max(a.x, b.x) + GEOM_EPS &&
    Math.min(a.y, b.y) - GEOM_EPS <= p.y &&
    p.y <= Math.max(a.y, b.y) + GEOM_EPS
  );
}

/**
 * Standard segment-pair intersection test (orientation predicate plus
 * collinear on-segment checks): true when p1–p2 and p3–p4 share any
 * point, whether a proper crossing or a collinear overlap/touch.
 */
function segmentsIntersect(
  p1: SketchVertex,
  p2: SketchVertex,
  p3: SketchVertex,
  p4: SketchVertex,
): boolean {
  const d1 = orientation(p3, p4, p1);
  const d2 = orientation(p3, p4, p2);
  const d3 = orientation(p1, p2, p3);
  const d4 = orientation(p1, p2, p4);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true; // proper crossing
  }
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

/**
 * Whether the polyline (or, when `closed`, the polygon including the
 * closing edge last→first) intersects itself. A self-intersecting
 * outline makes the shoelace area silently wrong (a bowtie "encloses"
 * far less than the formula reports), so the editor uses this to warn
 * instead of showing a bogus square-footage. Applies PER SHAPE (#686):
 * pass one shape's vertices at a time — two different shapes may
 * legitimately overlap (a deck tucked against the house), so cross-shape
 * intersection is deliberately not a defect.
 *
 * O(n²) over all NON-ADJACENT edge pairs — edges that share a vertex
 * (consecutive edges, and the closing edge with the first/last edge)
 * legitimately touch at that vertex and are skipped. Touches or overlaps
 * between non-adjacent edges DO count: an outline that revisits an
 * earlier wall is a defect the appraiser needs to see.
 */
export function hasSelfIntersection(
  vertices: SketchVertex[],
  closed: boolean,
): boolean {
  const n = vertices.length;
  // Edges as index pairs so adjacency is exact (shared VERTEX INDEX),
  // immune to coincidentally-equal coordinates elsewhere in the path.
  const edges: [number, number][] = [];
  for (let i = 0; i < n - 1; i++) edges.push([i, i + 1]);
  if (closed && n >= 3) edges.push([n - 1, 0]);
  for (let a = 0; a < edges.length; a++) {
    for (let b = a + 1; b < edges.length; b++) {
      const [i1, i2] = edges[a];
      const [j1, j2] = edges[b];
      if (i1 === j1 || i1 === j2 || i2 === j1 || i2 === j2) continue;
      if (
        segmentsIntersect(vertices[i1], vertices[i2], vertices[j1], vertices[j2])
      ) {
        return true;
      }
    }
  }
  return false;
}
