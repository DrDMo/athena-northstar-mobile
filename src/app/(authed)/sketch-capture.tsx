/**
 * Sketch capture — a finger / stylus drawing surface that exports to a
 * PNG and queues it like any other capture.
 *
 * Drawing + export path (all SDK 56-compatible; verified against the
 * versioned docs at https://docs.expo.dev/versions/v56.0.0/):
 *
 *   - TOUCH: react-native-gesture-handler `Gesture.Pan()` inside a
 *     `GestureDetector`. We call `.runOnJS(true)` so the begin/update/end
 *     callbacks run on the JS thread and can `setState` directly — no
 *     reanimated worklet / `runOnJS()` wrapping needed. The root layout
 *     mounts a `GestureHandlerRootView` (#518); this screen also wraps
 *     its own (nesting is harmless) so gestures work regardless.
 *
 *   - RENDER: react-native-svg. Each stroke is an SVG `<Path>` whose `d`
 *     is built from the captured points (`M x y L x y …`). A graph-paper
 *     grid (`<Line>`s) renders FIRST, so completed strokes plus the
 *     in-progress stroke sit on top, all inside one `<Svg>`.
 *
 *   - EXPORT: react-native-view-shot `captureRef(ref, { format: 'png',
 *     result: 'tmpfile' })` rasterizes the canvas View to a temp PNG and
 *     returns its file URI (the interop table lists react-native-svg as
 *     capturable on iOS + Android). That URI is the capture's local file.
 *
 * #655 enhancements (all additive; the draw/export/sync flow is
 * unchanged for existing captures):
 *
 *   1. Adjustable grid — Off / Fine / Medium / Coarse graph paper behind
 *      the ink. It's part of the rasterized PNG (a helpful background),
 *      never part of stroke data — the `d` strings carry no grid info.
 *   2. Real-world scale — feet-per-grid-square (1 / 2 / 5 ft), shown as
 *      "1 sq = N ft" and stored in the capture meta.
 *   3. Snap-to-grid — snaps each stroke point to the nearest grid
 *      intersection for clean floor-plan walls; off = freehand as before.
 *   4. GPS binding — a "Pin location" button captures the current fix via
 *      the shared `getCurrentGeo` helper (same permission + graceful-deny
 *      path as photo/address capture) and shows a "📍 lat, lng (±N m)"
 *      chip.
 *   5. North arrow — a compass heading from `expo-location`
 *      (`watchHeadingAsync`, no new native module) rotates a small north
 *      arrow on the surface; the heading is recorded in the meta. If the
 *      device has no compass, the arrow just stays hidden.
 *
 * On Save we enqueue a `kind: 'sketch'` capture with the PNG as the
 * `file` part — the exact same offline sync path as a photo
 * (`enqueue` → `syncNow` → `POST /v1/captures`) — plus the grid/scale/
 * snap/gps/heading settings on `meta.sketch` (additive, all optional).
 * Controls: Undo (pop the last stroke) and Clear (drop all strokes).
 */

import { Ionicons } from '@react-native-vector-icons/ionicons/static';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Line, Path } from 'react-native-svg';
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
import { enqueue } from '@/lib/queue';
import { syncNow } from '@/lib/sync';

/** A single point in canvas-local coordinates. */
type Pt = { x: number; y: number };

/** On-screen pixel spacing per grid density. 'off' → no grid. */
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

const STROKE_COLOR = Brand.navyDeep;
const STROKE_WIDTH = 3;
/** Subtle graph-paper gray on the white sheet. */
const GRID_COLOR = '#e2ddcc';

/**
 * Turn a point list into an SVG path `d`. One point renders as a tiny
 * dot (a zero-length line) so a single tap still leaves a mark.
 */
function toPathD(points: Pt[]): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  const head = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
  if (rest.length === 0) {
    // Zero-length line → a dot under round linecap.
    return `${head} L ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
  }
  const tail = rest
    .map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');
  return `${head} ${tail}`;
}

/** Snap a point to the nearest grid intersection for the given spacing. */
function snapPoint(p: Pt, spacing: number): Pt {
  if (spacing <= 0) return p;
  return {
    x: Math.round(p.x / spacing) * spacing,
    y: Math.round(p.y / spacing) * spacing,
  };
}

/** Interior grid-line offsets (skip the 0 / edge lines) for a spacing. */
function gridLines(
  spacing: number,
  w: number,
  h: number,
): { xs: number[]; ys: number[] } {
  if (spacing <= 0 || w <= 0 || h <= 0) return { xs: [], ys: [] };
  const xs: number[] = [];
  for (let x = spacing; x < w; x += spacing) xs.push(x);
  const ys: number[] = [];
  for (let y = spacing; y < h; y += spacing) ys.push(y);
  return { xs, ys };
}

/** Compact segmented control shared by the grid + scale pickers. */
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
              style={[
                styles.segmentLabel,
                active && styles.segmentLabelActive,
              ]}
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
  const [strokes, setStrokes] = useState<string[]>([]); // completed paths (d)
  const [current, setCurrent] = useState<Pt[]>([]); // in-progress points
  const [busy, setBusy] = useState(false);
  // Canvas size, measured on layout — drives the grid AND clamps stroke
  // points inside bounds. State (not a ref) is safe here: the pan gesture
  // is rebuilt every render, so its closure always sees the latest size.
  const [size, setSize] = useState({ w: 0, h: 0 });

  // #655 controls.
  const [gridSize, setGridSize] = useState<SketchGridSize>('medium');
  const [scaleFeet, setScaleFeet] = useState<number>(1);
  const [snapEnabled, setSnapEnabled] = useState(false);

  // #655 GPS binding.
  const [pinnedGeo, setPinnedGeo] =
    useState<NonNullable<CaptureMeta['geo']> | null>(null);
  const [pinnedAt, setPinnedAt] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const [locationNote, setLocationNote] = useState<string | null>(null);

  // #655 north heading (from expo-location; no new native module).
  const [heading, setHeading] = useState<number | null>(null);
  const headingSubRef =
    useRef<Awaited<ReturnType<typeof Location.watchHeadingAsync>> | null>(null);
  const lastHeadingRef = useRef<number | null>(null);

  const spacing = GRID_SPACING[gridSize];
  const snapActive = snapEnabled && spacing > 0;
  const grid = gridLines(spacing, size.w, size.h);

  const onCanvasLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ w: width, h: height });
  }, []);

  // Start (or re-start) the compass watch. Idempotent — a live
  // subscription short-circuits. Wrapped so a device with no compass (or
  // location not yet permitted) just leaves the arrow hidden, no crash.
  const startHeading = useCallback(async () => {
    if (headingSubRef.current) return;
    try {
      headingSubRef.current = await Location.watchHeadingAsync((h) => {
        // trueHeading is -1 until a location fix resolves true north;
        // fall back to magnetic. Ignore junk readings.
        const deg =
          h.trueHeading != null && h.trueHeading >= 0
            ? h.trueHeading
            : h.magHeading;
        if (typeof deg !== 'number' || Number.isNaN(deg) || deg < 0) return;
        // Throttle re-renders: only update on a ≥2° change.
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

  // Pan gesture. runOnJS(true): callbacks run on the JS thread so we can
  // call setState directly (no worklet). x/y are local to the attached
  // view (the canvas), which is exactly the drawing coordinate space.
  const clamp = (x: number, y: number): Pt => {
    const { w, h } = size;
    return {
      x: w ? Math.max(0, Math.min(x, w)) : x,
      y: h ? Math.max(0, Math.min(y, h)) : y,
    };
  };

  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin((e) => {
      const p = clamp(e.x, e.y);
      setCurrent([snapActive ? snapPoint(p, spacing) : p]);
    })
    .onUpdate((e) => {
      const p = clamp(e.x, e.y);
      const np = snapActive ? snapPoint(p, spacing) : p;
      setCurrent((prev) => {
        // When snapping, skip a point identical to the last so snapped
        // walls stay tidy polylines instead of piling up duplicates.
        if (snapActive && prev.length > 0) {
          const lastPt = prev[prev.length - 1];
          if (lastPt.x === np.x && lastPt.y === np.y) return prev;
        }
        return [...prev, np];
      });
    })
    .onEnd(() => {
      setCurrent((prev) => {
        if (prev.length > 0) {
          const d = toPathD(prev);
          setStrokes((s) => [...s, d]);
        }
        return [];
      });
    });

  const hasInk = strokes.length > 0 || current.length > 0;

  const onUndo = useCallback(() => {
    if (busy) return;
    // Undo the in-progress stroke first if any, else pop the last one.
    setCurrent((cur) => {
      if (cur.length > 0) return [];
      setStrokes((s) => s.slice(0, -1));
      return cur;
    });
    void Haptics.selectionAsync();
  }, [busy]);

  const onClear = useCallback(() => {
    if (busy) return;
    setStrokes([]);
    setCurrent([]);
    void Haptics.selectionAsync();
  }, [busy]);

  const onPinLocation = useCallback(async () => {
    if (pinning) return;
    setPinning(true);
    setLocationNote(null);
    try {
      // Shared one-shot geotag — same accuracy + permission handling as
      // photo / address capture. Resolves to undefined when denied.
      const fix = await getCurrentGeo({
        onDenied: () =>
          setLocationNote(
            'Location is blocked. Enable it in Settings to pin this sketch to the site.',
          ),
      });
      if (!fix) {
        // A one-time deny (canAskAgain still true) doesn't fire onDenied;
        // set a soft hint so the user knows nothing was pinned.
        setLocationNote(
          (n) => n ?? 'No location yet — allow location access to pin the site.',
        );
        return;
      }
      setPinnedGeo(fix);
      setPinnedAt(new Date().toISOString());
      void Haptics.selectionAsync();
      // Location is granted now, so the compass can resolve true north.
      void startHeading();
    } catch (e) {
      setLocationNote(`Couldn't get a location fix: ${(e as Error).message}`);
    } finally {
      setPinning(false);
    }
  }, [pinning, startHeading]);

  const onSave = useCallback(async () => {
    if (busy) return;
    if (!hasInk) {
      Alert.alert('Nothing to save', 'Draw something before saving.');
      return;
    }
    setBusy(true);
    try {
      // Rasterize the canvas to a PNG temp file. The returned string is
      // the file URI we hand to the sync layer as the `file` part.
      const uri = await captureRef(canvasRef, {
        format: 'png',
        quality: 1,
        result: 'tmpfile',
      });

      // File to an assignment now, or keep in the inbox. Offline picker
      // failure isn't fatal — fall back to inbox.
      let assignmentId: string | null = null;
      try {
        assignmentId = await pickAssignment();
      } catch {
        assignmentId = null;
      }

      const meta: CaptureMeta = {
        id: newCaptureId(),
        kind: 'sketch',
        localUri: uri,
        capturedAt: new Date().toISOString(),
        caption: 'Field sketch',
        status: 'pending',
      };
      if (assignmentId) meta.assignmentId = assignmentId;

      // Pinned site geo → the standard `geo` field (the backend consumes
      // it like a photo's geotag) AND mirrored into the sketch-specific
      // record below with the pin timestamp (#655).
      if (pinnedGeo) meta.geo = pinnedGeo;

      const sketchMeta: SketchMeta = {
        gridSize,
        scaleFeetPerSquare: scaleFeet,
        snapEnabled: snapActive,
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
      meta.sketch = sketchMeta;

      await enqueue(meta);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void syncNow();
      router.back();
    } catch (e) {
      Alert.alert('Save failed', (e as Error).message);
    } finally {
      // Always release the busy lock so the controls (Cancel especially)
      // can never be stranded disabled if the picker resolves oddly.
      setBusy(false);
    }
  }, [
    busy,
    hasInk,
    router,
    gridSize,
    scaleFeet,
    snapActive,
    pinnedGeo,
    pinnedAt,
    heading,
  ]);

  const currentD = current.length > 0 ? toPathD(current) : '';

  return (
    <GestureHandlerRootView style={styles.flex}>
      <SafeAreaView style={styles.flex} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          {/* Never gated on `busy`: a stranded save must not trap the
              user on a screen holding unsaved strokes. router.back()
              during an in-flight save is safe — the enqueue completes. */}
          <Pressable
            style={[styles.closeButton, styles.closeRow]}
            onPress={() => router.back()}
          >
            <Ionicons name="arrow-back" size={15} color={Brand.navyDeep} />
            <Text style={styles.closeLabel}>Cancel</Text>
          </Pressable>
          <Text style={styles.topTitle}>Sketch</Text>
          <View style={styles.closeButton} />
        </View>

        <Text style={styles.hint}>
          Draw the floor plan or site detail with your finger or stylus.
        </Text>

        {/* #655 controls: grid density, real-world scale, snap, pin. */}
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
          <Text style={styles.scaleReadout}>
            1 square = {scaleFeet} ft
            {gridSize === 'off' ? ' · grid hidden' : ''}
          </Text>

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
                Snap to grid
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
                {pinnedGeo ? 'Re-pin location' : 'Pin location'}
              </Text>
            </Pressable>
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

        {/* The captured view. White background so the PNG isn't
            transparent + reads as a sheet of paper. */}
        <GestureDetector gesture={pan}>
          <View
            ref={canvasRef}
            collapsable={false}
            style={styles.canvas}
            onLayout={onCanvasLayout}
          >
            <Svg style={StyleSheet.absoluteFill}>
              {/* Graph-paper grid, drawn first so strokes sit on top. It
                  appears in the rasterized PNG (a helpful background) but
                  is never part of stroke data — the `d` strings carry no
                  grid info. */}
              {grid.xs.map((x) => (
                <Line
                  key={`vx${x}`}
                  x1={x}
                  y1={0}
                  x2={x}
                  y2={size.h}
                  stroke={GRID_COLOR}
                  strokeWidth={1}
                />
              ))}
              {grid.ys.map((y) => (
                <Line
                  key={`hy${y}`}
                  x1={0}
                  y1={y}
                  x2={size.w}
                  y2={y}
                  stroke={GRID_COLOR}
                  strokeWidth={1}
                />
              ))}
              {strokes.map((d, i) => (
                <Path
                  key={`s${i}`}
                  d={d}
                  stroke={STROKE_COLOR}
                  strokeWidth={STROKE_WIDTH}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              ))}
              {currentD ? (
                <Path
                  d={currentD}
                  stroke={STROKE_COLOR}
                  strokeWidth={STROKE_WIDTH}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              ) : null}
            </Svg>

            {/* North arrow — rotates toward real north; hidden when the
                device has no compass. pointerEvents none so it never
                blocks drawing (it does appear in the PNG, which is
                desirable on a floor plan). */}
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

            {!hasInk ? (
              <View style={styles.emptyHint} pointerEvents="none">
                <Text style={styles.emptyHintLabel}>Draw here</Text>
              </View>
            ) : null}
          </View>
        </GestureDetector>

        <View style={styles.toolbar}>
          <Pressable
            style={({ pressed }) => [
              styles.toolButton,
              (!hasInk || busy) && styles.toolButtonDisabled,
              pressed && hasInk && !busy && styles.toolButtonPressed,
            ]}
            onPress={onUndo}
            disabled={!hasInk || busy}
          >
            <Text style={styles.toolLabel}>Undo</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.toolButton,
              (!hasInk || busy) && styles.toolButtonDisabled,
              pressed && hasInk && !busy && styles.toolButtonPressed,
            ]}
            onPress={onClear}
            disabled={!hasInk || busy}
          >
            <Text style={styles.toolLabel}>Clear</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.saveButton,
              (!hasInk || busy) && styles.saveButtonDisabled,
              pressed && hasInk && !busy && styles.saveButtonPressed,
            ]}
            onPress={onSave}
            disabled={!hasInk || busy}
          >
            {busy ? (
              <ActivityIndicator color={Brand.cream} />
            ) : (
              <Text style={styles.saveLabel}>Save sketch</Text>
            )}
          </Pressable>
        </View>
      </SafeAreaView>
    </GestureHandlerRootView>
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
    paddingBottom: Spacing.two,
  },
  closeButton: {
    minWidth: 72,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  closeRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  closeLabel: { color: Brand.navyDeep, fontSize: 15, fontWeight: '600' },
  topTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Brand.navyDeep,
  },
  hint: {
    fontSize: 13,
    color: Brand.inkMuted,
    textAlign: 'center',
    paddingHorizontal: Spacing.four,
    marginBottom: Spacing.two,
  },
  controls: {
    paddingHorizontal: Spacing.three,
    marginBottom: Spacing.two,
    gap: Spacing.two,
  },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
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
  segmentItem: {
    flex: 1,
    paddingVertical: Spacing.two,
    alignItems: 'center',
  },
  segmentItemActive: { backgroundColor: Brand.navyDeep },
  segmentLabel: { fontSize: 13, fontWeight: '600', color: Brand.navyDeep },
  segmentLabelActive: { color: Brand.cream },
  scaleReadout: {
    fontSize: 12,
    color: Brand.inkFaint,
    marginLeft: 44 + Spacing.two,
  },
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
  canvas: {
    flex: 1,
    marginHorizontal: Spacing.three,
    marginBottom: Spacing.three,
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
  northLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: Brand.red,
    lineHeight: 13,
  },
  emptyHint: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyHintLabel: {
    fontSize: 16,
    color: Brand.inkFaint,
    fontWeight: '600',
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  toolButton: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    borderRadius: Radius.md,
    backgroundColor: Brand.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  toolButtonDisabled: { opacity: 0.5 },
  toolButtonPressed: { opacity: 0.8 },
  toolLabel: { color: Brand.navyDeep, fontSize: 15, fontWeight: '600' },
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
