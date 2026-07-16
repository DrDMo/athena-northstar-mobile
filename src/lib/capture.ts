/**
 * Capture queue — on-device store of photos/notes/etc. that have been
 * captured in the field but not yet uploaded to a workfile.
 *
 * Field appraisers are routinely in dead zones — basements, rural
 * sites, anywhere with no LTE. Photos can be taken offline and
 * uploaded later in one batch when signal returns. The queue is
 * the buffer between camera-fired and synced-to-workfile.
 *
 * v0.1 is the data model only — the persistence layer (AsyncStorage
 * or SQLite) and the sync-on-signal worker land in m4. For now,
 * captures live in component state and disappear on app cold-start.
 * That's fine for the demo + early field tests; full offline
 * survives the next milestone.
 */

import { File, Paths } from 'expo-file-system';
import * as Location from 'expo-location';

import type { SketchDoc } from './sketch-model';

export type CaptureKind = 'photo' | 'voice_note' | 'text_note' | 'sketch';

/** Graph-paper grid density on the sketch surface. */
export type SketchGridSize = 'off' | 'fine' | 'medium' | 'coarse';

/**
 * Sketch-only capture settings + geo-reference (#655). Present on
 * `kind: 'sketch'` captures; every field is optional so older sketches,
 * and every non-sketch kind, stay valid and the sync wire only ever
 * GAINS keys (see {@link CaptureMeta.sketch}).
 */
export type SketchMeta = {
  /** Graph-paper grid density chosen on the drawing surface. */
  gridSize?: SketchGridSize;
  /** Real-world feet represented by one grid square (the drawing scale). */
  scaleFeetPerSquare?: number;
  /** Whether stroke points were snapped to grid intersections. */
  snapEnabled?: boolean;
  /** One-shot GPS fix the appraiser pinned for the site the sketch depicts. */
  gps?: {
    lat: number;
    lng: number;
    accuracyMeters?: number;
    /** ISO timestamp the pin was captured. */
    capturedAt: string;
  };
  /** Compass heading (degrees, 0 = north) of the north arrow at save time. */
  headingDeg?: number;
  /**
   * The editable vector floor-plan document (#666). Present on sketches
   * saved by the vector editor; carries the exact vertices, labels,
   * closed-state, and `pxPerFoot` so the sketch is re-editable and its
   * dimensions/area are recomputable from data alone (not the PNG).
   * Additive + optional: older sketches (raster-only) and every
   * non-sketch capture omit it, so the persisted queue + sync wire only
   * ever GAIN this key.
   */
  vector?: SketchDoc;
};

export type CaptureMeta = {
  /** Stable client-generated id; sortable by capture time. */
  id: string;

  kind: CaptureKind;

  /** Local file:// URI on the device, written by the capture library. */
  localUri: string;

  /** Bytes on disk, for upload size estimation. */
  sizeBytes?: number;

  /** ISO timestamp the capture was created. */
  capturedAt: string;

  /** Geotag, if location permission was granted at capture time. */
  geo?: {
    lat: number;
    lon: number;
    accuracyMeters?: number;
    altitude?: number;
  };

  /** EXIF passthrough — kept opaque; the server reads what it needs. */
  exif?: Record<string, unknown>;

  /** Free-form caption the appraiser added before queueing. */
  caption?: string;

  /** Which workfile this capture is destined for, if known yet. */
  assignmentId?: string;
  workfileId?: string;

  /**
   * Sketch-only settings + geo-reference (#655). Only set on
   * `kind: 'sketch'`; additive + optional, so captures written before
   * this field existed still load and sync unchanged.
   */
  sketch?: SketchMeta;

  /** Upload state. Sync layer flips through these. */
  status: 'pending' | 'uploading' | 'synced' | 'failed';

  lastError?: string;
};

/**
 * Generate a sortable, collision-resistant id without pulling in a
 * UUID dependency. Format: `cap_<base36 epoch ms>_<6 random chars>`.
 * Sortable lexicographically by time — handy for FlatList ordering.
 */
export function newCaptureId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `cap_${ts}_${rand}`;
}

/**
 * Write a text-note body to a temp `.txt` in the cache directory and
 * return its `file://` URI — the local file the sync layer uploads as
 * the multipart `file` part.
 *
 * Why a real file rather than meta-only: the backend captures handler
 * (`POST /v1/captures`) REQUIRES a non-empty `file` field — it rejects
 * an empty upload with `400 "uploaded file is empty"` and there is no
 * meta-only path. So a `text_note` has to carry its text as the file
 * body. The caption (a short label) still travels in `meta.caption`;
 * the full note text lives in the `.txt`. Content-type is
 * `text/plain; charset=utf-8`, matching the server's default for the
 * `text_note` kind.
 *
 * Uses the SDK 56 synchronous filesystem API (`File`/`Paths`). The
 * cache directory is correct here: once a capture syncs, its local file
 * is disposable, and the system may reclaim cache under storage
 * pressure (the queue tolerates a missing local file by failing that
 * one upload, not the app).
 */
export function writeTextNoteFile(captureId: string, body: string): string {
  const file = new File(Paths.cache, `${captureId}.txt`);
  // create() throws if the file already exists; ids are unique per
  // capture, but guard anyway so a retry doesn't crash the save.
  if (!file.exists) file.create();
  file.write(body);
  return file.uri;
}

/**
 * One-shot geotag for a field capture. Requests foreground location
 * permission and, if granted, returns a single GPS fix shaped as a
 * {@link CaptureMeta} `geo`. Returns `undefined` when permission is
 * denied (the capture still saves — a geotag is best-effort).
 *
 * Shared by every capture screen (photo, voice, text note, MLS scan,
 * address) so they stay consistent: ONE accuracy
 * (`Location.Accuracy.High` — a good field balance on both platforms),
 * and ONE denied-hint path. The old per-screen copies drifted on both
 * (some used `Balanced`, the new screens silently dropped the "No
 * location" hint); this is the single source of truth.
 *
 * `onDenied` fires only when permission is permanently blocked
 * (`canAskAgain === false`) — matching the photo/voice screens, which
 * surface a "No location — won't be geotagged" hint in that case rather
 * than nagging on a one-time "deny" the user can still reverse.
 */
export async function getCurrentGeo(opts?: {
  onDenied?: () => void;
}): Promise<CaptureMeta['geo']> {
  const { status, canAskAgain } =
    await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') {
    if (!canAskAgain) opts?.onDenied?.();
    return undefined;
  }
  const pos = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
  });
  return {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    accuracyMeters: pos.coords.accuracy ?? undefined,
    altitude: pos.coords.altitude ?? undefined,
  };
}
