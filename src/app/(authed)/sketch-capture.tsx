/**
 * Vector floor-plan editor (#666, SLICE 1) — replaces the old freehand
 * raster sketch tool. The appraiser now draws a real polyline/polygon
 * whose vertices, labels, and pxPerFoot calibration are kept as DATA
 * (`SketchDoc`), so segment lengths + enclosed area are computed exactly
 * and the sketch is re-editable later. The old tool rasterized to a PNG
 * and threw the geometry away — you couldn't measure or edit it.
 *
 * What's on the surface:
 *   - Draw mode: TAP the canvas to drop the next vertex, connected to
 *     the last (a continuous wall). Snap-to-grid (existing toggle) snaps
 *     added vertices to grid intersections.
 *   - Precise entry: a distance field + an 8-direction pad. Type feet,
 *     tap a SCREEN-relative arrow (up = screen-up, NOT compass north) and
 *     the next vertex is placed exactly that far away — how appraisers
 *     pace a perimeter ("20 ft right, 15 ft down…"). Diagonals move the
 *     entered distance along the hypotenuse (see endpointOffset).
 *   - Live dimensions: each segment's length renders at its midpoint.
 *   - Close shape: connect last→first and show the enclosed AREA
 *     (shoelace) + perimeter — the core measurement.
 *   - Pan mode: one-finger drag pans. Pinch (two fingers) zooms AND
 *     pans — the live focal point stays glued to the same world point —
 *     and is ALSO enabled in Draw mode, so two-finger navigation works
 *     while drawing (standard sketch-app feel). Taps in Pan mode do NOT
 *     add vertices, and a tap fails the moment a second finger lands so
 *     a pinch can never drop a stray vertex. A screen tap in Draw mode
 *     is mapped back through the pan/zoom transform to canvas (world)
 *     coords before placement.
 *   - Undo (last vertex/label/close, in order) + Clear (confirm; resets
 *     the save identity — Clear starts a NEW document).
 *   - Label tool: tap a spot, enter text, drop a floating label.
 *   - Save in place: rasterize to PNG (react-native-view-shot) + enqueue
 *     like any capture, AND persist the full SketchDoc on
 *     meta.sketch.vector so it round-trips. Stays on the canvas. The
 *     capture is fit-to-content (never the cropped live viewport), and
 *     each RE-save enqueues a brand-new capture id that SUPERSEDES the
 *     previous one — the backend is idempotent on (tenant, client_id),
 *     so re-posting the same id would silently keep the OLD bytes.
 *
 * Calibration model (real feet are INVARIANT): `pxPerFoot` is stable
 * state, calibrated from grid spacing ÷ feet-per-square. When the user
 * changes grid density or scale after drawing, all stored geometry is
 * rescaled about the origin by (new/old) so every wall keeps its FEET
 * value; turning the grid Off changes visibility only (the last
 * calibration is kept) — measurements never move.
 *
 * Grid / scale / snap / GPS-pin / north-arrow controls + the assignment
 * picker + enqueue/sync save path are carried over from the #655 tool.
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
  areaSquareFeet,
  type Dir8,
  endpointOffset,
  hasSelfIntersection,
  perimeterFeet,
  pxPerFootFromGrid,
  rescaleDoc,
  segments,
  type SketchDoc,
  type SketchLabel,
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
 * A close ('c') optionally carries the duplicate end vertex it dropped
 * (a paced perimeter often lands exactly on the start point) so Undo
 * restores it when it reopens the shape.
 */
type Action =
  | { t: 'v' } // vertex added
  | { t: 'l' } // label added
  | { t: 'c'; dropped?: SketchVertex }; // shape closed

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

const MODE_OPTIONS: { label: string; value: Mode }[] = [
  { label: 'Draw', value: 'draw' },
  { label: 'Pan/Zoom', value: 'pan' },
  { label: 'Label', value: 'label' },
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

function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(s, MAX_SCALE));
}

/** SVG path `d` for the polyline; appends `Z` when the shape is closed. */
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
 * Fit-to-content transform used for the Save rasterization: the bounding
 * box of all vertices + label anchors, padded ~24 screen px, scaled and
 * centered into the canvas. Saving the as-displayed viewport cropped
 * (or blanked) whatever the user had panned/zoomed away from. Scale is
 * capped at MAX_SCALE so a tiny sketch isn't blown up absurdly, but has
 * NO lower clamp — a building bigger than the viewport must shrink to
 * fit rather than crop.
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

/** Compact segmented control shared by the grid / scale / mode pickers. */
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

export default function SketchCaptureScreen() {
  const router = useRouter();
  const canvasRef = useRef<View>(null);

  // --- Vector document state ---
  const [vertices, setVertices] = useState<SketchVertex[]>([]);
  const [labels, setLabels] = useState<SketchLabel[]>([]);
  const [closed, setClosed] = useState(false);
  const [history, setHistory] = useState<Action[]>([]);

  // --- Editor UI state ---
  const [mode, setMode] = useState<Mode>('draw');
  const [distanceText, setDistanceText] = useState('');
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

  const doc: SketchDoc = useMemo(
    () => ({ version: 1, pxPerFoot, vertices, labels, closed }),
    [pxPerFoot, vertices, labels, closed],
  );
  const segs = useMemo(() => segments(doc), [doc]);
  const perimeter = useMemo(() => perimeterFeet(doc), [doc]);
  const area = useMemo(() => areaSquareFeet(doc), [doc]);
  // Self-intersection makes the shoelace area silently wrong (a bowtie
  // "encloses" less than the formula says) — when closed + crossed, the
  // readout warns instead of showing a bogus square-footage.
  const crossed = useMemo(
    () => closed && hasSelfIntersection(vertices, true),
    [vertices, closed],
  );
  // Dimension strings memoized apart from the transform so per-frame
  // pan/zoom updates don't re-format every label.
  const segLabels = useMemo(
    () => segs.map((s) => `${s.feet.toFixed(1)}'`),
    [segs],
  );
  const hasContent = vertices.length > 0 || labels.length > 0;

  /**
   * Recalibrate to (spacingPx, feetPerSquare), keeping real-world feet
   * INVARIANT: all stored geometry is rescaled about the origin by
   * (new/old) via rescaleDoc, so every segment keeps its feet value and
   * snapped points land on the rescaled grid.
   */
  const applyCalibration = useCallback(
    (spacingPx: number, feetPerSquare: number) => {
      const next = pxPerFootFromGrid(spacingPx, feetPerSquare);
      if (next <= 0 || next === pxPerFoot) return;
      if (pxPerFoot > 0 && (vertices.length > 0 || labels.length > 0)) {
        const rescaled = rescaleDoc(
          { version: 1, pxPerFoot, vertices, labels, closed },
          next / pxPerFoot,
        );
        setVertices(rescaled.vertices);
        setLabels(rescaled.labels);
      }
      setPxPerFoot(next);
    },
    [pxPerFoot, vertices, labels, closed],
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

  // --- Mutations ---
  const addVertexWorld = useCallback((p: SketchVertex) => {
    setVertices((v) => [...v, p]);
    setHistory((h) => [...h, { t: 'v' }]);
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

  // Auto-pan to the newest vertex whenever one is ADDED (arrow pacing or
  // tap). Runs on committed state so it composes with the functional
  // setVertices updaters; count-gated so undo/clear/rescale don't pan.
  const prevVertexCountRef = useRef(0);
  useEffect(() => {
    const prev = prevVertexCountRef.current;
    prevVertexCountRef.current = vertices.length;
    if (vertices.length > prev && vertices.length > 0) {
      ensureVisibleWorldPoint(vertices[vertices.length - 1]);
    }
  }, [vertices, ensureVisibleWorldPoint]);

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
      // Draw mode. Ignore taps once closed — Undo reopens first.
      if (closed) return;
      addVertexWorld(snapWorld(world));
    },
    // screenToWorld / snapWorld read transform/snap from the current
    // render closure; listing the primitives keeps them fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, mode, closed, transform, snapActive, spacing, promptForLabel, addVertexWorld],
  );

  const onArrow = useCallback(
    (dir: Dir8) => {
      // Never let the decimal pad sit over the canvas while pacing.
      Keyboard.dismiss();
      if (busy) return;
      if (closed) {
        Alert.alert('Shape is closed', 'Undo the close to keep adding points.');
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
      if (vertices.length === 0) {
        // Seed the run at the center of the current view, then step off.
        const startWorld = screenToWorld(
          (size.w || 0) / 2,
          (size.h || 0) / 2,
        );
        const start = snapWorld(startWorld);
        setVertices([start, { x: start.x + dx, y: start.y + dy }]);
        setHistory((h) => [...h, { t: 'v' }, { t: 'v' }]);
      } else {
        // Read the anchor INSIDE the functional updater — a closure-
        // captured `last` goes stale when arrows land faster than React
        // re-renders, silently anchoring a wall to the wrong point.
        setVertices((v) => {
          const last = v[v.length - 1];
          return [...v, { x: last.x + dx, y: last.y + dy }];
        });
        setHistory((h) => [...h, { t: 'v' }]);
      }
      void Haptics.selectionAsync();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, closed, distanceText, pxPerFoot, vertices.length, size, transform, snapActive, spacing],
  );

  const onCloseShape = useCallback(() => {
    if (busy || closed) return;
    if (vertices.length < 3) {
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
    const first = vertices[0];
    const last = vertices[vertices.length - 1];
    const dropDup =
      vertices.length >= 4 &&
      Math.hypot(last.x - first.x, last.y - first.y) <= 0.5;
    if (dropDup) setVertices((v) => v.slice(0, -1));
    setClosed(true);
    setHistory((h) => [...h, dropDup ? { t: 'c', dropped: last } : { t: 'c' }]);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [busy, closed, vertices]);

  const onUndo = useCallback(() => {
    if (busy) return;
    setHistory((h) => {
      if (h.length === 0) return h;
      const top = h[h.length - 1];
      if (top.t === 'c') {
        setClosed(false);
        // Restore the duplicate end vertex the close dropped, if any.
        const dropped = top.dropped;
        if (dropped) setVertices((v) => [...v, dropped]);
      } else if (top.t === 'v') setVertices((v) => v.slice(0, -1));
      else if (top.t === 'l') setLabels((l) => l.slice(0, -1));
      return h.slice(0, -1);
    });
    void Haptics.selectionAsync();
  }, [busy]);

  const onClear = useCallback(() => {
    if (busy) return;
    const doClear = () => {
      setVertices([]);
      setLabels([]);
      setClosed(false);
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

  const onResetView = useCallback(() => {
    setTransform({ tx: 0, ty: 0, scale: 1 });
    void Haptics.selectionAsync();
  }, []);

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

  // --- GPS pin (carried over from #655) ---
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
      // that frames the whole sketch, wait for a paint (two rAFs ≈ one
      // committed frame), capture, then restore the user's view. Saving
      // the live viewport cropped or blanked whatever was panned/zoomed
      // out of sight. The toast + Android label card live OUTSIDE the
      // ref'd canvas view, so they can never be baked into the PNG.
      const userTransform = transform;
      const fit = fitTransformForCapture(vertices, labels, size.w, size.h);
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
        vector: { version: 1, pxPerFoot, vertices, labels, closed },
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
    vertices,
    labels,
    closed,
    pinnedGeo,
    pinnedAt,
    heading,
  ]);

  const wallD = polylineD(vertices, closed);
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

        {/* Grid / scale controls (carried over). */}
        <View style={styles.controls}>
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
              <Text style={[styles.chipLabel, snapActive && styles.chipLabelOn]}>
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
        </View>

        {/* Mode toggle. */}
        <View style={styles.modeRow}>
          <Segmented options={MODE_OPTIONS} value={mode} onChange={setMode} />
          {mode === 'pan' ? (
            <Pressable style={styles.resetChip} onPress={onResetView}>
              <Ionicons name="scan-outline" size={14} color={Brand.navyDeep} />
              <Text style={styles.chipLabel}>Reset</Text>
            </Pressable>
          ) : null}
        </View>

        {/* Precise-entry pad — only in Draw mode. */}
        {mode === 'draw' ? (
          <View style={styles.padWrap}>
            <Text style={styles.padTitle}>
              Distance + direction (screen-relative)
            </Text>
            <View style={styles.pad}>
              {(['up-left', 'up', 'up-right'] as Dir8[]).map((d) => (
                <ArrowButton
                  key={d}
                  dir={d}
                  disabled={busy || closed}
                  onPress={onArrow}
                />
              ))}
            </View>
            <View style={styles.pad}>
              <ArrowButton
                dir="left"
                disabled={busy || closed}
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
                disabled={busy || closed}
                onPress={onArrow}
              />
            </View>
            <View style={styles.pad}>
              {(['down-left', 'down', 'down-right'] as Dir8[]).map((d) => (
                <ArrowButton
                  key={d}
                  dir={d}
                  disabled={busy || closed}
                  onPress={onArrow}
                />
              ))}
            </View>
          </View>
        ) : null}

        {/* The captured surface. Only the ref'd inner View rasterizes on
            Save; the toast + Android label card are SIBLINGS in the wrap
            so they can never be baked into the PNG. */}
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

                  {/* Walls. */}
                  {wallD ? (
                    <Path
                      d={wallD}
                      stroke={STROKE_COLOR}
                      strokeWidth={STROKE_WIDTH * invScale}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill={closed ? FILL_COLOR : 'none'}
                    />
                  ) : null}

                  {/* Vertices — last one highlighted as the active endpoint. */}
                  {vertices.map((p, i) => {
                    const isLast = i === vertices.length - 1 && !closed;
                    return (
                      <Circle
                        key={`pt${i}`}
                        cx={p.x}
                        cy={p.y}
                        r={(isLast ? 6 : 4) * invScale}
                        fill={isLast ? Brand.gold : Brand.navyDeep}
                        stroke={Brand.cream}
                        strokeWidth={invScale}
                      />
                    );
                  })}

                  {/* Segment dimensions at each midpoint. */}
                  {segs.map((s, i) => (
                    <SvgText
                      key={`seg${i}`}
                      x={s.mid.x}
                      y={s.mid.y - 4 * invScale}
                      fill={Brand.navyDeep}
                      fontSize={12 * invScale}
                      fontWeight="700"
                      textAnchor="middle"
                    >
                      {segLabels[i]}
                    </SvgText>
                  ))}

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

              {/* North arrow (screen space; carried over). */}
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
                        : 'Tap to drop points, or use the pad above'}
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

        {/* Measurement readout. */}
        <View style={styles.readout}>
          {closed && crossed ? (
            // Self-intersecting outline → the shoelace area is silently
            // wrong. Warn instead of showing a bogus number; keep the
            // perimeter, which is still meaningful.
            <Text style={styles.readoutWarn}>
              Walls cross — fix the outline
              <Text style={styles.readoutPerim}>
                {'   ·   '}Perimeter {perimeter.toFixed(1)} ft
              </Text>
            </Text>
          ) : closed && area > 0 ? (
            <Text style={styles.readoutArea}>
              Area {area.toFixed(1)} sq ft
              <Text style={styles.readoutPerim}>
                {'   ·   '}Perimeter {perimeter.toFixed(1)} ft
              </Text>
            </Text>
          ) : vertices.length >= 2 ? (
            <Text style={styles.readoutPerim}>
              Path {perimeter.toFixed(1)} ft · tap “Close shape” for area
            </Text>
          ) : (
            <Text style={styles.readoutPerim}>
              {vertices.length === 1
                ? 'One point placed — add the next'
                : 'No points yet'}
            </Text>
          )}
        </View>

        <View style={styles.toolbar}>
          <Pressable
            style={({ pressed }) => [
              styles.toolButton,
              (history.length === 0 || busy) && styles.toolButtonDisabled,
              pressed && styles.toolButtonPressed,
            ]}
            onPress={onUndo}
            disabled={history.length === 0 || busy}
          >
            <Text style={styles.toolLabel}>Undo</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.toolButton,
              (!hasContent || busy) && styles.toolButtonDisabled,
              pressed && styles.toolButtonPressed,
            ]}
            onPress={onClear}
            disabled={!hasContent || busy}
          >
            <Text style={styles.toolLabel}>Clear</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.toolButton,
              (closed || vertices.length < 3 || busy) &&
                styles.toolButtonDisabled,
              pressed && styles.toolButtonPressed,
            ]}
            onPress={onCloseShape}
            disabled={closed || vertices.length < 3 || busy}
          >
            <Text style={styles.toolLabel}>
              {closed ? 'Closed' : 'Close shape'}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.saveButton,
              (!hasContent || busy) && styles.saveButtonDisabled,
              pressed && hasContent && !busy && styles.saveButtonPressed,
            ]}
            onPress={onSave}
            disabled={!hasContent || busy}
          >
            {busy ? (
              <ActivityIndicator color={Brand.cream} />
            ) : (
              <Text style={styles.saveLabel}>
                {savedIdRef.current ? 'Update' : 'Save'}
              </Text>
            )}
          </Pressable>
        </View>
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

  controls: {
    paddingHorizontal: Spacing.three,
    marginBottom: Spacing.one,
    gap: Spacing.one,
  },
  controlRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  controlLabel: {
    width: 40,
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

  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    marginBottom: Spacing.one,
  },
  resetChip: {
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

  padWrap: {
    paddingHorizontal: Spacing.three,
    marginBottom: Spacing.one,
    alignItems: 'center',
  },
  padTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: Brand.inkMuted,
    marginBottom: Spacing.one,
  },
  pad: { flexDirection: 'row', gap: Spacing.two, marginBottom: Spacing.two },
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
  // overlays as SIBLINGS of the ref'd canvas so captureRef can never
  // rasterize them into the saved PNG.
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

  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  toolButton: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    borderRadius: Radius.md,
    backgroundColor: Brand.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  toolButtonDisabled: { opacity: 0.5 },
  toolButtonPressed: { opacity: 0.8 },
  toolLabel: { color: Brand.navyDeep, fontSize: 14, fontWeight: '600' },
  saveButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.three,
    borderRadius: Radius.md,
    backgroundColor: Brand.navyDeep,
  },
  saveButtonDisabled: { opacity: 0.6 },
  saveButtonPressed: { opacity: 0.85 },
  saveLabel: { color: Brand.cream, fontSize: 16, fontWeight: '700' },
});
