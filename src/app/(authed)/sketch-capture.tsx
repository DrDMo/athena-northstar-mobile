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
 *   - EDIT AN EXISTING SKETCH (#711): the assignment detail screen's
 *     Edit affordance routes here with `editQueueId` (an unsynced local
 *     capture) or `editServerId` + `assignmentId` (a synced one — the
 *     doc comes off the server's capture list, parsed defensively via
 *     parseSketchVector; docShapes handles legacy single-shape docs).
 *     Saving an edit follows the same supersede pattern as a re-save:
 *     fresh client id, same assignment/workfile linkage, the ORIGINAL
 *     captured_at carried forward (uploaded_at records the edit — a
 *     now() stamp would falsify the audit trail), then best-effort
 *     delete of the superseded server row / removal of the superseded
 *     queue row.
 *   - SESSION ISOLATION (#711 part 2c): the screen stays mounted in the
 *     tab navigator, so its state used to be one global scratch surface
 *     — assignment A's sketch greeted whoever opened the editor next.
 *     Every route into this screen now carries a fresh `entry` param
 *     (the Capture tile and the Edit affordances both stamp one), and a
 *     render-phase session reset keyed on entry/edit params starts a
 *     blank document (or loads the requested capture) on every entry.
 *     There
 *     is deliberately no cross-entry draft: in-progress work survives a
 *     mid-sketch tab flip (params unchanged → no reset), but re-ENTRY
 *     always starts clean, so one assignment's sketch can never
 *     resurface under another. Backing out with unsaved strokes asks
 *     before discarding.
 *   - START-POINT SNAPPING (#711 part 3): a tapped vertex resolves
 *     through resolveSnapPoint — nearest existing vertex of ANY shape
 *     within ~24 dp, else nearest point ON any wall within ~16 dp, else
 *     the grid (when snap is on). Tolerances are dp ÷ zoom, so the
 *     fingertip radius is constant on screen. A gold ring shows the
 *     live snap candidate while the finger is down and flashes on the
 *     just-placed vertex. And when the active shape holds exactly ONE
 *     vertex, the distance pad MOVES that start point instead of
 *     drawing a wall (the pad says so) — fine placement without finger
 *     precision; with ≥2 vertices the pad draws segments as before.
 *   - DYNAMIC ZOOM FLOOR (#711 part 4): the old fixed MIN_SCALE made a
 *     large sketch un-viewable — recenter could fit it, but the next
 *     pinch snapped back to the floor. The floor is now
 *     dynamicMinScale(fit scale): min(static floor, fit × 0.5),
 *     recomputed as the sketch grows. Pan has never been clamped to a
 *     world rect here, so panning at the floor is free.
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
import { useLocalSearchParams, useRouter } from 'expo-router';
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
import { deleteCapture, listAssignmentCaptures } from '@/lib/api';
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
  dynamicMinScale,
  endpointOffset,
  fitTransformForContent,
  hasSelfIntersection,
  parseSketchVector,
  pxPerFootFromGrid,
  rescaleDoc,
  resolveSnapPoint,
  shapeAreaSquareFeet,
  shapeCentroid,
  shapeSegments,
  type SketchDoc,
  type SketchLabel,
  type SketchMetaWire,
  type SketchShape,
  type SketchVertex,
  type SnapResult,
  snapToGrid,
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
 *   - 'm'  the shape's lone start vertex was MOVED by the distance pad
 *          (#711 part 3). Recorded as the DELTA applied (not the old
 *          position — rapid arrow taps outrun React commits, and a
 *          closure-read position goes stale; subtracting a delta is
 *          order-safe). Undo subtracts it. Shape recorded by index like
 *          'c', for the same stability reason.
 */
type Action =
  | { t: 'v' } // vertex added to the active shape
  | { t: 'ns' } // new shape started with its first vertex
  | { t: 'l' } // label added
  | { t: 'c'; shape: number; dropped?: SketchVertex } // shape closed
  | { t: 'm'; shape: number; dx: number; dy: number }; // start vertex moved

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
/**
 * STATIC zoom floor — a small sketch's floor, and the ceiling of the
 * dynamic floor (#711 part 4): the effective minimum each frame is
 * dynamicMinScale(fit scale, MIN_SCALE), so a sketch too big for this
 * floor can still be pinched out to half its fit-all view.
 */
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
/** Cap grid line count when zoomed way out so we never draw thousands. */
const MAX_GRID_LINES = 400;
/** Screen padding around the content in fit-to-content views. */
const FIT_PADDING = 24;
/**
 * Start-point snap tolerances (#711 part 3), in SCREEN dp — divided by
 * the live zoom before hitting resolveSnapPoint (which works in world
 * px), so the fingertip radius is constant on screen at every zoom.
 * Vertex beats wall beats grid; the vertex radius is the generous one
 * because continuing from an existing corner is the common intent.
 */
const SNAP_VERTEX_DP = 24;
const SNAP_SEGMENT_DP = 16;
/** How long the snap ring lingers on a just-placed vertex. */
const SNAP_RING_MS = 650;

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

/**
 * Clamp a zoom to [minScale, MAX_SCALE]. The floor is a parameter
 * (#711 part 4): callers pass the DYNAMIC minimum so pinch can reach a
 * big sketch's fit-all view instead of fighting a fixed 0.25.
 */
function clampScale(s: number, minScale: number = MIN_SCALE): number {
  return Math.max(minScale, Math.min(s, MAX_SCALE));
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
 * Fit-to-content transform over every shape's vertices plus label
 * anchors (#686). Shared by the Save rasterization (saving the
 * as-displayed viewport cropped or blanked whatever the user had
 * panned/zoomed away from), the Recenter button, the on-load framing of
 * an edited sketch (#711 part 2), and the dynamic zoom floor (#711
 * part 4) — the fit math itself now lives in sketch-model
 * ({@link fitTransformForContent}) so the floor is unit-testable and
 * can never disagree with what recenter shows or save captures.
 */
function fitTransformForCapture(
  vertices: SketchVertex[],
  labels: SketchLabel[],
  w: number,
  h: number,
): Transform | null {
  return fitTransformForContent(
    [...vertices, ...labels],
    w,
    h,
    FIT_PADDING,
    MAX_SCALE,
  );
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

/** Defensive read of a stored grid size — junk falls back to medium. */
function normalizeGridSize(v: unknown): SketchGridSize {
  return v === 'off' || v === 'fine' || v === 'medium' || v === 'coarse'
    ? v
    : 'medium';
}

/** Defensive read of a stored feet-per-square — junk falls back to 1. */
function normalizeScaleFeet(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * Convert a server capture's opaque snake_case `meta.sketch` into the
 * local camelCase {@link SketchMeta} (#711 part 2) — the KNOWN fields
 * only. The vector is deliberately left off: the caller parses it via
 * parseSketchVector and re-writes it on save. Unknown/future wire keys
 * are not carried through this path (the outbound sync layer builds the
 * wire from typed fields); editing an unsynced QUEUE row spreads its
 * original camelCase meta instead, which does preserve them.
 */
function sketchMetaFromWire(w: SketchMetaWire | undefined): SketchMeta {
  const out: SketchMeta = {};
  if (!w) return out;
  out.gridSize = normalizeGridSize(w.grid_size);
  out.scaleFeetPerSquare = normalizeScaleFeet(w.scale_feet_per_square);
  out.snapEnabled = w.snap_enabled === true;
  if (
    w.gps &&
    typeof w.gps.lat === 'number' &&
    typeof w.gps.lng === 'number' &&
    Number.isFinite(w.gps.lat) &&
    Number.isFinite(w.gps.lng)
  ) {
    out.gps = {
      lat: w.gps.lat,
      lng: w.gps.lng,
      accuracyMeters:
        typeof w.gps.accuracy_m === 'number' ? w.gps.accuracy_m : undefined,
      // Absent on the wire = unknown — never fabricate "now" as the
      // pin-capture time (review catch; same audit stance as captured_at).
      capturedAt:
        typeof w.gps.captured_at === 'string' ? w.gps.captured_at : undefined,
    };
  }
  if (typeof w.heading_deg === 'number' && Number.isFinite(w.heading_deg)) {
    out.headingDeg = w.heading_deg;
  }
  return out;
}

/**
 * Everything the session loader restores when an existing sketch is
 * opened for editing (#711 part 2) — the parsed doc plus the identity +
 * provenance the superseding save must carry forward.
 */
type LoadedSketch = {
  doc: SketchDoc;
  /** camelCase base `meta.sketch` the next save spreads under its own fields. */
  base: SketchMeta;
  /** Original field-collection time — carried forward on save (audit). */
  capturedAt: string;
  caption?: string;
  assignmentId: string | null;
  workfileId?: string;
  /** Local queue row being superseded, when the capture lives on-device. */
  queueId: string | null;
  /** Server row to best-effort delete after the superseding save. */
  serverId: string | null;
  /** Capture-level geotag, restored as the editor's pinned site. */
  geo?: CaptureMeta['geo'];
};

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

  // #711 part 2: how this editing session was entered. `entry` is a
  // fresh timestamp stamped by EVERY route into this screen (the
  // Capture tile and both Edit affordances), so the session effect
  // below re-keys on each entry even when the edit target repeats.
  const params = useLocalSearchParams<{
    entry?: string;
    editQueueId?: string;
    editServerId?: string;
    assignmentId?: string;
  }>();

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
  // #711: loading overlay while an edit target is fetched/parsed, and
  // whether the document has unsaved edits (gates the Cancel confirm).
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [dirty, setDirty] = useState(false);
  // #711 part 2: one-shot "frame the loaded sketch" request, honored
  // during render once the canvas has a measured size (layout can land
  // before or after the doc loads).
  const [wantFit, setWantFit] = useState(false);
  // #711 part 3: the live snap-feedback ring — the candidate target
  // while a finger is down (no `flash` stamp), or the just-placed
  // vertex for a beat after (`flash` set → the linger effect below
  // clears it).
  const [snapRing, setSnapRing] = useState<
    (SnapResult & { flash?: number }) | null
  >(null);
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
  // #711 (edit-existing) extends the identity set:
  //   - supersedeServerIdRef: server row to best-effort delete after
  //     the NEXT save (editing a synced capture with no local row).
  //   - capturedAtRef: the ORIGINAL field-collection time, stamped on
  //     the first save and carried across every supersede — the backend
  //     treats captured_at as when the sketch was collected in the
  //     field; uploaded_at records edits, so re-stamping now() on a
  //     re-save would falsify the audit trail.
  //   - captionRef / workfileIdRef / baseSketchRef: provenance carried
  //     from the edited capture onto its superseding save.
  //   - assignmentPickedRef: whether the assignment question is already
  //     answered (picked on first save, or inherited from the edit
  //     target) — an edit must never re-run the picker.
  const savedIdRef = useRef<string | null>(null);
  const savedAssignmentIdRef = useRef<string | null>(null);
  const supersedeServerIdRef = useRef<string | null>(null);
  const capturedAtRef = useRef<string | null>(null);
  const captionRef = useRef<string | null>(null);
  const workfileIdRef = useRef<string | null>(null);
  const baseSketchRef = useRef<SketchMeta | null>(null);
  const assignmentPickedRef = useRef(false);

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

  // --- Session reset + loader (#711 part 2) ---
  // Keyed on the ROUTE-entry identity: every push into this screen
  // stamps a fresh `entry` param, so a session starts once per entry
  // (blank or edit) but NOT on a mid-sketch tab flip (params unchanged
  // — work in progress survives). The reset is applied DURING RENDER
  // (React's "adjusting state when a prop changes" pattern), not in an
  // effect: an effect would commit one frame of the PREVIOUS session's
  // sketch before wiping it, and that flash of assignment A's drawing
  // inside assignment B's entry is exactly what part 2c forbids. React
  // re-renders immediately after a render-phase setState, before
  // anything paints.
  // #711 review: PLAIN (scratch) sessions are keyed by the assignment
  // context ONLY — re-entering via the Capture tile RESUMES an unsaved
  // sketch instead of silently wiping it, while a different assignment
  // (or a param-less deep link, which shares only the global scratch)
  // still gets the isolation reset. EDIT sessions keep the entry nonce
  // so each Edit tap reloads fresh from its source capture.
  const isEditEntry = Boolean(params.editQueueId || params.editServerId);
  const sessionKey = isEditEntry
    ? `edit|${params.entry ?? ''}|${params.editQueueId ?? ''}|${params.editServerId ?? ''}|${params.assignmentId ?? ''}`
    : `plain|${params.assignmentId ?? ''}`;
  const [activeSession, setActiveSession] = useState<string | null>(null);
  if (activeSession !== sessionKey) {
    // Blank slate: document, view, calibration, pins — the guarantee
    // that one assignment's sketch can never resurface under another.
    setActiveSession(sessionKey);
    setShapes(freshShapes());
    setLabels([]);
    setHistory([]);
    setLabelDraft(null);
    setDistanceText('');
    setTransform({ tx: 0, ty: 0, scale: 1 });
    setSnapRing(null);
    setDirty(false);
    setSaveNote(null);
    setWantFit(false);
    setPinnedGeo(null);
    setPinnedAt(null);
    setGridSize('medium');
    setScaleFeet(1);
    setSnapEnabled(false);
    setPxPerFoot(pxPerFootFromGrid(GRID_SPACING.medium, 1));
    // For an edit entry the loading veil goes up in this SAME first
    // frame; the loader effect below takes it down.
    setLoadingDoc(isEditEntry);
    setBusy(isEditEntry);
  }

  // The async half of a session start: reset the identity refs, then —
  // for an edit entry — resolve the capture + its vector doc. Runs once
  // per session, post-commit; the render-phase reset above has already
  // blanked everything visible by then.
  useEffect(() => {
    let cancelled = false;

    lastCalibratedSpacingRef.current = GRID_SPACING.medium;
    savedIdRef.current = null;
    savedAssignmentIdRef.current = null;
    supersedeServerIdRef.current = null;
    capturedAtRef.current = null;
    captionRef.current = null;
    workfileIdRef.current = null;
    baseSketchRef.current = null;
    assignmentPickedRef.current = false;

    const editQueueId = params.editQueueId || null;
    const editServerId = params.editServerId || null;
    const routeAssignmentId = params.assignmentId || null;
    if (!editQueueId && !editServerId) return;

    /** Push a resolved capture into the editor as the session's doc. */
    const applyLoaded = (loaded: LoadedSketch) => {
      // Settings first, aligning the visible grid with the doc's
      // calibration: with the grid ON, the grid-derived pxPerFoot is
      // authoritative — rescale the doc to it (real feet invariant, and
      // grid squares line up with drawn walls); with it OFF, the doc's
      // own calibration stands and only the remembered spacing moves.
      const gs = normalizeGridSize(loaded.base.gridSize);
      const sf = normalizeScaleFeet(loaded.base.scaleFeetPerSquare);
      let doc = loaded.doc;
      let ppf = doc.pxPerFoot;
      const spacingPx = GRID_SPACING[gs];
      if (spacingPx > 0) {
        const expected = pxPerFootFromGrid(spacingPx, sf);
        if (expected > 0) {
          doc = rescaleDoc(doc, expected / ppf);
          ppf = expected;
        }
        lastCalibratedSpacingRef.current = spacingPx;
      } else {
        lastCalibratedSpacingRef.current = ppf * sf;
      }
      setGridSize(gs);
      setScaleFeet(sf);
      setSnapEnabled(loaded.base.snapEnabled === true);
      setPxPerFoot(ppf);

      // The document itself. docShapes normalizes a legacy (pre-#686)
      // single-shape doc, so there is always ≥1 shape to be active.
      setShapes(docShapes(doc));
      setLabels(doc.labels);
      setHistory([]);

      // Pinned site + heading: prefer the sketch's own pin, else the
      // capture-level geotag. The live compass overrides the restored
      // heading as soon as it reports.
      if (loaded.base.gps) {
        setPinnedGeo({
          lat: loaded.base.gps.lat,
          lon: loaded.base.gps.lng,
          accuracyMeters: loaded.base.gps.accuracyMeters,
        });
        setPinnedAt(loaded.base.gps.capturedAt ?? null);
      } else if (loaded.geo) {
        setPinnedGeo(loaded.geo);
      }
      if (loaded.base.headingDeg != null) setHeading(loaded.base.headingDeg);

      // Identity: the next save SUPERSEDES this capture — same
      // assignment/workfile linkage, original captured_at, no re-pick.
      savedIdRef.current = loaded.queueId;
      supersedeServerIdRef.current = loaded.serverId;
      savedAssignmentIdRef.current = loaded.assignmentId;
      assignmentPickedRef.current = true;
      capturedAtRef.current = loaded.capturedAt;
      captionRef.current = loaded.caption ?? null;
      workfileIdRef.current = loaded.workfileId ?? null;
      baseSketchRef.current = loaded.base;

      // Frame the whole loaded drawing once the canvas has a size.
      setWantFit(true);
    };

    // Resolve the capture + its vector doc. The render-phase reset
    // already raised `busy`, which gates every mutation path — the load
    // window can't race a stray tap.
    (async (): Promise<LoadedSketch> => {
      const queue = await loadQueue();
      // A local queue row is the freshest source — and keeps editing a
      // just-saved (still unsynced) sketch fully offline-capable. An
      // edit of a SYNCED capture also prefers its local mirror when one
      // is still retained (serverId is stamped at upload time).
      const localRow = editQueueId
        ? queue.find((it) => it.id === editQueueId)
        : queue.find((it) => it.serverId === editServerId);
      if (localRow) {
        const doc = parseSketchVector(localRow.sketch?.vector);
        if (!doc) throw new Error('This sketch has no editable drawing data.');
        return {
          doc,
          // Spread so unknown keys on the stored meta survive the
          // supersede — this row is already camelCase SketchMeta.
          base: { ...localRow.sketch },
          capturedAt: localRow.capturedAt,
          caption: localRow.caption,
          assignmentId: localRow.assignmentId ?? routeAssignmentId,
          workfileId: localRow.workfileId,
          queueId: localRow.id,
          // The row's serverId (if it synced) is read again at save
          // time — the supersede path deletes the server copy then.
          serverId: null,
          geo: localRow.geo,
        };
      }
      if (editQueueId) {
        throw new Error('This sketch is no longer on this device.');
      }
      if (!routeAssignmentId) {
        throw new Error('Missing the assignment for this sketch.');
      }
      const rows = await listAssignmentCaptures(routeAssignmentId);
      const row = rows.find((r) => r.id === editServerId);
      if (!row) throw new Error('This sketch is no longer on the server.');
      const doc = parseSketchVector(row.sketch?.vector);
      if (!doc) throw new Error('This sketch has no editable drawing data.');
      const geo =
        row.geo &&
        typeof row.geo.lat === 'number' &&
        typeof row.geo.lon === 'number'
          ? {
              lat: row.geo.lat,
              lon: row.geo.lon,
              accuracyMeters: row.geo.accuracyMeters,
            }
          : undefined;
      return {
        doc,
        base: sketchMetaFromWire(row.sketch),
        capturedAt: row.captured_at,
        caption: row.caption,
        assignmentId: row.case_id ?? routeAssignmentId,
        workfileId: row.workfile_id,
        queueId: null,
        serverId: row.id,
        geo,
      };
    })()
      .then((loaded) => {
        if (!cancelled) applyLoaded(loaded);
      })
      .catch((e) => {
        if (cancelled) return;
        Alert.alert("Couldn't open sketch", (e as Error).message, [
          { text: 'OK', onPress: () => router.back() },
        ]);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDoc(false);
          setBusy(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the entry identity alone — params/router are read from
    // the closure the entry that created them rendered with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

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

  // #711 part 4: the DYNAMIC zoom-out floor — half the fit-all-content
  // scale when that dips under the static minimum, recomputed as the
  // sketch grows. Consumed by the pinch clamp so a big drawing's fit
  // view (which recenter can reach) is also reachable — and holdable —
  // by pinching, instead of snapping back to a fixed floor.
  const minScale = useMemo(
    () =>
      dynamicMinScale(
        fitTransformForCapture(allVertices, labels, size.w, size.h)?.scale ??
          null,
        MIN_SCALE,
      ),
    [allVertices, labels, size.w, size.h],
  );

  // #711 review: shrinking the sketch (Undo/Clear of a far shape) can
  // RAISE the dynamic zoom floor above the current zoom; re-clamp now,
  // about the canvas center, so the first pinch doesn't visibly jump.
  useEffect(() => {
    setTransform((t) => {
      if (t.scale >= minScale) return t;
      const f = minScale / t.scale;
      const cx = size.w / 2;
      const cy = size.h / 2;
      return {
        scale: minScale,
        tx: cx - (cx - t.tx) * f,
        ty: cy - (cy - t.ty) * f,
      };
    });
  }, [minScale, size.w, size.h]);


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
        // catch; same invariant as the geometry above). The 'm' move
        // deltas (#711) are world-space too.
        setHistory((h) =>
          h.map((a) => {
            if (a.t === 'c' && a.dropped) {
              return {
                ...a,
                dropped: {
                  x: a.dropped.x * factor,
                  y: a.dropped.y * factor,
                },
              };
            }
            if (a.t === 'm') {
              return { ...a, dx: a.dx * factor, dy: a.dy * factor };
            }
            return a;
          }),
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
    snapActive ? snapToGrid(p, spacing) : p;

  // #711 part 3: where a draw-mode point actually lands — existing
  // vertex, then wall, then grid (see resolveSnapPoint). Tolerances are
  // screen dp ÷ zoom so the fingertip radius is constant on screen. The
  // active open shape's LAST vertex (the anchor the next wall extends
  // from) is excluded, or a tap near it would snap back and mint a
  // zero-length wall.
  const resolveDrawPoint = (world: SketchVertex): SnapResult => {
    const anchor =
      !activeShape.closed && activeShape.vertices.length > 0
        ? activeShape.vertices[activeShape.vertices.length - 1]
        : undefined;
    return resolveSnapPoint(world, shapes, {
      vertexTolerance: SNAP_VERTEX_DP / transform.scale,
      segmentTolerance: SNAP_SEGMENT_DP / transform.scale,
      gridSpacing: snapActive ? spacing : 0,
      exclude: anchor ? [anchor] : undefined,
    });
  };

  // Ring feedback for a resolved placement: vertex/wall snaps are the
  // meaningful signal (a ring on every grid tick would be noise). The
  // `flash` stamp marks it as a placement ring for the linger effect.
  const flashSnapRing = (r: SnapResult) => {
    if (r.kind === 'vertex' || r.kind === 'segment') {
      setSnapRing({ ...r, flash: Date.now() });
    } else {
      setSnapRing(null);
    }
  };

  // A flashed (just-placed) ring clears itself after a beat; a preview
  // ring (finger still down, no `flash`) is cleared by the gesture's
  // finalize instead. Effect cleanup retires the timer on re-flash and
  // on unmount.
  useEffect(() => {
    if (snapRing?.flash == null) return;
    const timer = setTimeout(() => setSnapRing(null), SNAP_RING_MS);
    return () => clearTimeout(timer);
  }, [snapRing]);

  // --- Mutations (all target the ACTIVE = last shape) ---
  const addVertexWorld = useCallback((p: SketchVertex) => {
    setShapes((ss) =>
      ss.map((s, i) =>
        i === ss.length - 1 ? { ...s, vertices: [...s.vertices, p] } : s,
      ),
    );
    setHistory((h) => [...h, { t: 'v' }]);
    setDirty(true);
    void Haptics.selectionAsync();
  }, []);

  /** Start a brand-new shape whose first vertex is `p` (#686). */
  const startShapeWorld = useCallback((p: SketchVertex) => {
    setShapes((ss) => [...ss, { vertices: [p], closed: false }]);
    setHistory((h) => [...h, { t: 'ns' }]);
    setDirty(true);
    void Haptics.selectionAsync();
  }, []);

  const addLabel = useCallback((l: SketchLabel) => {
    setLabels((ls) => [...ls, l]);
    setHistory((h) => [...h, { t: 'l' }]);
    setDirty(true);
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
    // Growth of 1–2 is a user placement (tap, arrow, the two-point seed,
    // an undo-close restore). A bigger jump is a whole LOADED document
    // (#711) — that one gets framed by the fit below, not panned.
    const added = allVertices.length - prev;
    if (added >= 1 && added <= 2 && allVertices.length > 0) {
      ensureVisibleWorldPoint(allVertices[allVertices.length - 1]);
    }
  }, [allVertices, ensureVisibleWorldPoint]);

  // #711 part 2: one-shot framing of a freshly LOADED sketch, honored
  // once both the doc and a measured canvas exist (layout can land in
  // either order). Applied DURING RENDER like the session reset, so the
  // loaded drawing's first painted frame is already fitted — never a
  // flash of it sitting at the identity transform.
  if (wantFit && size.w > 0 && size.h > 0 && hasContent) {
    setWantFit(false);
    const fit = fitTransformForCapture(allVertices, labels, size.w, size.h);
    if (fit) setTransform(fit);
  }

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
      // Draw mode: resolve the landing point through the snap ladder
      // (#711 part 3 — vertex, wall, grid) and flash the ring feedback
      // on a vertex/wall hit. A closed active shape means the pen is UP
      // — the next tap relocates it by starting a NEW outline right
      // there (#686), instead of the old dead-end where taps were
      // ignored until Undo. Starting ON existing geometry is exactly
      // when the vertex/wall snap earns its keep.
      const resolved = resolveDrawPoint(world);
      flashSnapRing(resolved);
      if (activeShape.closed) {
        startShapeWorld(resolved.point);
        return;
      }
      addVertexWorld(resolved.point);
    },
    // screenToWorld / resolveDrawPoint read transform/shapes/snap from
    // the current render closure; listing the primitives keeps them
    // fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, mode, activeShape, shapes, transform, snapActive, spacing, promptForLabel, addVertexWorld, startShapeWorld],
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
      } else if (activeShape.vertices.length === 1) {
        // #711 part 3: with exactly ONE vertex down, the pad MOVES that
        // start point by the entered distance instead of drawing a wall
        // (the pad card says so) — fine placement of a shape's start
        // without fingertip precision. Recorded as a DELTA ('m'), not a
        // from-position: rapid arrow taps outrun React commits, and a
        // closure-read "previous position" would go stale; undoing a
        // delta is order-safe. Read the vertex INSIDE the updater for
        // the same reason.
        const shapeIndex = activeIndex;
        setShapes((ss) =>
          ss.map((s, i) =>
            i === shapeIndex && s.vertices.length > 0
              ? {
                  ...s,
                  vertices: [
                    {
                      x: s.vertices[0].x + dx,
                      y: s.vertices[0].y + dy,
                    },
                    ...s.vertices.slice(1),
                  ],
                }
              : s,
          ),
        );
        setHistory((h) => [...h, { t: 'm', shape: shapeIndex, dx, dy }]);
        // The count-gated auto-pan ignores moves — keep the moved start
        // on screen ourselves, and mark it with the placement ring.
        const moved = {
          x: activeShape.vertices[0].x + dx,
          y: activeShape.vertices[0].y + dy,
        };
        ensureVisibleWorldPoint(moved);
        flashSnapRing({ point: moved, kind: 'vertex' });
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
      setDirty(true);
      void Haptics.selectionAsync();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, activeShape, activeIndex, distanceText, pxPerFoot, size, transform, snapActive, spacing, ensureVisibleWorldPoint],
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
    setDirty(true);
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
    } else if (top.t === 'm') {
      // Undo a pad-move of a start vertex (#711): subtract the recorded
      // delta from vertex 0 of THAT shape. By the time 'm' surfaces,
      // reverse unwinding has already popped anything added after it,
      // so the shape is back to the single-vertex state it was moved in.
      setShapes((ss) =>
        ss.map((s, i) =>
          i === top.shape && s.vertices.length > 0
            ? {
                ...s,
                vertices: [
                  {
                    x: s.vertices[0].x - top.dx,
                    y: s.vertices[0].y - top.dy,
                  },
                  ...s.vertices.slice(1),
                ],
              }
            : s,
        ),
      );
    } else if (top.t === 'l') {
      setLabels((l) => l.slice(0, -1));
    }
    setHistory((h) => h.slice(0, -1));
    setDirty(true);
    void Haptics.selectionAsync();
  }, [busy, history]);

  const onClear = useCallback(() => {
    if (busy) return;
    const doClear = () => {
      setShapes(freshShapes());
      setLabels([]);
      setHistory([]);
      setLabelDraft(null);
      setSnapRing(null);
      // Clear starts a NEW document: reset the save identity so the next
      // save mints a fresh capture id and re-runs the assignment picker,
      // instead of superseding the sketch that was just saved — or, in
      // an edit session (#711), the capture being edited: the original
      // stays exactly as it was.
      savedIdRef.current = null;
      savedAssignmentIdRef.current = null;
      supersedeServerIdRef.current = null;
      capturedAtRef.current = null;
      captionRef.current = null;
      workfileIdRef.current = null;
      baseSketchRef.current = null;
      assignmentPickedRef.current = false;
      // A blank canvas has nothing left to lose — back out freely.
      setDirty(false);
      void Haptics.selectionAsync();
    };
    Alert.alert(
      'Clear sketch?',
      savedIdRef.current || supersedeServerIdRef.current
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

  /**
   * Back out of the editor (#711 part 2c): with unsaved strokes on the
   * canvas, confirm before discarding — the session loader starts every
   * ENTRY clean, so whatever isn't saved now is gone for good.
   */
  const onCancel = useCallback(() => {
    if (dirty && hasContent) {
      Alert.alert(
        'Discard unsaved changes?',
        'This sketch has strokes that haven’t been saved.',
        [
          { text: 'Keep editing', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => router.back(),
          },
        ],
      );
      return;
    }
    router.back();
  }, [dirty, hasContent, router]);

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
    .onBegin((e) => {
      // #711 part 3: live snap preview — ring the candidate target the
      // moment the finger lands, so the appraiser sees where the point
      // will snap BEFORE committing the tap.
      if (mode === 'draw' && !busy) {
        const r = resolveDrawPoint(screenToWorld(e.x, e.y));
        if (r.kind === 'vertex' || r.kind === 'segment') setSnapRing(r);
      }
    })
    .onEnd((e, success) => {
      if (success) onCanvasTap(e.x, e.y);
    })
    .onFinalize((_e, success) => {
      // A failed tap (drag past slop, second finger) drops its preview;
      // a successful one just re-flashed the ring with a linger timer.
      if (!success) setSnapRing(null);
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
        // #711 part 4: the floor is the DYNAMIC minimum — a big sketch
        // pinches out to (at least half of) its fit-all view instead of
        // fighting a fixed clamp the recentered view already sits below.
        const newScale = clampScale(t.scale * e.scaleChange, minScale);
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
    // The snap ring renders INSIDE the ref'd canvas (it marks a world
    // point, so it must) — drop it before rasterizing or a lingering
    // flash gets baked into the PNG (#711).
    setSnapRing(null);
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

      // Pick the assignment on the FIRST save of a NEW sketch only; a
      // re-save reuses it, and an edit session (#711) inherits its
      // capture's assignment — editing must never re-ask.
      if (!assignmentPickedRef.current) {
        try {
          savedAssignmentIdRef.current = await pickAssignment();
        } catch {
          savedAssignmentIdRef.current = null;
        }
        assignmentPickedRef.current = true;
      }
      const assignmentId = savedAssignmentIdRef.current;

      const sketchMeta: SketchMeta = {
        // #711: an edit session spreads the edited capture's original
        // meta.sketch underneath, so provenance this session didn't
        // touch (and, for local rows, keys this build doesn't know)
        // survives the supersede; the editor-owned fields below
        // overwrite their slots. Null (a fresh sketch) spreads nothing.
        ...(baseSketchRef.current ?? {}),
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

      // #711: the ORIGINAL field-collection time rides every supersede
      // — the backend treats captured_at as when the sketch was
      // collected in the field, and uploaded_at already records the
      // edit; re-stamping now() would falsify the audit trail. Only the
      // very first save of a NEW sketch stamps the clock.
      const capturedAt = capturedAtRef.current ?? new Date().toISOString();

      const buildMeta = (id: string): CaptureMeta => {
        const meta: CaptureMeta = {
          id,
          kind: 'sketch',
          localUri: uri,
          capturedAt,
          caption: captionRef.current ?? 'Field sketch',
          status: 'pending',
          sketch: sketchMeta,
        };
        if (assignmentId) meta.assignmentId = assignmentId;
        if (workfileIdRef.current) meta.workfileId = workfileIdRef.current;
        if (pinnedGeo) meta.geo = pinnedGeo;
        return meta;
      };

      if (savedIdRef.current == null && supersedeServerIdRef.current == null) {
        const id = newCaptureId();
        await enqueue(buildMeta(id));
        savedIdRef.current = id;
      } else {
        // Subsequent save — or the save of an EDIT (#711) → MINT A
        // FRESH ID and supersede the old revision. Never update-in-place
        // and re-POST: the backend is idempotent on
        // (tenant_id, client_id) — re-posting the same client id
        // returns the OLD capture with 200 and silently DISCARDS the new
        // bytes, while the client happily marks them 'synced'.
        const oldId = savedIdRef.current;
        const queueBefore = await loadQueue();
        const oldRow = oldId
          ? queueBefore.find((it) => it.id === oldId)
          : undefined;
        const id = newCaptureId();
        await enqueue(buildMeta(id));
        savedIdRef.current = id;
        // Best-effort from here down: the NEW revision is safely enqueued,
        // so a cleanup failure must never surface as "Save failed" (it
        // would re-save and mint duplicate revisions — review catch).
        if (oldId) {
          try {
            await removeItem(oldId);
          } catch {
            // stale local row lingers; the next sync sweep can handle it
          }
        }
        // Best-effort: delete the superseded revision's server copy —
        // learned from the queue row when it synced from this device,
        // or carried in by the Edit entry for an already-synced capture
        // (#711). Swallow every failure — offline is fine; an older
        // revision lingering server-side beats losing the new one.
        // (Rows that synced before serverId existed, or whose upload is
        // mid-flight right now, just skip this.)
        const staleServerId = oldRow?.serverId ?? supersedeServerIdRef.current;
        if (staleServerId) {
          void deleteCapture(staleServerId).catch(() => {});
          // A retained local mirror of that server row (synced earlier)
          // is stale too — drop it so the hub's counts don't keep a
          // deleted capture alive.
          const mirror = queueBefore.find(
            (it) => it.id !== oldId && it.serverId === staleServerId,
          );
          if (mirror) {
            try {
              await removeItem(mirror.id);
            } catch {
              // stale mirror lingers; harmless
            }
          }
        }
        // The supersede chain continues through the LOCAL row from here.
        supersedeServerIdRef.current = null;
      }
      capturedAtRef.current = capturedAt;
      setDirty(false);

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
            onPress={onCancel}
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

                  {/* #711 part 3: snap feedback — a gold ring on the
                      live candidate while the finger is down, then on
                      the just-placed vertex for a beat. Vertex hits get
                      the bigger ring (they out-rank wall hits). */}
                  {snapRing ? (
                    <Circle
                      cx={snapRing.point.x}
                      cy={snapRing.point.y}
                      r={(snapRing.kind === 'vertex' ? 11 : 9) * invScale}
                      fill="none"
                      stroke={Brand.gold}
                      strokeWidth={2.5 * invScale}
                    />
                  ) : null}

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

          {/* #711 part 2: full-canvas veil while an edit target loads.
              Also a canvas sibling; `busy` already gates every mutation
              underneath, this just says why nothing responds. */}
          {loadingDoc ? (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator color={Brand.navyDeep} />
              <Text style={styles.loadingLabel}>Opening sketch…</Text>
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
                {/* #711 part 3: with exactly one vertex down the pad
                    repositions the START POINT instead of drawing —
                    say so, or the "missing" wall reads as a bug. */}
                {activeShape.vertices.length === 1 &&
                !activeShape.closed ? (
                  <Text style={styles.padMoveNote}>
                    One point placed — arrows move it into position
                  </Text>
                ) : null}
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
  // #711 part 3: the "arrows move the start point" mode note.
  padMoveNote: {
    fontSize: 11,
    fontWeight: '600',
    color: Brand.amber,
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
  // #711 part 2: veil shown while an edit target loads.
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.85)',
  },
  loadingLabel: { fontSize: 13, fontWeight: '600', color: Brand.inkMuted },
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
