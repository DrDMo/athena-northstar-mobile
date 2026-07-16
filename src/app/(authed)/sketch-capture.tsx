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
 *   - Pan mode: one-finger drag pans, pinch zooms. Taps do NOT add
 *     vertices. A screen tap in Draw mode is mapped back through the
 *     pan/zoom transform to canvas (world) coords before placement.
 *   - Undo (last vertex/label/close, in order) + Clear.
 *   - Label tool: tap a spot, enter text, drop a floating label.
 *   - Save in place: rasterize to PNG (react-native-view-shot) + enqueue
 *     like any capture, AND persist the full SketchDoc on
 *     meta.sketch.vector so it round-trips. Stays on the canvas.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { pickAssignment } from '@/lib/assignment-picker';
import {
  type CaptureMeta,
  getCurrentGeo,
  newCaptureId,
  type SketchGridSize,
  type SketchMeta,
} from '@/lib/capture';
import { enqueue, updateItem } from '@/lib/queue';
import {
  areaSquareFeet,
  type Dir8,
  endpointOffset,
  perimeterFeet,
  pxPerFootFromGrid,
  segments,
  type SketchDoc,
  type SketchLabel,
  type SketchVertex,
} from '@/lib/sketch-model';
import { syncNow } from '@/lib/sync';

/** Editor interaction mode. */
type Mode = 'draw' | 'pan' | 'label';

/** The pan/zoom transform applied to the SVG content group. */
type Transform = { tx: number; ty: number; scale: number };

/** One undoable action, newest last — lets Undo remove in insert order. */
type Action = 'v' | 'l' | 'c'; // vertex | label | close

/** On-screen pixel spacing per grid density. 'off' → no grid drawn. */
const GRID_SPACING: Record<SketchGridSize, number> = {
  off: 0,
  fine: 16,
  medium: 24,
  coarse: 40,
};

/** Nominal spacing used to calibrate pxPerFoot when the grid is hidden. */
const FALLBACK_SPACING = GRID_SPACING.medium;

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
 * World-space grid lines covering the currently visible region. Grid
 * lives in WORLD coords (inside the transformed group) so snapping,
 * vertices, and grid squares all agree under pan/zoom. Count is capped
 * so zooming far out can't explode the line count.
 */
function worldGridLines(
  spacing: number,
  t: Transform,
  w: number,
  h: number,
): { xs: number[]; ys: number[] } {
  if (spacing <= 0 || w <= 0 || h <= 0 || t.scale <= 0) return { xs: [], ys: [] };
  const left = (0 - t.tx) / t.scale;
  const right = (w - t.tx) / t.scale;
  const top = (0 - t.ty) / t.scale;
  const bottom = (h - t.ty) / t.scale;
  const xs: number[] = [];
  const ys: number[] = [];
  if ((right - left) / spacing <= MAX_GRID_LINES) {
    for (let x = Math.floor(left / spacing) * spacing; x <= right; x += spacing) {
      xs.push(x);
    }
  }
  if ((bottom - top) / spacing <= MAX_GRID_LINES) {
    for (let y = Math.floor(top / spacing) * spacing; y <= bottom; y += spacing) {
      ys.push(y);
    }
  }
  return { xs, ys };
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

  // First save picks the assignment + mints the capture id; later saves
  // update that same queue item in place (Save stays on the canvas).
  const savedIdRef = useRef<string | null>(null);
  const savedAssignmentIdRef = useRef<string | null>(null);

  // --- Carried-over controls (grid / scale / snap / GPS / heading) ---
  const [gridSize, setGridSize] = useState<SketchGridSize>('medium');
  const [scaleFeet, setScaleFeet] = useState<number>(1);
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
  // pxPerFoot is always > 0: fall back to a nominal spacing when the grid
  // is hidden so lengths/area stay computable (scaleFeet is always ≥ 1).
  const pxPerFoot = pxPerFootFromGrid(
    spacing > 0 ? spacing : FALLBACK_SPACING,
    scaleFeet,
  );

  const doc: SketchDoc = useMemo(
    () => ({ version: 1, pxPerFoot, vertices, labels, closed }),
    [pxPerFoot, vertices, labels, closed],
  );
  const segs = useMemo(() => segments(doc), [doc]);
  const perimeter = useMemo(() => perimeterFeet(doc), [doc]);
  const area = useMemo(() => areaSquareFeet(doc), [doc]);
  const hasContent = vertices.length > 0 || labels.length > 0;

  const grid = worldGridLines(spacing, transform, size.w, size.h);

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
    setHistory((h) => [...h, 'v']);
    void Haptics.selectionAsync();
  }, []);

  const addLabel = useCallback((l: SketchLabel) => {
    setLabels((ls) => [...ls, l]);
    setHistory((h) => [...h, 'l']);
    setMode('draw');
    void Haptics.selectionAsync();
  }, []);

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
      if (busy) return;
      if (closed) {
        Alert.alert('Shape is closed', 'Undo the close to keep adding points.');
        return;
      }
      const feet = parseFloat(distanceText);
      if (!Number.isFinite(feet) || feet <= 0) {
        Alert.alert(
          'Enter a distance',
          'Type a distance in feet, then tap a direction arrow.',
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
        setHistory((h) => [...h, 'v', 'v']);
      } else {
        const last = vertices[vertices.length - 1];
        setVertices((v) => [...v, { x: last.x + dx, y: last.y + dy }]);
        setHistory((h) => [...h, 'v']);
      }
      void Haptics.selectionAsync();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, closed, distanceText, pxPerFoot, vertices, size, transform, snapActive, spacing],
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
    setClosed(true);
    setHistory((h) => [...h, 'c']);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [busy, closed, vertices.length]);

  const onUndo = useCallback(() => {
    if (busy) return;
    setHistory((h) => {
      if (h.length === 0) return h;
      const top = h[h.length - 1];
      if (top === 'c') setClosed(false);
      else if (top === 'v') setVertices((v) => v.slice(0, -1));
      else if (top === 'l') setLabels((l) => l.slice(0, -1));
      return h.slice(0, -1);
    });
    void Haptics.selectionAsync();
  }, [busy]);

  const onClear = useCallback(() => {
    if (busy) return;
    setVertices([]);
    setLabels([]);
    setClosed(false);
    setHistory([]);
    setLabelDraft(null);
    void Haptics.selectionAsync();
  }, [busy]);

  const onResetView = useCallback(() => {
    setTransform({ tx: 0, ty: 0, scale: 1 });
    void Haptics.selectionAsync();
  }, []);

  // --- Gestures (rebuilt each render so closures see current state) ---
  const panStart = useRef({ tx: 0, ty: 0 });
  const pinchStart = useRef({ scale: 1, tx: 0, ty: 0, fx: 0, fy: 0 });

  const tapGesture = Gesture.Tap()
    .runOnJS(true)
    .enabled(mode !== 'pan')
    .maxDistance(14)
    .onEnd((e, success) => {
      if (success) onCanvasTap(e.x, e.y);
    });

  const panGesture = Gesture.Pan()
    .runOnJS(true)
    .enabled(mode === 'pan')
    .minDistance(1)
    .onBegin(() => {
      panStart.current = { tx: transform.tx, ty: transform.ty };
    })
    .onUpdate((e) => {
      setTransform((t) => ({
        ...t,
        tx: panStart.current.tx + e.translationX,
        ty: panStart.current.ty + e.translationY,
      }));
    });

  const pinchGesture = Gesture.Pinch()
    .runOnJS(true)
    .enabled(mode === 'pan')
    .onBegin((e) => {
      pinchStart.current = {
        scale: transform.scale,
        tx: transform.tx,
        ty: transform.ty,
        fx: e.focalX,
        fy: e.focalY,
      };
    })
    .onUpdate((e) => {
      const s0 = pinchStart.current;
      const newScale = clampScale(s0.scale * e.scale);
      // Keep the world point under the (start) focal fixed while zooming.
      const worldFx = (s0.fx - s0.tx) / s0.scale;
      const worldFy = (s0.fy - s0.ty) / s0.scale;
      setTransform({
        scale: newScale,
        tx: s0.fx - worldFx * newScale,
        ty: s0.fy - worldFy * newScale,
      });
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

  // --- Save (rasterize + enqueue/update, persist the vector doc) ---
  const onSave = useCallback(async () => {
    if (busy) return;
    if (!hasContent) {
      Alert.alert('Nothing to save', 'Add points or a label before saving.');
      return;
    }
    setBusy(true);
    setSaveNote(null);
    try {
      const uri = await captureRef(canvasRef, {
        format: 'png',
        quality: 1,
        result: 'tmpfile',
      });

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

      if (savedIdRef.current == null) {
        const id = newCaptureId();
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
        await enqueue(meta);
        savedIdRef.current = id;
      } else {
        // Subsequent save → update the same queue item in place and
        // re-queue it for upload with the fresh PNG + doc.
        const patch: Partial<CaptureMeta> = {
          localUri: uri,
          capturedAt: new Date().toISOString(),
          status: 'pending',
          lastError: undefined,
          sketch: sketchMeta,
        };
        if (assignmentId) patch.assignmentId = assignmentId;
        if (pinnedGeo) patch.geo = pinnedGeo;
        await updateItem(savedIdRef.current, patch);
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
              onChange={setGridSize}
            />
          </View>
          <View style={styles.controlRow}>
            <Text style={styles.controlLabel}>SCALE</Text>
            <Segmented
              options={SCALE_OPTIONS}
              value={scaleFeet}
              onChange={setScaleFeet}
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

        {/* The captured surface. */}
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
                {/* Graph-paper grid (world space). */}
                {grid.xs.map((x, i) => (
                  <Line
                    key={`vx${i}`}
                    x1={x}
                    y1={(0 - transform.ty) / transform.scale}
                    x2={x}
                    y2={(size.h - transform.ty) / transform.scale}
                    stroke={GRID_COLOR}
                    strokeWidth={invScale}
                  />
                ))}
                {grid.ys.map((y, i) => (
                  <Line
                    key={`hy${i}`}
                    x1={(0 - transform.tx) / transform.scale}
                    y1={y}
                    x2={(size.w - transform.tx) / transform.scale}
                    y2={y}
                    stroke={GRID_COLOR}
                    strokeWidth={invScale}
                  />
                ))}

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
                    {`${s.feet.toFixed(1)}'`}
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
            {saveNote ? (
              <View style={styles.saveToast} pointerEvents="none">
                <Ionicons name="checkmark-circle" size={16} color={Brand.cream} />
                <Text style={styles.saveToastLabel}>{saveNote}</Text>
              </View>
            ) : null}

            {/* Android inline label draft. */}
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
        </GestureDetector>

        {/* Measurement readout. */}
        <View style={styles.readout}>
          {closed && area > 0 ? (
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

  canvas: {
    flex: 1,
    marginHorizontal: Spacing.three,
    marginBottom: Spacing.two,
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
