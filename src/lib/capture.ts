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

export type CaptureKind = 'photo' | 'voice_note' | 'text_note' | 'sketch';

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
