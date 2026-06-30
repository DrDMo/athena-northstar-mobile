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
 *     is built from the captured points (`M x y L x y …`). Completed
 *     strokes plus the in-progress stroke render inside one `<Svg>`.
 *
 *   - EXPORT: react-native-view-shot `captureRef(ref, { format: 'png',
 *     result: 'tmpfile' })` rasterizes the canvas View to a temp PNG and
 *     returns its file URI (the interop table lists react-native-svg as
 *     capturable on iOS + Android). That URI is the capture's local file.
 *
 * On Save we enqueue a `kind: 'sketch'` capture with the PNG as the
 * `file` part — the exact same offline sync path as a photo
 * (`enqueue` → `syncNow` → `POST /v1/captures`). Controls: Undo (pop the
 * last stroke) and Clear (drop all strokes).
 */

import { Ionicons } from '@react-native-vector-icons/ionicons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
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
import Svg, { Path } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';

import { Brand, Radius, Spacing } from '@/constants/theme';
import { pickAssignment } from '@/lib/assignment-picker';
import { type CaptureMeta, newCaptureId } from '@/lib/capture';
import { enqueue } from '@/lib/queue';
import { syncNow } from '@/lib/sync';

/** A single point in canvas-local coordinates. */
type Pt = { x: number; y: number };

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

const STROKE_COLOR = Brand.navyDeep;
const STROKE_WIDTH = 3;

export default function SketchCaptureScreen() {
  const router = useRouter();
  const canvasRef = useRef<View>(null);
  const [strokes, setStrokes] = useState<string[]>([]); // completed paths (d)
  const [current, setCurrent] = useState<Pt[]>([]); // in-progress points
  const [busy, setBusy] = useState(false);
  // Canvas size, measured on layout — used to clamp points inside bounds.
  const sizeRef = useRef({ w: 0, h: 0 });

  const onCanvasLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    sizeRef.current = { w: width, h: height };
  }, []);

  // Pan gesture. runOnJS(true): callbacks run on the JS thread so we can
  // call setState directly (no worklet). x/y are local to the attached
  // view (the canvas), which is exactly the drawing coordinate space.
  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin((e) => {
      const { w, h } = sizeRef.current;
      const x = w ? Math.max(0, Math.min(e.x, w)) : e.x;
      const y = h ? Math.max(0, Math.min(e.y, h)) : e.y;
      setCurrent([{ x, y }]);
    })
    .onUpdate((e) => {
      const { w, h } = sizeRef.current;
      const x = w ? Math.max(0, Math.min(e.x, w)) : e.x;
      const y = h ? Math.max(0, Math.min(e.y, h)) : e.y;
      setCurrent((prev) => [...prev, { x, y }]);
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
  }, [busy, hasInk, router]);

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
