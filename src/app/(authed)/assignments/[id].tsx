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
 * Native workfile creation + attachment upload still happen in the web
 * app; this screen is read-only for the assignment itself. Captures are
 * filed from the Inbox tab.
 */

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
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
  getAssignment,
  getCaptureDownloadUrl,
  listAssignmentCaptures,
  type AssignmentSummary,
  type CaptureSummary,
} from '@/lib/api';

type ThumbState = Record<string, string | null>; // capture.id → presigned url (null while loading)

export default function AssignmentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [assignment, setAssignment] = useState<AssignmentSummary | null>(null);
  const [captures, setCaptures] = useState<CaptureSummary[]>([]);
  const [thumbs, setThumbs] = useState<ThumbState>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capturesError, setCapturesError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    setCapturesError(null);
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
          if (item.kind === 'photo' && !thumbs[item.id]) {
            getCaptureDownloadUrl(item.id)
              .then((d) => setThumbs((t) => ({ ...t, [item.id]: d.url })))
              .catch(() => setThumbs((t) => ({ ...t, [item.id]: null })));
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
  }, [id, thumbs]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

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
      <Text style={styles.title}>
        {assignment.name ?? assignment.id.slice(0, 12)}
      </Text>
      <View style={styles.metaBlock}>
        <MetaRow label="Jurisdiction" value={assignment.jurisdiction ?? '—'} />
        <MetaRow label="State" value={assignment.state} />
        <MetaRow label="Domain" value={assignment.domain} />
        <MetaRow label="Created" value={fmt(assignment.created_at)} />
      </View>

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
