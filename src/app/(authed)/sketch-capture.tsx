/**
 * Vector floor-plan editor (#666, SLICE 1; multi-shape UX overhaul #686)
 * — replaces the old freehand raster sketch tool. The appraiser draws
 * real polylines/polygons whose vertices, labels, and pxPerFoot
 * calibration are kept as DATA (`SketchDoc`), so segment lengths +
 * enclosed area are computed exactly and the sketch is re-editable
 * later. The old tool rasterized to a PNG and threw the geometry away —
 * you couldn't measure or edit it.
 *
 * What's on the surface:
 *   - Draw mode: TAP the canvas to drop the next vertex, connected to
 *     the last (a continuous wall). Snap-to-grid (existing toggle) snaps
 *     added vertices to grid intersections.
 *   - MULTIPLE SHAPES (#686): a sketch is a house AND a garage AND a
 *     deck. Once the active shape is closed, the next tap in Draw mode
 *     starts a brand-new outline at the tap point — which is also how
 *     the "pen" gets relocated. All editing (tap, keypad, Close shape,
 *     Undo) targets the ACTIVE shape — always the last one started.
 *   - Precise entry: a distance field + 8-direction pad, now a
 *     COLLAPSIBLE overlay (keypad button in the toolbar) instead of a
 *     persistent block that ate a third of the screen. Type feet, tap a
 *     SCREEN-relative arrow (up = screen-up, NOT compass north) and the
 *     next vertex lands exactly that far away — how appraisers pace a
 *     perimeter. Diagonals move the entered distance along the
 *     hypotenuse (see endpointOffset).
 *   - Live dimensions: each segment's length renders at its midpoint;
 *     each CLOSED shape's area renders at its centroid (#686), so every
 *     outbuilding reads its own square footage at a glance.
 *   - Close shape: a contextual pill over the canvas (appears once the
 *     active shape has ≥3 points) connects last→first; the readout
 *     shows the ACTIVE shape's area + perimeter.
 *   - Pan mode: one-finger drag pans. Pinch (two fingers) zooms AND
 *     pans — the live focal point stays glued to the same world point —
 *     and is ALSO enabled in Draw mode, so two-finger navigation works
 *     while drawing (standard sketch-app feel). Taps in Pan mode do NOT
 *     add vertices, and a tap fails the moment a second finger lands so
 *     a pinch can never drop a stray vertex. A screen tap in Draw mode
 *     is mapped back through the pan/zoom transform to canvas (world)
 *     coords before placement.
 *   - Recenter (#686): a round button overlaid bottom-right of the
 *     canvas snaps the view to fit EVERYTHING (all shapes + labels) —
 *     the same fit math the Save rasterization uses — so a lost
 *     appraiser is one tap from seeing the whole drawing.
 *   - Undo (vertex / label / close / shape-start, in order) + Clear
 *     (confirm; resets the save identity — Clear starts a NEW document).
 *     Undoing the FIRST vertex of a later shape removes that shape;
 *     undoing a close reopens THAT shape (and restores the duplicate
 *     end vertex the close dropped, if any).
 *   - Label tool: tap a spot, enter text, drop a floating label. Labels
 *     are one document-wide pool (position-anchored), not per-shape.
 *   - Settings sheet (#686): grid density, drawing scale, snap, and the
 *     GPS site pin moved OFF the top chrome into a bottom-sheet modal
 *     behind a gear button — they were eating a third of the vertical
 *     space the canvas needs in the field. The calibration invariant is
 *     untouched; the sheet only relocates the controls.
 *   - Save in place: rasterize to PNG (react-native-view-shot) +
 *     enqueue like any capture, AND persist the full SketchDoc on
 *     meta.sketch.vector so it round-trips. Stays on the canvas. The
 *     capture is fit-to-content over ALL shapes (never the cropped live
 *     viewport), and each RE-save enqueues a brand-new capture id that
 *     SUPERSEDES the previous one — the backend is idempotent on
 *     (tenant, client_id), so re-posting the same id would silently
 *     keep the OLD bytes.
 *
 * Calibration model (real feet are INVARIANT): `pxPerFoot` is stable
 * state, calibrated from grid spacing ÷ feet-per-square. When the user
 * changes grid density or scale after drawing, all stored geometry —
 * every shape and every label — is rescaled about the origin by
 * (new/old) so every wall keeps its FEET value; turning the grid Off
 * changes visibility only (the last calibration is kept) — measurements
 * never move.
 *
 * Wire compatibility (#686): the saved doc carries `shapes` (all
 * outlines) while the legacy top-level `vertices`/`closed` keep
 * mirroring `shapes[0]` (see docFromShapes) — the meta only ever GAINS
 * keys, so pre-#686 readers still see the first outline unchanged.
 *
 * Coordinate model: vertices live in CANVAS (world) pixels. The SVG
 * content group is drawn with transform `translate(tx,ty) scale(s)`, so
 * screen = world*s + t and world = (screen - t)/s. Stroke widths + font
 * sizes inside the group are divided by `s` so they stay a constant
 * on-screen size regardless of zoom.
 */

import { Ionicons } from '@react-native-vector-icons/ionicons/static';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import {
  type ComponentProps,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  LayoutChangeEvent,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';

import { Brand, Radius, Spacing } from '@/constants/theme';
import { deleteCapture } from '@/lib/api';
import { pickAssignment } from '@/lib/assignment-picker';
import {
  type CaptureMeta,
  getCurrentGeo,
  newCaptureId,
  type SketchGridSize,
  type SketchMeta,
} from '@/lib/capture';
import { enqueue, loadQueue, removeItem } from '@/lib/queue';
import {
  type Dir8,
  docFromShapes,
  docShapes,
  endpointOffset,
  hasSelfIntersection,
  pxPerFootFromGrid,
  rescaleDoc,
  shapeAreaSquareFeet,
  shapeCentroid,
  shapeSegments,
  type SketchLabel,
  type SketchShape,
  type SketchVertex,
} from '@/lib/sketch-model';
import { syncNow } from '@/lib/sync';
import { sealCaptureFile } from '@/lib/vault';

/** Editor interaction mode. */
type Mode = 'draw' | 'pan' | 'label';

/** The pan/zoom transform applied to the SVG content group. */
type Transform = { tx: number; ty: number; scale: number };

/**
 * One undoable action, newest last — lets Undo remove in insert order.
 * Shape-aware since #686:
 *   - 'v'  vertex appended to the ACTIVE (last) shape. Undo removes the
 *          last shape's last vertex — safe because vertices can only
 *          ever be appended to the last shape, so unwinding in reverse
 *          order always lands on the shape the vertex was added to.
 *   - 'ns' a NEW shape was started (its first vertex included). Undo
 *          removes the whole one-point shape — "undoing the first
 *          vertex of a later shape removes that shape".
 *   - 'l'  label added. Undo removes the last label.
 *   - 'c'  shape `shape` was closed. Undo reopens THAT shape (recorded
 *          by index — indexes are stable because shapes are only ever
 *          pushed/popped at the end) and restores the duplicate end
 *          vertex the close dropped, if any (a paced perimeter often
 *          lands exactly on the start point).
 */
type Action =
  | { t: 'v' } // vertex added to the active shape
  | { t: 'ns' } // new shape started with its first vertex
  | { t: 'l' } // label added
  | { t: 'c'; shape: number; dropped?: SketchVertex }; // shape closed

/** On-screen pixel spacing per grid density. 'off' → no grid drawn. */
const GRID_SPACING: Record<SketchGridSize, number> = {
  off: 0,
  fine: 16,
  medium: 24,
  coarse: 40,
};

const GRID_OPTIONS: { label: string; value: SketchGridSize }[] = [
  { label: 'Off', value: 'off' },
  { label: 'Fine', value: 'fine' },
  { label: 'Med', value: 'medium' },
  { label: 'Coarse', value: 'coarse' },
];

const SCALE_OPTIONS: { label: string; value: number }[] = [
  { label: '1 ft', value: 1 },
  { label: '2 ft', value: 2 },
  { label: '5 ft', value: 5 },
];

type IoniconName = ComponentProps<typeof Ionicons>['name'];

/**
 * Mode control as an icon segmented control (#686): with the toolbar
 * collapsed to ONE slim row, text labels ("Pan/Zoom") no longer fit
 * next to five tool buttons on a 360 dp phone — icons + accessibility
 * labels keep every target ≥40 dp without wrapping.
 */
const MODE_OPTIONS: { value: Mode; icon: IoniconName; a11y: string }[] = [
  { value: 'draw', icon: 'pencil', a11y: 'Draw mode' },
  { value: 'pan', icon: 'move', a11y: 'Pan and zoom mode' },
  { value: 'label', icon: 'text', a11y: 'Label mode' },
];

const STROKE_COLOR = Brand.navyDeep;
const STROKE_WIDTH = 3;
const GRID_COLOR = '#e2ddcc';
const FILL_COLOR = 'rgba(15,29,58,0.06)';
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
/** Cap grid line count when zoomed way out so we never draw thousands. */
const MAX_GRID_LINES = 400;

/** Screen-relative arrow glyphs for the 8-direction precise-entry pad. */
const ARROW_GLYPH: Record<Dir8, string> = {
  up: '↑',
  'up-right': '↗',
  right: '→',
  'down-right': '↘',
  down: '↓',
  'down-left': '↙',
  left: '←',
  'up-left': '↖',
};

/** A fresh single empty shape — the editor's blank-document state. */
function freshShapes(): SketchShape[] {
  return [{ vertices: [], closed: false }];
}

function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(s, MAX_SCALE));
}

/** SVG path `d` for one polyline; appends `Z` when the shape is closed. */
function polylineD(verts: SketchVertex[], closed: boolean): string {
  if (verts.length === 0) return '';
  let d = `M ${verts[0].x.toFixed(2)} ${verts[0].y.toFixed(2)}`;
  for (let i = 1; i < verts.length; i++) {
    d += ` L ${verts[i].x.toFixed(2)} ${verts[i].y.toFixed(2)}`;
  }
  if (closed && verts.length >= 3) d += ' Z';
  return d;
}

/**
 * Visible world region snapped OUTWARD to whole grid cells. Snapping the
 * bounds means the values only change when the view crosses a cell
 * boundary (or zooms), so the memoized grid-line subtree keyed on them
 * survives per-frame pan updates untouched.
 */
function gridBoundsFor(
  spacing: number,
  t: Transform,
  w: number,
  h: number,
): { left: number; right: number; top: number; bottom: number } | null {
  if (spacing <= 0 || w <= 0 || h <= 0 || t.scale <= 0) return null;
  return {
    left: Math.floor((0 - t.tx) / t.scale / spacing) * spacing,
    right: Math.ceil((w - t.tx) / t.scale / spacing) * spacing,
    top: Math.floor((0 - t.ty) / t.scale / spacing) * spacing,
    bottom: Math.ceil((h - t.ty) / t.scale / spacing) * spacing,
  };
}

/**
 * Fit-to-content transform: the bounding box of the given points (pass
 * EVERY shape's vertices flattened, plus label anchors — #686), padded
 * ~24 screen px, scaled and centered into the canvas. Shared by the
 * Save rasterization (saving the as-displayed viewport cropped or
 * blanked whatever the user had panned/zoomed away from) and the
 * Recenter button (#686), so "what recenter shows" and "what save
 * captures" can never disagree. Scale is capped at MAX_SCALE so a tiny
 * sketch isn't blown up absurdly, but has NO lower clamp — a building
 * bigger than the viewport must shrink to fit rather than crop.
 */
function fitTransformForCapture(
  vertices: SketchVertex[],
  labels: SketchLabel[],
  w: number,
  h: number,
): Transform | null {
  if (w <= 0 || h <= 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of [...vertices, ...labels]) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return null; // no content
  const pad = 24;
  const bw = Math.max(maxX - minX, 1); // guard zero-size bbox (one point)
  const bh = Math.max(maxY - minY, 1);
  const availW = Math.max(w - pad * 2, 1);
  const availH = Math.max(h - pad * 2, 1);
  const s = Math.min(availW / bw, availH / bh, MAX_SCALE);
  return {
    scale: s,
    tx: (w - bw * s) / 2 - minX * s,
    ty: (h - bh * s) / 2 - minY * s,
  };
}

/**
 * Distance-entry validation: trims, accepts a decimal comma ("20,5" —
 * many locales' decimal pads type it), and requires the WHOLE string to
 * be a plain positive decimal. `parseFloat` alone silently truncates
 * ("20,5" → 20), which turned locale input into wrong walls.
 */
function parseDistanceFeet(text: string): number | null {
  const normalized = text.trim().replace(',', '.');
  if (!/^\d*\.?\d+$/.test(normalized)) return null;
  const feet = parseFloat(normalized);
  return Number.isFinite(feet) && feet > 0 ? feet : null;
}

/** Compact segmented control shared by the grid / scale pickers. */
function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segment}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            style={[styles.segmentItem, active && styles.segmentItemActive]}
            onPress={() => onChange(o.value)}
          >
            <Text
              style={[styles.segmentLabel, active && styles.segmentLabelActive]}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** One slim icon button in the bottom toolbar (#686). */
function ToolIcon({
  icon,
  a11y,
  onPress,
  disabled,
  active,
}: {
  icon: IoniconName;
  a11y: string;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={a11y}
      style={({ pressed }) => [
        styles.iconBtn,
        active && styles.iconBtnActive,
        disabled && styles.iconBtnDisabled,
        pressed && !disabled && styles.iconBtnPressed,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Ionicons
        name={icon}
        size={20}
        color={active ? Brand.cream : Brand.navyDeep}
      />
    </Pressable>
  );
}

export default function SketchCaptureScreen() {
  const router = useRouter();
  const canvasRef = useRef<View>(null);

  // --- Vector document state (#686: a LIST of shapes, active = last) ---
  const [shapes, setShapes] = useState<SketchShape[]>(freshShapes);
  const [labels, setLabels] = useState<SketchLabel[]>([]);
  const [history, setHistory] = useState<Action[]>([]);

  // --- Editor UI state ---
  const [mode, setMode] = useState<Mode>('draw');
  const [distanceText, setDistanceText] = useState('');
  // Collapsible precise-entry pad + settings sheet (#686): both default
  // hidden so the canvas owns the reclaimed vertical space.
  const [padOpen, setPadOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [transform, setTransform] = useState<Transform>({
    tx: 0,
    ty: 0,
    scale: 1,
  });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [busy, setBusy] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  // Android inline-label draft (iOS uses Alert.prompt).
  const [labelDraft, setLabelDraft] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);

  // First save picks the assignment + mints the capture id; every later
  // save mints a FRESH id that supersedes the previous one (same
  // assignment, no re-pick) — see onSave for why update-in-place loses
  // data against the backend's client_id idempotency. Clear resets both.
  const savedIdRef = useRef<string | null>(null);
  const savedAssignmentIdRef = useRef<string | null>(null);

  // --- Carried-over controls (grid / scale / snap / GPS / heading) ---
  const [gridSize, setGridSize] = useState<SketchGridSize>('medium');
  const [scaleFeet, setScaleFeet] = useState<number>(1);
  // CALIBRATION is stable state, NOT derived from the live grid/scale UI.
  // Deriving it made every measurement mutate when the user touched the
  // controls after drawing (Scale 1→5 turned 20 ft walls into 100 ft;
  // Grid→Off snapped calibration to a nominal fallback). Initialized from
  // the same defaults as the two states above; changed ONLY through
  // applyCalibration below, which rescales the stored geometry so real
  // feet stay invariant.
  const [pxPerFoot, setPxPerFoot] = useState<number>(() =>
    pxPerFootFromGrid(GRID_SPACING.medium, 1),
  );
  // Last VISIBLE grid spacing used to calibrate — kept when the grid is
  // switched Off (visibility only), reused when Scale changes while Off.
  const lastCalibratedSpacingRef = useRef<number>(GRID_SPACING.medium);
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [pinnedGeo, setPinnedGeo] =
    useState<NonNullable<CaptureMeta['geo']> | null>(null);
  const [pinnedAt, setPinnedAt] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const [locationNote, setLocationNote] = useState<string | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const headingSubRef =
    useRef<Awaited<ReturnType<typeof Location.watchHeadingAsync>> | null>(null);
  const lastHeadingRef = useRef<number | null>(null);

  const spacing = GRID_SPACING[gridSize];
  const snapActive = snapEnabled && spacing > 0;

  // The ACTIVE shape is always the LAST one — new shapes are appended,
  // and Undo pops them, so "last" is also "most recently worked on".
  const activeIndex = shapes.length - 1;
  const activeShape = shapes[activeIndex];

  // Every vertex across every shape — the bound for fit-to-content
  // (recenter + save) and the auto-pan count gate.
  const allVertices = useMemo(() => shapes.flatMap((s) => s.vertices), [shapes]);

  // Per-shape render/measure data, memoized apart from the transform so
  // per-frame pan/zoom updates don't re-derive geometry. `crossed`
  // guards the shoelace area per shape: a self-intersecting outline
  // "encloses" less than the formula says, so its centroid caption
  // warns instead of showing a bogus square footage.
  const shapeRender = useMemo(
    () =>
      shapes.map((s) => {
        const segs = shapeSegments(s, pxPerFoot);
        return {
          d: polylineD(s.vertices, s.closed),
          segs,
          segLabels: segs.map((x) => `${x.feet.toFixed(1)}'`),
          perimeter: segs.reduce((sum, x) => sum + x.feet, 0),
          area: shapeAreaSquareFeet(s, pxPerFoot),
          crossed: s.closed && hasSelfIntersection(s.vertices, true),
          centroid: s.closed ? shapeCentroid(s.vertices) : null,
        };
      }),
    [shapes, pxPerFoot],
  );
  const activeRender = shapeRender[activeIndex];
  const hasContent = allVertices.length > 0 || labels.length > 0;

  /**
   * Recalibrate to (spacingPx, feetPerSquare), keeping real-world feet
   * INVARIANT: all stored geometry — EVERY shape and label — is rescaled
   * about the origin by (new/old) via rescaleDoc, so every segment keeps
   * its feet value and snapped points land on the rescaled grid.
   */
  const applyCalibration = useCallback(
    (spacingPx: number, feetPerSquare: number) => {
      const next = pxPerFootFromGrid(spacingPx, feetPerSquare);
      if (next <= 0 || next === pxPerFoot) return;
      if (pxPerFoot > 0 && hasContent) {
        const factor = next / pxPerFoot;
        const rescaled = rescaleDoc(
          docFromShapes(pxPerFoot, shapes, labels),
          factor,
        );
        setShapes(docShapes(rescaled));
        setLabels(rescaled.labels);
        // The undo history's `dropped` close-vertices are WORLD
        // coordinates in the old pixel space — move them by the same
        // factor, or undoing a close after a grid/scale change restores
        // the vertex at its stale position and bends the wall (review
        // catch; same invariant as the geometry above).
        setHistory((h) =>
          h.map((a) =>
            a.t === 'c' && a.dropped
              ? {
                  ...a,
                  dropped: {
                    x: a.dropped.x * factor,
                    y: a.dropped.y * factor,
                  },
                }
              : a,
          ),
        );
        // A pending label draft anchor is world-space too.
        setLabelDraft((d) =>
          d ? { ...d, x: d.x * factor, y: d.y * factor } : d,
        );
      }
      setPxPerFoot(next);
    },
    [pxPerFoot, shapes, labels, hasContent],
  );

  const onGridSizeChange = useCallback(
    (g: SketchGridSize) => {
      const sp = GRID_SPACING[g];
      if (sp > 0) {
        applyCalibration(sp, scaleFeet);
        lastCalibratedSpacingRef.current = sp;
      }
      // Grid 'off' is a VISIBILITY change only — calibration keeps the
      // last spacing, so measurements never move.
      setGridSize(g);
    },
    [applyCalibration, scaleFeet],
  );

  const onScaleFeetChange = useCallback(
    (f: number) => {
      applyCalibration(lastCalibratedSpacingRef.current, f);
      setScaleFeet(f);
    },
    [applyCalibration],
  );

  const onCanvasLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ w: width, h: height });
  }, []);

  // --- Compass heading (carried over from #655) ---
  const startHeading = useCallback(async () => {
    if (headingSubRef.current) return;
    try {
      headingSubRef.current = await Location.watchHeadingAsync((h) => {
        const deg =
          h.trueHeading != null && h.trueHeading >= 0
            ? h.trueHeading
            : h.magHeading;
        if (typeof deg !== 'number' || Number.isNaN(deg) || deg < 0) return;
        const last = lastHeadingRef.current;
        if (last != null && Math.abs(deg - last) < 2) return;
        lastHeadingRef.current = deg;
        setHeading(deg);
      });
    } catch {
      headingSubRef.current = null;
    }
  }, []);

  useEffect(() => {
    void startHeading();
    return () => {
      headingSubRef.current?.remove();
      headingSubRef.current = null;
    };
  }, [startHeading]);

  // --- Coordinate helpers (rebuilt each render → current transform) ---
  const screenToWorld = (sx: number, sy: number): SketchVertex => ({
    x: (sx - transform.tx) / transform.scale,
    y: (sy - transform.ty) / transform.scale,
  });
  const snapWorld = (p: SketchVertex): SketchVertex =>
    snapActive
      ? {
          x: Math.round(p.x / spacing) * spacing,
          y: Math.round(p.y / spacing) * spacing,
        }
      : p;

  // --- Mutations (all target the ACTIVE = last shape) ---
  const addVertexWorld = useCallback((p: SketchVertex) => {
    setShapes((ss) =>
      ss.map((s, i) =>
        i === ss.length - 1 ? { ...s, vertices: [...s.vertices, p] } : s,
      ),
    );
    setHistory((h) => [...h, { t: 'v' }]);
    void Haptics.selectionAsync();
  }, []);

  /** Start a brand-new shape whose first vertex is `p` (#686). */
  const startShapeWorld = useCallback((p: SketchVertex) => {
    setShapes((ss) => [...ss, { vertices: [p], closed: false }]);
    setHistory((h) => [...h, { t: 'ns' }]);
    void Haptics.selectionAsync();
  }, []);

  const addLabel = useCallback((l: SketchLabel) => {
    setLabels((ls) => [...ls, l]);
    setHistory((h) => [...h, { t: 'l' }]);
    setMode('draw');
    void Haptics.selectionAsync();
  }, []);

  /**
   * Keep a just-placed world point on screen: if it falls outside the
   * visible canvas (40 px margin) under the current transform, pan —
   * never zoom — so arrow-paced walls can't walk off-screen.
   */
  const ensureVisibleWorldPoint = useCallback(
    (p: SketchVertex) => {
      if (size.w <= 0 || size.h <= 0) return;
      const margin = 40;
      setTransform((t) => {
        const sx = p.x * t.scale + t.tx;
        const sy = p.y * t.scale + t.ty;
        let tx = t.tx;
        let ty = t.ty;
        if (sx < margin) tx += margin - sx;
        else if (sx > size.w - margin) tx -= sx - (size.w - margin);
        if (sy < margin) ty += margin - sy;
        else if (sy > size.h - margin) ty -= sy - (size.h - margin);
        return tx === t.tx && ty === t.ty ? t : { ...t, tx, ty };
      });
    },
    [size.w, size.h],
  );

  // Auto-pan to the newest vertex whenever one is ADDED (arrow pacing,
  // tap, or a new shape's first point). Runs on committed state so it
  // composes with the functional setShapes updaters; count-gated across
  // ALL shapes; undoing a close CAN grow the total by restoring the
  // dropped duplicate vertex (harmless — it pans to the restored point);
  // pan. The flattened list's LAST element is always the just-added
  // vertex: vertices are only ever appended to the LAST shape, and
  // allVertices flattens in shape order.
  const prevVertexCountRef = useRef(0);
  useEffect(() => {
    const prev = prevVertexCountRef.current;
    prevVertexCountRef.current = allVertices.length;
    if (allVertices.length > prev && allVertices.length > 0) {
      ensureVisibleWorldPoint(allVertices[allVertices.length - 1]);
    }
  }, [allVertices, ensureVisibleWorldPoint]);

  const promptForLabel = useCallback(
    (world: SketchVertex) => {
      if (Platform.OS === 'ios' && typeof Alert.prompt === 'function') {
        Alert.prompt('Add label', 'Text for this label', (text) => {
          const t = (text ?? '').trim();
          if (t) addLabel({ x: world.x, y: world.y, text: t });
          else setMode('draw');
        });
      } else {
        // Android / fallback: inline TextInput card over the canvas.
        setLabelDraft({ x: world.x, y: world.y, text: '' });
      }
    },
    [addLabel],
  );

  const onCanvasTap = useCallback(
    (sx: number, sy: number) => {
      // Never let the decimal pad sit over the canvas while drawing.
      Keyboard.dismiss();
      if (busy) return;
      const world = screenToWorld(sx, sy);
      if (mode === 'label') {
        promptForLabel(world);
        return;
      }
      // Draw mode. A closed active shape means the pen is UP — the next
      // tap relocates it by starting a NEW outline right there (#686),
      // instead of the old dead-end where taps were ignored until Undo.
      if (activeShape.closed) {
        startShapeWorld(snapWorld(world));
        return;
      }
      addVertexWorld(snapWorld(world));
    },
    // screenToWorld / snapWorld read transform/snap from the current
    // render closure; listing the primitives keeps them fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, mode, activeShape.closed, transform, snapActive, spacing, promptForLabel, addVertexWorld, startShapeWorld],
  );

  const onArrow = useCallback(
    (dir: Dir8) => {
      // Never let the decimal pad sit over the canvas while pacing.
      Keyboard.dismiss();
      if (busy) return;
      if (activeShape.closed) {
        // The pad extends the ACTIVE shape; a closed one can't extend.
        // The tap gesture is the designated way to place the next
        // shape's start point, so point the appraiser there.
        Alert.alert(
          'Shape is closed',
          'Tap the canvas to start the next shape, or Undo to reopen this one.',
        );
        return;
      }
      const feet = parseDistanceFeet(distanceText);
      if (feet == null) {
        Alert.alert(
          'Enter a distance',
          'Type a distance in feet — like 20 or 20.5 — then tap a direction arrow.',
        );
        return;
      }
      const { dx, dy } = endpointOffset(dir, feet, pxPerFoot);
      if (activeShape.vertices.length === 0) {
        // Empty active shape (a fresh document / after Clear): seed the
        // run at the center of the current view, then step off.
        const startWorld = screenToWorld(
          (size.w || 0) / 2,
          (size.h || 0) / 2,
        );
        const start = snapWorld(startWorld);
        setShapes((ss) =>
          ss.map((s, i) =>
            i === ss.length - 1
              ? { ...s, vertices: [start, { x: start.x + dx, y: start.y + dy }] }
              : s,
          ),
        );
        setHistory((h) => [...h, { t: 'v' }, { t: 'v' }]);
      } else {
        // Read the anchor INSIDE the functional updater — a closure-
        // captured `last` goes stale when arrows land faster than React
        // re-renders, silently anchoring a wall to the wrong point.
        setShapes((ss) =>
          ss.map((s, i) => {
            if (i !== ss.length - 1) return s;
            const last = s.vertices[s.vertices.length - 1];
            return {
              ...s,
              vertices: [...s.vertices, { x: last.x + dx, y: last.y + dy }],
            };
          }),
        );
        setHistory((h) => [...h, { t: 'v' }]);
      }
      void Haptics.selectionAsync();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, activeShape.closed, activeShape.vertices.length, distanceText, pxPerFoot, size, transform, snapActive, spacing],
  );

  const onCloseShape = useCallback(() => {
    if (busy || activeShape.closed) return;
    if (activeShape.vertices.length < 3) {
      Alert.alert(
        'Add more points',
        'A closed shape needs at least 3 points before it encloses an area.',
      );
      return;
    }
    // A paced perimeter often lands the last point exactly on the first;
    // closing then would draw a stray 0.0' edge. Drop the duplicate
    // (within 0.5 px) before closing — only when ≥4 vertices so a real
    // polygon remains — and remember it in history so Undo restores it.
    const verts = activeShape.vertices;
    const first = verts[0];
    const last = verts[verts.length - 1];
    const dropDup =
      verts.length >= 4 &&
      Math.hypot(last.x - first.x, last.y - first.y) <= 0.5;
    const shapeIndex = activeIndex;
    setShapes((ss) =>
      ss.map((s, i) =>
        i === shapeIndex
          ? {
              closed: true,
              vertices: dropDup ? s.vertices.slice(0, -1) : s.vertices,
            }
          : s,
      ),
    );
    setHistory((h) => [
      ...h,
      dropDup
        ? { t: 'c', shape: shapeIndex, dropped: last }
        : { t: 'c', shape: shapeIndex },
    ]);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [busy, activeShape, activeIndex]);

  const onUndo = useCallback(() => {
    if (busy || history.length === 0) return;
    // Read the top action from the render closure and issue each state
    // update as a SIBLING — nesting setShapes/setLabels inside the
    // setHistory updater made the updater impure, and React may invoke
    // updaters twice (StrictMode / concurrent replays), which would make
    // one Undo eat two actions (review catch).
    const top = history[history.length - 1];
    if (top.t === 'c') {
      // Reopen THE shape the close targeted (index is stable — shapes
      // are only pushed/popped at the end) and restore the duplicate
      // end vertex the close dropped, if any.
      setShapes((ss) =>
        ss.map((s, i) =>
          i === top.shape
            ? {
                closed: false,
                vertices: top.dropped
                  ? [...s.vertices, top.dropped]
                  : s.vertices,
              }
            : s,
        ),
      );
    } else if (top.t === 'ns') {
      // Undoing a later shape's FIRST vertex removes the whole
      // (one-point) shape — never the founding first shape.
      setShapes((ss) => (ss.length > 1 ? ss.slice(0, -1) : ss));
    } else if (top.t === 'v') {
      setShapes((ss) =>
        ss.map((s, i) =>
          i === ss.length - 1
            ? { ...s, vertices: s.vertices.slice(0, -1) }
            : s,
        ),
      );
    } else if (top.t === 'l') {
      setLabels((l) => l.slice(0, -1));
    }
    setHistory((h) => h.slice(0, -1));
    void Haptics.selectionAsync();
  }, [busy, history]);

  const onClear = useCallback(() => {
    if (busy) return;
    const doClear = () => {
      setShapes(freshShapes());
      setLabels([]);
      setHistory([]);
      setLabelDraft(null);
      // Clear starts a NEW document: reset the save identity so the next
      // save mints a fresh capture id and re-runs the assignment picker,
      // instead of superseding the sketch that was just saved.
      savedIdRef.current = null;
      savedAssignmentIdRef.current = null;
      void Haptics.selectionAsync();
    };
    Alert.alert(
      'Clear sketch?',
      savedIdRef.current
        ? 'This starts a new sketch. The sketch you saved stays saved.'
        : 'This removes every point and label.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: doClear },
      ],
    );
  }, [busy]);

  /**
   * Recenter (#686): snap the view to fit EVERYTHING — the same fit
   * computation Save rasterizes with, so the button always shows
   * exactly what a save would capture. Falls back to the identity view
   * on an empty canvas (fit returns null with no content). No
   * animation on purpose: in the field, instant beats pretty.
   */
  const onRecenter = useCallback(() => {
    const fit = fitTransformForCapture(allVertices, labels, size.w, size.h);
    setTransform(fit ?? { tx: 0, ty: 0, scale: 1 });
    void Haptics.selectionAsync();
  }, [allVertices, labels, size.w, size.h]);

  // --- Gestures (rebuilt each render so closures see current state) ---
  //
  // Ownership: PAN owns one-finger drag (Pan/Zoom mode only, INCREMENTAL
  // deltas); PINCH owns everything two-finger — it zooms about the live
  // focal AND pans with it, and stays enabled in Draw mode so two-finger
  // navigation works while drawing. The old code had pan and pinch each
  // snapshot a baseline at onBegin and write ABSOLUTE transforms
  // simultaneously, so they fought (flicker; a jump when one finger
  // lifted), and Android's BEGAN focal is the first touch point — not
  // the two-finger centroid — so zoom lurched at onset.
  const pinchFocalRef = useRef<{ x: number; y: number } | null>(null);

  const tapGesture = Gesture.Tap()
    .runOnJS(true)
    .enabled(mode !== 'pan')
    .maxDistance(14)
    .onTouchesDown((e, mgr) => {
      // A second finger means navigation, never a vertex — fail the tap
      // immediately so a two-finger tap can't drop a stray point.
      if (e.numberOfTouches > 1) mgr.fail();
    })
    .onEnd((e, success) => {
      if (success) onCanvasTap(e.x, e.y);
    });

  const panGesture = Gesture.Pan()
    .runOnJS(true)
    .enabled(mode === 'pan')
    .maxPointers(1)
    .minDistance(1)
    .onChange((e) => {
      // Incremental: no baseline snapshot to fight the pinch over.
      setTransform((t) => ({
        ...t,
        tx: t.tx + e.changeX,
        ty: t.ty + e.changeY,
      }));
    });

  const pinchGesture = Gesture.Pinch()
    .runOnJS(true)
    .enabled(mode === 'pan' || mode === 'draw')
    .onStart((e) => {
      // Seed the focal tracker at ACTIVATION (both fingers down), not
      // BEGAN — on Android the BEGAN focal is the FIRST touch point, not
      // the centroid, and using it made the content lurch at onset.
      pinchFocalRef.current = { x: e.focalX, y: e.focalY };
    })
    .onChange((e) => {
      const prevFocal = pinchFocalRef.current ?? { x: e.focalX, y: e.focalY };
      pinchFocalRef.current = { x: e.focalX, y: e.focalY };
      // Functional + incremental: per update, scale by e.scaleChange and
      // translate so the world point that sat under the PREVIOUS focal
      // now sits under the LIVE focal — zoom stays glued to the fingers
      // and focal movement pans (standard sketch-app feel). worldFocal is
      // computed from the CURRENT transform each update, so pan and
      // pinch can interleave without stomping each other.
      setTransform((t) => {
        const newScale = clampScale(t.scale * e.scaleChange);
        const worldFx = (prevFocal.x - t.tx) / t.scale;
        const worldFy = (prevFocal.y - t.ty) / t.scale;
        return {
          scale: newScale,
          tx: e.focalX - worldFx * newScale,
          ty: e.focalY - worldFy * newScale,
        };
      });
    })
    .onFinalize(() => {
      pinchFocalRef.current = null;
    });

  const composed = Gesture.Simultaneous(panGesture, pinchGesture, tapGesture);

  // --- GPS pin (carried over from #655; lives in the settings sheet) ---
  const onPinLocation = useCallback(async () => {
    if (pinning) return;
    setPinning(true);
    setLocationNote(null);
    try {
      const fix = await getCurrentGeo({
        onDenied: () =>
          setLocationNote(
            'Location is blocked. Enable it in Settings to pin this sketch to the site.',
          ),
      });
      if (!fix) {
        setLocationNote(
          (n) => n ?? 'No location yet — allow location access to pin the site.',
        );
        return;
      }
      setPinnedGeo(fix);
      setPinnedAt(new Date().toISOString());
      void Haptics.selectionAsync();
      void startHeading();
    } catch (e) {
      setLocationNote(`Couldn't get a location fix: ${(e as Error).message}`);
    } finally {
      setPinning(false);
    }
  }, [pinning, startHeading]);

  // --- Save (rasterize + enqueue, persist the vector doc) ---
  const onSave = useCallback(async () => {
    if (busy) return;
    if (!hasContent) {
      Alert.alert('Nothing to save', 'Add points or a label before saving.');
      return;
    }
    setBusy(true);
    setSaveNote(null);
    try {
      // Rasterize FIT-TO-CONTENT, not as-displayed: apply a transform
      // that frames the whole sketch — EVERY shape + label (#686) —
      // wait for a paint (two rAFs ≈ one committed frame), capture,
      // then restore the user's view. Saving the live viewport cropped
      // or blanked whatever was panned/zoomed out of sight. The toast +
      // Android label card + canvas overlay buttons live OUTSIDE the
      // ref'd canvas view, so they can never be baked into the PNG.
      const userTransform = transform;
      const fit = fitTransformForCapture(allVertices, labels, size.w, size.h);
      if (fit) {
        setTransform(fit);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      }
      let uri: string;
      try {
        uri = await captureRef(canvasRef, {
          format: 'png',
          quality: 1,
          result: 'tmpfile',
        });
      } finally {
        if (fit) setTransform(userTransform);
      }
      // Seal the rasterized PNG into the vault (PII P0 Phase 3): the
      // view-shot plaintext tmpfile is encrypted + deleted before
      // anything persists.
      uri = await sealCaptureFile(uri);

      // Pick the assignment on the FIRST save only; reuse it thereafter.
      if (savedIdRef.current == null) {
        try {
          savedAssignmentIdRef.current = await pickAssignment();
        } catch {
          savedAssignmentIdRef.current = null;
        }
      }
      const assignmentId = savedAssignmentIdRef.current;

      const sketchMeta: SketchMeta = {
        gridSize,
        scaleFeetPerSquare: scaleFeet,
        snapEnabled: snapActive,
        // The editable vector doc — this is what makes the sketch
        // re-openable and its dimensions/area recomputable from data.
        // docFromShapes writes EVERY shape under `shapes` AND mirrors
        // shapes[0] onto the legacy vertices/closed fields, so the wire
        // only gains a key and pre-#686 readers still see the first
        // outline unchanged.
        vector: docFromShapes(pxPerFoot, shapes, labels),
      };
      if (pinnedGeo) {
        sketchMeta.gps = {
          lat: pinnedGeo.lat,
          lng: pinnedGeo.lon,
          accuracyMeters: pinnedGeo.accuracyMeters,
          capturedAt: pinnedAt ?? new Date().toISOString(),
        };
      }
      if (heading != null) sketchMeta.headingDeg = Math.round(heading);

      const buildMeta = (id: string): CaptureMeta => {
        const meta: CaptureMeta = {
          id,
          kind: 'sketch',
          localUri: uri,
          capturedAt: new Date().toISOString(),
          caption: 'Field sketch',
          status: 'pending',
          sketch: sketchMeta,
        };
        if (assignmentId) meta.assignmentId = assignmentId;
        if (pinnedGeo) meta.geo = pinnedGeo;
        return meta;
      };

      if (savedIdRef.current == null) {
        const id = newCaptureId();
        await enqueue(buildMeta(id));
        savedIdRef.current = id;
      } else {
        // Subsequent save → MINT A FRESH ID and supersede the old row.
        // Never update-in-place and re-POST: the backend is idempotent
        // on (tenant_id, client_id) — re-posting the same client id
        // returns the OLD capture with 200 and silently DISCARDS the new
        // bytes, while the client happily marks them 'synced'.
        const oldId = savedIdRef.current;
        const oldRow = (await loadQueue()).find((it) => it.id === oldId);
        const id = newCaptureId();
        await enqueue(buildMeta(id));
        await removeItem(oldId);
        savedIdRef.current = id;
        // Best-effort: if the superseded revision already reached the
        // server, delete its copy. Swallow every failure — offline is
        // fine; an older revision lingering server-side beats losing the
        // new one. (Rows that synced before serverId existed, or whose
        // upload is mid-flight right now, just skip this.)
        if (oldRow?.serverId) {
          void deleteCapture(oldRow.serverId).catch(() => {});
        }
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void syncNow();
      // Stay on the canvas — show a brief confirmation only.
      setSaveNote('Saved');
      setTimeout(() => setSaveNote(null), 1800);
    } catch (e) {
      Alert.alert('Save failed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    hasContent,
    transform,
    size.w,
    size.h,
    gridSize,
    scaleFeet,
    snapActive,
    pxPerFoot,
    shapes,
    allVertices,
    labels,
    pinnedGeo,
    pinnedAt,
    heading,
  ]);

  const invScale = 1 / transform.scale;

  // Graph-paper grid, memoized on CELL-SNAPPED bounds: panning within a
  // grid cell re-renders the frame without rebuilding a single <Line>.
  // (Zoom changes invScale, so the stroke-constant grid rebuilds then —
  // pan is the per-frame hot path this protects.)
  const gridBounds = gridBoundsFor(spacing, transform, size.w, size.h);
  const gridEls = useMemo((): ReactElement[] | null => {
    if (!gridBounds || spacing <= 0) return null;
    const { left, right, top, bottom } = gridBounds;
    const els: ReactElement[] = [];
    // Cap grid line count when zoomed way out so we never draw thousands.
    if ((right - left) / spacing <= MAX_GRID_LINES) {
      for (let x = left; x <= right; x += spacing) {
        els.push(
          <Line
            key={`vx${x}`}
            x1={x}
            y1={top}
            x2={x}
            y2={bottom}
            stroke={GRID_COLOR}
            strokeWidth={invScale}
          />,
        );
      }
    }
    if ((bottom - top) / spacing <= MAX_GRID_LINES) {
      for (let y = top; y <= bottom; y += spacing) {
        els.push(
          <Line
            key={`hy${y}`}
            x1={left}
            y1={y}
            x2={right}
            y2={y}
            stroke={GRID_COLOR}
            strokeWidth={invScale}
          />,
        );
      }
    }
    return els;
    // Keyed on the snapped-bounds PRIMITIVES (the object identity changes
    // every render) plus spacing/invScale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    spacing,
    invScale,
    gridBounds?.left,
    gridBounds?.right,
    gridBounds?.top,
    gridBounds?.bottom,
  ]);

  // The Close-shape pill is contextual (#686): visible only while the
  // active shape can actually be closed, so the toolbar stays slim and
  // the affordance appears exactly when it becomes meaningful.
  const canCloseActive =
    !activeShape.closed && activeShape.vertices.length >= 3 && !busy;

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  return (
    <GestureHandlerRootView style={styles.flex}>
      <SafeAreaView style={styles.flex} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <Pressable
            style={[styles.closeButton, styles.closeRow]}
            onPress={() => router.back()}
          >
            <Ionicons name="arrow-back" size={15} color={Brand.navyDeep} />
            <Text style={styles.closeLabel}>Cancel</Text>
          </Pressable>
          <Text style={styles.topTitle}>Floor plan</Text>
          <View style={styles.closeButton} />
        </View>

        {/* The captured surface. Only the ref'd inner View rasterizes on
            Save; the toast, Android label card, keypad, Close-shape pill
            and Recenter button are SIBLINGS in the wrap so they can never
            be baked into the PNG. */}
        <View style={styles.canvasWrap}>
          <GestureDetector gesture={composed}>
            <View
              ref={canvasRef}
              collapsable={false}
              style={styles.canvas}
              onLayout={onCanvasLayout}
            >
              <Svg style={StyleSheet.absoluteFill}>
                <G
                  transform={`translate(${transform.tx}, ${transform.ty}) scale(${transform.scale})`}
                >
                  {/* Graph-paper grid (world space, memoized). */}
                  {gridEls}

                  {/* Walls — every shape's outline (#686). */}
                  {shapeRender.map((r, si) =>
                    r.d ? (
                      <Path
                        key={`shape${si}`}
                        d={r.d}
                        stroke={STROKE_COLOR}
                        strokeWidth={STROKE_WIDTH * invScale}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill={shapes[si].closed ? FILL_COLOR : 'none'}
                      />
                    ) : null,
                  )}

                  {/* Vertices — the ACTIVE shape's last point highlighted
                      as the live endpoint (only while it's still open). */}
                  {shapes.map((s, si) =>
                    s.vertices.map((p, i) => {
                      const isLast =
                        si === activeIndex &&
                        !s.closed &&
                        i === s.vertices.length - 1;
                      return (
                        <Circle
                          key={`pt${si}-${i}`}
                          cx={p.x}
                          cy={p.y}
                          r={(isLast ? 6 : 4) * invScale}
                          fill={isLast ? Brand.gold : Brand.navyDeep}
                          stroke={Brand.cream}
                          strokeWidth={invScale}
                        />
                      );
                    }),
                  )}

                  {/* Segment dimensions at each midpoint, per shape. */}
                  {shapeRender.map((r, si) =>
                    r.segs.map((s, i) => (
                      <SvgText
                        key={`seg${si}-${i}`}
                        x={s.mid.x}
                        y={s.mid.y - 4 * invScale}
                        fill={Brand.navyDeep}
                        fontSize={12 * invScale}
                        fontWeight="700"
                        textAnchor="middle"
                      >
                        {r.segLabels[i]}
                      </SvgText>
                    )),
                  )}

                  {/* Per-shape area captions at each closed shape's
                      centroid (#686) — a crossed outline warns instead
                      of showing the shoelace's bogus number. */}
                  {shapeRender.map((r, si) => {
                    if (!shapes[si].closed || !r.centroid) return null;
                    if (r.crossed) {
                      return (
                        <SvgText
                          key={`area${si}`}
                          x={r.centroid.x}
                          y={r.centroid.y}
                          fill={Brand.red}
                          fontSize={11 * invScale}
                          fontWeight="700"
                          textAnchor="middle"
                        >
                          walls cross
                        </SvgText>
                      );
                    }
                    if (r.area <= 0) return null;
                    return (
                      <SvgText
                        key={`area${si}`}
                        x={r.centroid.x}
                        y={r.centroid.y}
                        fill={Brand.inkMuted}
                        fontSize={12 * invScale}
                        fontWeight="700"
                        textAnchor="middle"
                      >
                        {`${r.area.toFixed(1)} sq ft`}
                      </SvgText>
                    );
                  })}

                  {/* Free-floating labels. */}
                  {labels.map((l, i) => (
                    <SvgText
                      key={`lbl${i}`}
                      x={l.x}
                      y={l.y}
                      fill={Brand.navyDeep}
                      fontSize={14 * invScale}
                      fontWeight="700"
                      textAnchor="middle"
                    >
                      {l.text}
                    </SvgText>
                  ))}
                </G>
              </Svg>

              {/* North arrow (screen space; carried over). Lives INSIDE
                  the ref'd canvas on purpose — it belongs in the PNG. */}
              {heading != null ? (
                <View style={styles.northArrow} pointerEvents="none">
                  <View
                    style={{
                      transform: [{ rotate: `${-heading}deg` }],
                      alignItems: 'center',
                    }}
                  >
                    <Text style={styles.northLabel}>N</Text>
                    <Ionicons name="arrow-up" size={22} color={Brand.red} />
                  </View>
                </View>
              ) : null}

              {/* Mode hint / empty state. */}
              {!hasContent ? (
                <View style={styles.emptyHint} pointerEvents="none">
                  <Text style={styles.emptyHintLabel}>
                    {mode === 'pan'
                      ? 'Drag to pan · pinch to zoom'
                      : mode === 'label'
                        ? 'Tap to place a label'
                        : 'Tap to drop points — or open the keypad below for exact distances'}
                  </Text>
                </View>
              ) : null}
            </View>
          </GestureDetector>

          {/* OUTSIDE the ref'd canvas — never rasterized into the PNG. */}
          {saveNote ? (
            <View style={styles.saveToast} pointerEvents="none">
              <Ionicons name="checkmark-circle" size={16} color={Brand.cream} />
              <Text style={styles.saveToastLabel}>{saveNote}</Text>
            </View>
          ) : null}

          {/* Recenter (#686): bottom-right, above the toolbar. Also a
              canvas sibling — never captured. */}
          <Pressable
            accessibilityLabel="Recenter view on the whole drawing"
            style={({ pressed }) => [
              styles.recenterBtn,
              pressed && styles.iconBtnPressed,
            ]}
            onPress={onRecenter}
          >
            <Ionicons name="scan-outline" size={20} color={Brand.navyDeep} />
          </Pressable>

          {/* Bottom-center overlay stack: collapsible precise-entry pad
              + contextual Close-shape pill. box-none so canvas taps pass
              through everywhere the controls aren't. */}
          <View style={styles.overlayStack} pointerEvents="box-none">
            {mode === 'draw' && padOpen ? (
              <View style={styles.padCard}>
                <Text style={styles.padTitle}>
                  Distance + direction (screen-relative)
                </Text>
                <View style={styles.pad}>
                  {(['up-left', 'up', 'up-right'] as Dir8[]).map((d) => (
                    <ArrowButton
                      key={d}
                      dir={d}
                      disabled={busy || activeShape.closed}
                      onPress={onArrow}
                    />
                  ))}
                </View>
                <View style={styles.pad}>
                  <ArrowButton
                    dir="left"
                    disabled={busy || activeShape.closed}
                    onPress={onArrow}
                  />
                  <View style={styles.padCenter}>
                    <TextInput
                      style={styles.distanceInput}
                      value={distanceText}
                      onChangeText={setDistanceText}
                      keyboardType="decimal-pad"
                      placeholder="ft"
                      placeholderTextColor={Brand.inkFaint}
                      returnKeyType="done"
                      maxLength={7}
                    />
                  </View>
                  <ArrowButton
                    dir="right"
                    disabled={busy || activeShape.closed}
                    onPress={onArrow}
                  />
                </View>
                <View style={[styles.pad, styles.padLastRow]}>
                  {(['down-left', 'down', 'down-right'] as Dir8[]).map((d) => (
                    <ArrowButton
                      key={d}
                      dir={d}
                      disabled={busy || activeShape.closed}
                      onPress={onArrow}
                    />
                  ))}
                </View>
              </View>
            ) : null}
            {canCloseActive ? (
              <Pressable
                accessibilityLabel="Close the current shape"
                style={({ pressed }) => [
                  styles.closeShapePill,
                  pressed && styles.iconBtnPressed,
                ]}
                onPress={onCloseShape}
              >
                <Ionicons
                  name="checkmark-circle-outline"
                  size={16}
                  color={Brand.cream}
                />
                <Text style={styles.closeShapePillLabel}>Close shape</Text>
              </Pressable>
            ) : null}
          </View>

          {/* Android inline label draft (also outside the ref'd canvas). */}
          {labelDraft ? (
            <View style={styles.labelDraftCard}>
              <Text style={styles.labelDraftTitle}>Add label</Text>
              <TextInput
                style={styles.labelDraftInput}
                value={labelDraft.text}
                onChangeText={(t) =>
                  setLabelDraft((d) => (d ? { ...d, text: t } : d))
                }
                placeholder="e.g. Garage"
                placeholderTextColor={Brand.inkFaint}
                autoFocus
              />
              <View style={styles.labelDraftRow}>
                <Pressable
                  style={styles.labelDraftBtn}
                  onPress={() => {
                    setLabelDraft(null);
                    setMode('draw');
                  }}
                >
                  <Text style={styles.labelDraftBtnLabel}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={[styles.labelDraftBtn, styles.labelDraftBtnPrimary]}
                  onPress={() => {
                    const t = labelDraft.text.trim();
                    if (t) addLabel({ x: labelDraft.x, y: labelDraft.y, text: t });
                    setLabelDraft(null);
                  }}
                >
                  <Text
                    style={[
                      styles.labelDraftBtnLabel,
                      styles.labelDraftBtnLabelPrimary,
                    ]}
                  >
                    Add
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>

        {/* Measurement readout — the ACTIVE shape's numbers (#686);
            closed shapes each carry their own area caption on-canvas. */}
        <View style={styles.readout}>
          {activeRender.crossed ? (
            // Self-intersecting outline → the shoelace area is silently
            // wrong. Warn instead of showing a bogus number; keep the
            // perimeter, which is still meaningful.
            <Text style={styles.readoutWarn}>
              Walls cross — fix the outline
              <Text style={styles.readoutPerim}>
                {'   ·   '}Perimeter {activeRender.perimeter.toFixed(1)} ft
              </Text>
            </Text>
          ) : activeShape.closed && activeRender.area > 0 ? (
            <Text style={styles.readoutArea}>
              Area {activeRender.area.toFixed(1)} sq ft
              <Text style={styles.readoutPerim}>
                {'   ·   '}Perimeter {activeRender.perimeter.toFixed(1)} ft ·
                tap canvas for the next shape
              </Text>
            </Text>
          ) : activeShape.closed ? (
            // Closed but zero-area (collinear points): the close pill is
            // gone, so don't dead-end the user into tapping it (review
            // catch). Undo is the way out.
            <Text style={styles.readoutPerim}>
              Perimeter {activeRender.perimeter.toFixed(1)} ft · no
              measurable area — Undo to adjust, or tap canvas for the next
              shape
            </Text>
          ) : activeShape.vertices.length >= 2 ? (
            <Text style={styles.readoutPerim}>
              Path {activeRender.perimeter.toFixed(1)} ft · tap “Close shape”
              for area
            </Text>
          ) : (
            <Text style={styles.readoutPerim}>
              {activeShape.vertices.length === 1
                ? 'One point placed — add the next'
                : shapes.length > 1
                  ? 'Tap to start the next shape'
                  : 'No points yet'}
            </Text>
          )}
        </View>

        {/* ONE slim toolbar row (#686): mode control + icon tools. The
            canvas above gets every pixel the old stacked chrome used. */}
        <View style={styles.toolbar}>
          <View style={styles.modeSegment}>
            {MODE_OPTIONS.map((o) => {
              const active = o.value === mode;
              return (
                <Pressable
                  key={o.value}
                  accessibilityLabel={o.a11y}
                  style={[
                    styles.modeSegmentItem,
                    active && styles.modeSegmentItemActive,
                  ]}
                  onPress={() => setMode(o.value)}
                >
                  <Ionicons
                    name={o.icon}
                    size={18}
                    color={active ? Brand.cream : Brand.navyDeep}
                  />
                </Pressable>
              );
            })}
          </View>
          <ToolIcon
            icon={padOpen ? 'keypad' : 'keypad-outline'}
            a11y="Toggle the precise distance keypad"
            active={padOpen && mode === 'draw'}
            disabled={mode !== 'draw'}
            onPress={() => setPadOpen((v) => !v)}
          />
          <ToolIcon
            icon="arrow-undo"
            a11y="Undo"
            disabled={history.length === 0 || busy}
            onPress={onUndo}
          />
          <ToolIcon
            icon="settings-outline"
            a11y="Sketch settings (grid, scale, snap, site pin)"
            onPress={() => setSettingsOpen(true)}
          />
          <ToolIcon
            icon="trash-outline"
            a11y="Clear sketch"
            disabled={!hasContent || busy}
            onPress={onClear}
          />
          <Pressable
            accessibilityLabel={
              savedIdRef.current ? 'Update saved sketch' : 'Save sketch'
            }
            style={({ pressed }) => [
              styles.saveButton,
              (!hasContent || busy) && styles.saveButtonDisabled,
              pressed && hasContent && !busy && styles.saveButtonPressed,
            ]}
            onPress={onSave}
            disabled={!hasContent || busy}
          >
            {busy ? (
              <ActivityIndicator size="small" color={Brand.cream} />
            ) : (
              <Ionicons name="save-outline" size={20} color={Brand.cream} />
            )}
          </Pressable>
        </View>

        {/* Settings bottom sheet (#686): grid / scale / snap / site pin,
            relocated off the top chrome. The calibration invariant is
            enforced by the same onGridSizeChange / onScaleFeetChange
            handlers as before — only the controls' HOME moved. */}
        <Modal
          visible={settingsOpen}
          transparent
          animationType="slide"
          onRequestClose={closeSettings}
        >
          <View style={styles.sheetRoot}>
            <Pressable
              accessibilityLabel="Close settings"
              style={styles.sheetBackdrop}
              onPress={closeSettings}
            />
            <View style={styles.sheet}>
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>Sketch settings</Text>
              <View style={styles.controlRow}>
                <Text style={styles.controlLabel}>GRID</Text>
                <Segmented
                  options={GRID_OPTIONS}
                  value={gridSize}
                  onChange={onGridSizeChange}
                />
              </View>
              <View style={styles.controlRow}>
                <Text style={styles.controlLabel}>SCALE</Text>
                <Segmented
                  options={SCALE_OPTIONS}
                  value={scaleFeet}
                  onChange={onScaleFeetChange}
                />
              </View>
              <View style={styles.controlRow}>
                <Pressable
                  style={[
                    styles.chipButton,
                    snapActive && styles.chipButtonOn,
                    gridSize === 'off' && styles.chipButtonDisabled,
                  ]}
                  onPress={() => gridSize !== 'off' && setSnapEnabled((v) => !v)}
                  disabled={gridSize === 'off'}
                >
                  <Ionicons
                    name={snapActive ? 'magnet' : 'magnet-outline'}
                    size={14}
                    color={snapActive ? Brand.cream : Brand.navyDeep}
                  />
                  <Text
                    style={[styles.chipLabel, snapActive && styles.chipLabelOn]}
                  >
                    Snap
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.chipButton}
                  onPress={onPinLocation}
                  disabled={pinning}
                >
                  {pinning ? (
                    <ActivityIndicator size="small" color={Brand.navyDeep} />
                  ) : (
                    <Ionicons
                      name="location-outline"
                      size={14}
                      color={Brand.navyDeep}
                    />
                  )}
                  <Text style={styles.chipLabel}>
                    {pinnedGeo ? 'Re-pin' : 'Pin site'}
                  </Text>
                </Pressable>
                <Text style={styles.scaleReadout}>1 sq = {scaleFeet} ft</Text>
              </View>
              {pinnedGeo ? (
                <View style={styles.geoChip}>
                  <Text style={styles.geoChipLabel}>
                    📍 {pinnedGeo.lat.toFixed(4)}, {pinnedGeo.lon.toFixed(4)}
                    {pinnedGeo.accuracyMeters != null
                      ? ` (±${Math.round(pinnedGeo.accuracyMeters)} m)`
                      : ''}
                  </Text>
                </View>
              ) : null}
              {locationNote ? (
                <Text style={styles.locationNote}>{locationNote}</Text>
              ) : null}
              <Pressable style={styles.sheetDone} onPress={closeSettings}>
                <Text style={styles.sheetDoneLabel}>Done</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

/** One arrow in the 8-direction precise-entry pad. */
function ArrowButton({
  dir,
  disabled,
  onPress,
}: {
  dir: Dir8;
  disabled: boolean;
  onPress: (d: Dir8) => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.arrowBtn,
        disabled && styles.arrowBtnDisabled,
        pressed && !disabled && styles.arrowBtnPressed,
      ]}
      onPress={() => onPress(dir)}
      disabled={disabled}
    >
      <Text style={styles.arrowGlyph}>{ARROW_GLYPH[dir]}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Brand.cream },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.one,
  },
  closeButton: {
    minWidth: 72,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  closeRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  closeLabel: { color: Brand.navyDeep, fontSize: 15, fontWeight: '600' },
  topTitle: { fontSize: 16, fontWeight: '700', color: Brand.navyDeep },

  controlRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  controlLabel: {
    width: 44,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    color: Brand.inkMuted,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: Brand.surface,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
    overflow: 'hidden',
  },
  segmentItem: { flex: 1, paddingVertical: Spacing.two, alignItems: 'center' },
  segmentItemActive: { backgroundColor: Brand.navyDeep },
  segmentLabel: { fontSize: 13, fontWeight: '600', color: Brand.navyDeep },
  segmentLabelActive: { color: Brand.cream },
  scaleReadout: { fontSize: 12, color: Brand.inkFaint, marginLeft: 'auto' },
  chipButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.pill,
    backgroundColor: Brand.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  chipButtonOn: { backgroundColor: Brand.navyDeep, borderColor: Brand.navyDeep },
  chipButtonDisabled: { opacity: 0.45 },
  chipLabel: { fontSize: 13, fontWeight: '600', color: Brand.navyDeep },
  chipLabelOn: { color: Brand.cream },
  geoChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Radius.pill,
    backgroundColor: Brand.paperWarm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  geoChipLabel: { fontSize: 12, fontWeight: '600', color: Brand.navyDeep },
  locationNote: { fontSize: 12, color: Brand.amber },

  // Precise-entry pad, now an overlay CARD (#686) — same controls, but
  // it floats over the canvas only while toggled open instead of
  // permanently claiming layout height.
  padCard: {
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: 0,
    borderRadius: Radius.md,
    backgroundColor: Brand.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  padTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: Brand.inkMuted,
    marginBottom: Spacing.one,
  },
  pad: { flexDirection: 'row', gap: Spacing.two, marginBottom: Spacing.two },
  padLastRow: { marginBottom: Spacing.two },
  padCenter: { width: 84, alignItems: 'center', justifyContent: 'center' },
  arrowBtn: {
    width: 44,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.md,
    backgroundColor: Brand.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  arrowBtnDisabled: { opacity: 0.4 },
  arrowBtnPressed: { backgroundColor: Brand.paperWarm },
  arrowGlyph: { fontSize: 22, fontWeight: '700', color: Brand.navyDeep },
  distanceInput: {
    width: 84,
    height: 40,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.rule,
    backgroundColor: '#ffffff',
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    color: Brand.navyDeep,
    paddingVertical: 0,
  },

  // Layout wrap around the canvas: hosts the toast + Android label-draft
  // card + keypad + Close-shape pill + Recenter button as SIBLINGS of
  // the ref'd canvas so captureRef can never rasterize them into the
  // saved PNG.
  canvasWrap: {
    flex: 1,
    marginHorizontal: Spacing.three,
    marginBottom: Spacing.two,
  },
  canvas: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.rule,
    overflow: 'hidden',
  },
  northArrow: {
    position: 'absolute',
    top: Spacing.two,
    right: Spacing.two,
    width: 40,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.sm,
    backgroundColor: 'rgba(255,255,255,0.7)',
  },
  northLabel: { fontSize: 11, fontWeight: '800', color: Brand.red, lineHeight: 13 },
  emptyHint: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  emptyHintLabel: {
    fontSize: 15,
    color: Brand.inkFaint,
    fontWeight: '600',
    textAlign: 'center',
  },
  saveToast: {
    position: 'absolute',
    top: Spacing.two,
    left: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Radius.pill,
    backgroundColor: Brand.green,
  },
  saveToastLabel: { color: Brand.cream, fontSize: 13, fontWeight: '700' },
  recenterBtn: {
    position: 'absolute',
    right: Spacing.two,
    bottom: Spacing.two,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
    backgroundColor: Brand.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
    // Soft lift so it reads as a control ABOVE the drawing, not part
    // of it (it's a canvas sibling, so it never rasterizes anyway).
    shadowColor: Brand.navyDeep,
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  overlayStack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: Spacing.two,
    alignItems: 'center',
    gap: Spacing.two,
  },
  closeShapePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.pill,
    backgroundColor: Brand.navyDeep,
    shadowColor: Brand.navyDeep,
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  closeShapePillLabel: { color: Brand.cream, fontSize: 13, fontWeight: '700' },
  labelDraftCard: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    bottom: Spacing.three,
    padding: Spacing.three,
    borderRadius: Radius.md,
    backgroundColor: Brand.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
    gap: Spacing.two,
  },
  labelDraftTitle: { fontSize: 13, fontWeight: '700', color: Brand.navyDeep },
  labelDraftInput: {
    height: 40,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.rule,
    backgroundColor: '#ffffff',
    paddingHorizontal: Spacing.two,
    fontSize: 15,
    color: Brand.navyDeep,
  },
  labelDraftRow: { flexDirection: 'row', gap: Spacing.two, justifyContent: 'flex-end' },
  labelDraftBtn: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: Radius.md,
    backgroundColor: Brand.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  labelDraftBtnPrimary: { backgroundColor: Brand.navyDeep, borderColor: Brand.navyDeep },
  labelDraftBtnLabel: { fontSize: 14, fontWeight: '600', color: Brand.navyDeep },
  labelDraftBtnLabelPrimary: { color: Brand.cream },

  readout: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.one,
    minHeight: 22,
    justifyContent: 'center',
  },
  readoutArea: { fontSize: 16, fontWeight: '800', color: Brand.navyDeep },
  readoutPerim: { fontSize: 13, fontWeight: '600', color: Brand.inkMuted },
  readoutWarn: { fontSize: 15, fontWeight: '800', color: Brand.red },

  // ONE slim toolbar row (#686). Tight gaps + fixed 40 dp targets keep
  // mode control + five tools on a single line on a 360 dp phone;
  // flexWrap is the graceful fallback for anything narrower.
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingBottom: Spacing.two,
  },
  modeSegment: {
    flexDirection: 'row',
    backgroundColor: Brand.surface,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
    overflow: 'hidden',
    marginRight: Spacing.one,
  },
  modeSegmentItem: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeSegmentItemActive: { backgroundColor: Brand.navyDeep },
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.md,
    backgroundColor: Brand.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  iconBtnActive: { backgroundColor: Brand.navyDeep, borderColor: Brand.navyDeep },
  iconBtnDisabled: { opacity: 0.4 },
  iconBtnPressed: { opacity: 0.8 },
  saveButton: {
    width: 52,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.md,
    backgroundColor: Brand.navyDeep,
    marginLeft: Spacing.one,
  },
  saveButtonDisabled: { opacity: 0.6 },
  saveButtonPressed: { opacity: 0.85 },

  // Settings bottom sheet (#686).
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(15,29,58,0.35)',
  },
  sheet: {
    backgroundColor: Brand.cream,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.five,
    gap: Spacing.two,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: Radius.pill,
    backgroundColor: Brand.rule,
    marginBottom: Spacing.one,
  },
  sheetTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Brand.navyDeep,
    marginBottom: Spacing.one,
  },
  sheetDone: {
    marginTop: Spacing.two,
    alignItems: 'center',
    paddingVertical: Spacing.three,
    borderRadius: Radius.md,
    backgroundColor: Brand.navyDeep,
  },
  sheetDoneLabel: { color: Brand.cream, fontSize: 15, fontWeight: '700' },
});
