/**
 * Assignment detail. Shows the assignment metadata + the captures
 * already filed to it (photos, voice notes), each tappable into the
 * capture detail screen (which carries the transcript for voice notes).
 *
 * Captures are sourced from the dedicated per-case endpoint via
 * {@link listAssignmentCaptures} (`GET /v1/cases/{id}/captures`). The
 * tenant inbox (`listCaptureInbox`) only lists *unfiled* captures, so
 * filtering it client-side would never surface a filed capture.
 *
 * Because there's no single-capture GET, a filed capture isn't in the
 * inbox the detail screen reads from. We pass the assignment id along
 * as `caseId` so the capture detail can fall back to this assignment's
 * captures and still resolve the row.
 *
 * SKETCH EDITING (#711): a filed sketch that carries an editable vector
 * doc gets an Edit affordance that opens the sketch editor loaded with
 * THAT capture (`editServerId` + `assignmentId` route params — the
 * editor re-fetches this assignment's captures and parses the doc
 * defensively). Sketches saved to this assignment that are still
 * WAITING TO SYNC live only in the local queue — the server list can't
 * show them — so they get their own "On this device" section above the
 * synced captures, with the same Edit affordance (`editQueueId`).
 * Reloads on every focus, so returning from the editor after a
 * supersede-save never shows the stale revision.
 *
 * Native workfile creation + attachment upload still happen in the web
 * app; this screen is read-only for the assignment itself. Captures are
 * filed from the Inbox tab.
 */

import { Ionicons } from '@react-native-vector-icons/ionicons/static';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CaptureRow } from '@/components/CaptureRow';
import { Brand, Radius, Spacing } from '@/constants/theme';
import {
  assignmentLabel,
  getAssignment,
  getCaptureDownloadUrl,
  listAssignmentCaptures,
  type AssignmentSummary,
  type CaptureSummary,
} from '@/lib/api';
import type { CaptureMeta } from '@/lib/capture';
import { loadQueue } from '@/lib/queue';
import { parseSketchVector } from '@/lib/sketch-model';

type ThumbState = Record<string, string | null>; // capture.id → presigned url (null while loading)

export default function AssignmentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [assignment, setAssignment] = useState<AssignmentSummary | null>(null);
  const [captures, setCaptures] = useState<CaptureSummary[]>([]);
  // #711: this assignment's sketches still waiting in the local queue —
  // the server list can't show them, but they must be editable.
  const [localSketches, setLocalSketches] = useState<CaptureMeta[]>([]);
  const [thumbs, setThumbs] = useState<ThumbState>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capturesError, setCapturesError] = useState<string | null>(null);

  // The thumb cache is read through a ref inside `load` so `load`'s
  // identity doesn't churn as thumbs stream in — with load wired to
  // useFocusEffect (#711), an unstable identity would re-run the whole
  // fetch once per resolved thumbnail.
  const thumbsRef = useRef<ThumbState>({});

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    setCapturesError(null);
    // Local queue first — it works offline, so a dead zone still shows
    // (and lets the appraiser re-open) the sketches waiting to sync.
    try {
      const queue = await loadQueue();
      setLocalSketches(
        queue.filter(
          (it) =>
            it.kind === 'sketch' &&
            it.assignmentId === id &&
            it.status !== 'synced',
        ),
      );
    } catch {
      // Queue unreadable — the server list below still renders.
    }
    try {
      // The assignment header is the must-have; load it first so a
      // captures failure can't blank the whole screen.
      const got = await getAssignment(id);
      setAssignment(got);
      try {
        const filed = await listAssignmentCaptures(id);
        setCaptures(filed);
        // Kick off thumbnail fetches for photos; other kinds use an icon.
        // Skip any thumb we already hold so pull-to-refresh doesn't
        // re-request every presigned URL (mirrors the Inbox guard).
        for (const item of filed) {
          if (item.kind === 'photo' && !thumbsRef.current[item.id]) {
            getCaptureDownloadUrl(item.id)
              .then((d) => {
                thumbsRef.current = { ...thumbsRef.current, [item.id]: d.url };
                setThumbs(thumbsRef.current);
              })
              .catch(() => {
                thumbsRef.current = { ...thumbsRef.current, [item.id]: null };
                setThumbs(thumbsRef.current);
              });
          }
        }
      } catch (e) {
        setCapturesError((e as Error).message);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  // Reload on every focus (#711): returning from the sketch editor
  // after a supersede-save must drop the stale revision from the list.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  // #711: which SERVER captures can open in the sketch editor — sketch
  // kind with a parseable vector doc (parsed defensively; an old
  // raster-only sketch or junk meta simply gets no Edit button).
  const editableSketchIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of captures) {
      if (c.kind === 'sketch' && parseSketchVector(c.sketch?.vector)) {
        ids.add(c.id);
      }
    }
    return ids;
  }, [captures]);

  /** Route into the sketch editor for one capture (#711). */
  const openSketchEditor = useCallback(
    (target: { editServerId?: string; editQueueId?: string }) => {
      if (!id) return;
      router.push({
        pathname: '/sketch-capture',
        params: {
          ...target,
          assignmentId: id,
          // A fresh entry stamp per route — the editor's session
          // isolation (#711 part 2c) re-keys on it.
          entry: String(Date.now()),
        },
      });
    },
    [id, router],
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.center}>
          <ActivityIndicator color={Brand.gold} />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !assignment) {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Couldn&apos;t load assignment</Text>
          <Text style={styles.errorBody}>{error ?? 'Not found.'}</Text>
          <Pressable
            style={[styles.retry, styles.retryRow]}
            onPress={() => router.back()}
          >
            <Ionicons name="arrow-back" size={15} color={Brand.cream} />
            <Text style={styles.retryLabel}>Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const header = (
    <View style={styles.header}>
      <Text style={styles.eyebrow}>ASSIGNMENT</Text>
      <Text style={styles.title}>{assignmentLabel(assignment)}</Text>
      <View style={styles.metaBlock}>
        <MetaRow label="Jurisdiction" value={assignment.jurisdiction ?? '—'} />
        <MetaRow label="State" value={assignment.state} />
        <MetaRow label="Domain" value={assignment.domain} />
        <MetaRow label="Created" value={fmt(assignment.created_at)} />
      </View>

      {/* #711: sketches saved to this assignment that are still in the
          local queue. The server list below can't know about them, and
          this is the only per-assignment surface they can be re-opened
          from before they sync. */}
      {localSketches.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>On this device</Text>
          <View style={styles.localBlock}>
            {localSketches.map((it) => {
              // No Edit while the row is mid-upload: superseding it in
              // that window orphans the in-flight server revision
              // (review catch) — the pill returns when the upload lands.
              const editable =
                it.status !== 'uploading' &&
                parseSketchVector(it.sketch?.vector) != null;
              return (
                <View key={it.id} style={styles.row}>
                  <View style={styles.localIcon}>
                    <Ionicons
                      name="analytics-outline"
                      size={24}
                      color={Brand.navyDeep}
                    />
                  </View>
                  <View style={styles.localBody}>
                    <Text style={styles.localTitle}>
                      {it.caption ?? 'Field sketch'}
                    </Text>
                    <Text style={styles.localMeta}>
                      {it.status === 'failed'
                        ? 'Upload failed — will retry'
                        : 'Waiting to sync'}
                    </Text>
                  </View>
                  {editable ? (
                    <SketchEditButton
                      onPress={() => openSketchEditor({ editQueueId: it.id })}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
        </>
      ) : null}

      <Text style={styles.sectionTitle}>Captures</Text>

      {capturesError ? (
        <View style={styles.statusCard}>
          <Text style={styles.statusError}>{capturesError}</Text>
          <Text style={styles.statusHint}>Pull down to try again.</Text>
        </View>
      ) : captures.length === 0 ? (
        <View style={styles.statusCard}>
          <Text style={styles.emptyBody}>
            No captures filed to this assignment yet — capture photos
            or voice notes and file them here from the Inbox.
          </Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView style={styles.flex}>
      <FlatList
        contentContainerStyle={styles.scroll}
        data={captures}
        keyExtractor={(it) => it.id}
        ListHeaderComponent={header}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Brand.gold}
          />
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <CaptureRow
              item={item}
              thumbUrl={thumbs[item.id]}
              onPress={() =>
                router.push({
                  pathname: '/captures/[id]',
                  params: { id: item.id, caseId: assignment.id },
                })
              }
            />
            {/* #711: filed sketches with an editable vector doc open
                back up in the sketch editor. */}
            {editableSketchIds.has(item.id) ? (
              <SketchEditButton
                onPress={() => openSketchEditor({ editServerId: item.id })}
              />
            ) : null}
          </View>
        )}
      />
    </SafeAreaView>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

/** The #711 Edit affordance — one pencil pill, shared by both sections. */
function SketchEditButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel="Edit this sketch"
      style={({ pressed }) => [styles.editBtn, pressed && styles.editBtnPressed]}
      onPress={onPress}
    >
      <Ionicons name="pencil" size={14} color={Brand.navyDeep} />
      <Text style={styles.editBtnLabel}>Edit</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Brand.cream },
  scroll: { padding: Spacing.four, gap: Spacing.three },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.five,
  },
  header: { gap: Spacing.three },
  eyebrow: {
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: '700',
    color: Brand.gold,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: Brand.navyDeep,
    marginTop: Spacing.two,
  },
  metaBlock: {
    backgroundColor: Brand.surface,
    padding: Spacing.four,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
    gap: Spacing.two,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaLabel: { color: Brand.inkMuted, fontSize: 13 },
  metaValue: { color: Brand.ink, fontSize: 13, fontFamily: 'monospace' },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: Brand.gold,
  },
  statusCard: {
    backgroundColor: Brand.surface,
    padding: Spacing.four,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  emptyBody: { fontSize: 14, lineHeight: 22, color: Brand.inkMuted },
  statusError: { fontSize: 14, lineHeight: 22, color: Brand.red },
  statusHint: {
    fontSize: 12,
    color: Brand.inkFaint,
    marginTop: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    backgroundColor: Brand.surface,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
    padding: Spacing.three,
    gap: Spacing.three,
    alignItems: 'center',
  },
  // #711: the "On this device" (unsynced sketches) section + the Edit
  // affordance shared with the synced rows.
  localBlock: { gap: Spacing.three },
  localIcon: {
    width: 56,
    height: 56,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Brand.cream,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  localBody: { flex: 1 },
  localTitle: { fontSize: 15, fontWeight: '600', color: Brand.navyDeep },
  localMeta: { fontSize: 12, color: Brand.inkMuted, marginTop: 2 },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.pill,
    backgroundColor: Brand.cream,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  editBtnPressed: { opacity: 0.7 },
  editBtnLabel: { fontSize: 13, fontWeight: '600', color: Brand.navyDeep },
  errorTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: Brand.red,
    marginBottom: Spacing.two,
    textAlign: 'center',
  },
  errorBody: {
    fontSize: 13,
    color: Brand.inkMuted,
    textAlign: 'center',
    marginBottom: Spacing.four,
  },
  retry: {
    backgroundColor: Brand.navyDeep,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    borderRadius: Radius.sm,
  },
  retryRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  retryLabel: { color: Brand.cream, fontWeight: '600' },
});
