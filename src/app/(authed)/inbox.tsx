/**
 * Capture Inbox — the server-side view of everything the appraiser
 * has uploaded but not yet filed to an assignment.
 *
 * Why this is its own tab (not a section in Settings or Captures):
 * triage is a workflow, not a setting. The appraiser walks a property,
 * shoots 30 photos + 10 voice notes across 3 hours, comes back to the
 * truck, opens the Inbox, and bulk-files them. That moment deserves
 * its own surface.
 *
 * Local cache strategy: each render pulls fresh from the server. We
 * don't try to merge the local AsyncStorage queue with the server
 * inbox here — the queue is "in flight," the inbox is "landed." Items
 * walk pending → uploading → synced (queue) → unfiled (inbox) →
 * filed (gone from inbox, present under a case).
 */

import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { Brand, Radius, Spacing } from '@/constants/theme';
import {
  deleteCapture,
  getCaptureDownloadUrl,
  linkCapture,
  listAssignments,
  listCaptureInbox,
  type AssignmentSummary,
  type CaptureSummary,
} from '@/lib/api';

type ThumbState = Record<string, string | null>; // capture.id → presigned url (null while loading)

export default function InboxScreen() {
  const router = useRouter();
  const [items, setItems] = useState<CaptureSummary[]>([]);
  const [thumbs, setThumbs] = useState<ThumbState>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const got = await listCaptureInbox();
      setItems(got);
      // Kick off thumbnail fetches for photos; voice notes use an icon.
      for (const item of got) {
        if (item.kind === 'photo' && !thumbs[item.id]) {
          getCaptureDownloadUrl(item.id)
            .then((d) => setThumbs((t) => ({ ...t, [item.id]: d.url })))
            .catch(() => setThumbs((t) => ({ ...t, [item.id]: null })));
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [thumbs]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  // Declared before onLinkCapture so the picker is in scope when the
  // assignments promise resolves (avoids a use-before-declare).
  const showAssignmentPicker = useCallback(
    (capture: CaptureSummary, assignments: AssignmentSummary[]) => {
      const buttons = assignments.slice(0, 8).map((a) => ({
        text: a.name ?? `${a.jurisdiction ?? a.state} · ${a.id.slice(0, 8)}`,
        onPress: async () => {
          try {
            void Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Success,
            );
            await linkCapture(capture.id, { case_id: a.id });
            setItems((prev) => prev.filter((c) => c.id !== capture.id));
          } catch (e) {
            Alert.alert('Link failed', (e as Error).message);
          }
        },
      }));
      Alert.alert('File to assignment', undefined, [
        ...buttons,
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [],
  );

  const onLinkCapture = useCallback(
    (capture: CaptureSummary) => {
      // Pull assignments fresh so the picker isn't stale.
      listAssignments()
        .then((assignments) => {
          if (assignments.length === 0) {
            Alert.alert(
              'No assignments',
              'Create an assignment from the Assignments tab first, then come back to file this capture.',
            );
            return;
          }
          showAssignmentPicker(capture, assignments);
        })
        .catch((e) =>
          Alert.alert('Couldn’t load assignments', (e as Error).message),
        );
    },
    [showAssignmentPicker],
  );

  const onDeleteCapture = useCallback((capture: CaptureSummary) => {
    Alert.alert(
      'Delete capture?',
      'This removes the capture from your inbox. Cannot be undone from this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
            try {
              await deleteCapture(capture.id);
              setItems((prev) => prev.filter((c) => c.id !== capture.id));
            } catch (e) {
              Alert.alert('Delete failed', (e as Error).message);
            }
          },
        },
      ],
    );
  }, []);

  // -------------------------------------------------------------------------
  // Render states
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.center}>
          <ActivityIndicator color={Brand.gold} />
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Couldn&apos;t load your inbox</Text>
          <Text style={styles.errorBody}>{error}</Text>
          <Pressable style={styles.retry} onPress={load}>
            <Text style={styles.retryLabel}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (items.length === 0) {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.center}>
          <Text style={styles.emptyEyebrow}>INBOX ZERO</Text>
          <Text style={styles.emptyTitle}>Nothing to file</Text>
          <Text style={styles.emptyBody}>
            New photos + voice notes show up here after they sync.
            Capture them from the Capture tab, then come back to file
            them into an assignment.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.flex}>
      <FlatList
        contentContainerStyle={styles.list}
        data={items}
        keyExtractor={(it) => it.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Brand.gold}
          />
        }
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Text style={styles.eyebrow}>UNFILED CAPTURES</Text>
            <Text style={styles.headerCount}>
              {items.length} waiting to file
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <CaptureRow
            item={item}
            thumbUrl={thumbs[item.id]}
            onOpen={() => router.push(`/captures/${item.id}`)}
            onLink={() => onLinkCapture(item)}
            onDelete={() => onDeleteCapture(item)}
          />
        )}
      />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function CaptureRow({
  item,
  thumbUrl,
  onOpen,
  onLink,
  onDelete,
}: {
  item: CaptureSummary;
  thumbUrl: string | null | undefined;
  onOpen: () => void;
  onLink: () => void;
  onDelete: () => void;
}) {
  return (
    <View style={styles.row}>
      <Pressable
        style={({ pressed }) => [styles.rowTap, pressed && styles.actionPressed]}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`Open ${labelFor(item.kind)}`}
      >
        <View style={styles.thumbWrap}>
          {item.kind === 'photo' && thumbUrl ? (
            <Image source={{ uri: thumbUrl }} style={styles.thumb} />
          ) : item.kind === 'photo' ? (
            <View style={[styles.thumb, styles.thumbPlaceholder]}>
              <ActivityIndicator color={Brand.gold} size="small" />
            </View>
          ) : (
            <View style={[styles.thumb, styles.thumbIcon]}>
              <Text style={styles.thumbIconLabel}>{iconFor(item.kind)}</Text>
            </View>
          )}
          {item.geo ? (
            <View style={styles.gpsBadge}>
              <Text style={styles.gpsBadgeLabel}>GPS</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.rowBody}>
          <Text style={styles.rowTitle}>{labelFor(item.kind)}</Text>
          <Text style={styles.rowMeta}>
            {relativeTime(item.captured_at)} · {formatBytes(item.size_bytes)}
          </Text>
          {item.caption ? (
            <Text style={styles.rowCaption} numberOfLines={2}>
              {item.caption}
            </Text>
          ) : null}
        </View>
      </Pressable>

      <View style={styles.rowActions}>
        <Pressable
          style={({ pressed }) => [
            styles.actionBtn,
            styles.actionPrimary,
            pressed && styles.actionPressed,
          ]}
          onPress={onLink}
        >
          <Text style={styles.actionPrimaryLabel}>File</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.actionGhost, pressed && styles.actionPressed]}
          onPress={onDelete}
          hitSlop={8}
        >
          <Text style={styles.actionGhostLabel}>Delete</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function iconFor(kind: CaptureSummary['kind']): string {
  switch (kind) {
    case 'voice_note':
      return '🎙';
    case 'sketch':
      return '✏️';
    case 'text_note':
      return '📝';
    case 'photo':
    default:
      return '📷';
  }
}

function labelFor(kind: CaptureSummary['kind']): string {
  switch (kind) {
    case 'voice_note':
      return 'Voice note';
    case 'sketch':
      return 'Sketch';
    case 'text_note':
      return 'Text note';
    case 'photo':
    default:
      return 'Photo';
  }
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604_800) return `${Math.floor(diffSec / 86_400)}d ago`;
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Brand.cream },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.five,
  },
  list: { padding: Spacing.three, gap: Spacing.three },
  listHeader: {
    marginBottom: Spacing.three,
    paddingTop: Spacing.two,
  },
  eyebrow: {
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: '700',
    color: Brand.gold,
  },
  headerCount: {
    fontSize: 15,
    fontWeight: '600',
    color: Brand.navyDeep,
    marginTop: Spacing.one,
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
  rowTap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  thumbWrap: { position: 'relative' },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: Radius.sm,
    backgroundColor: '#1a1a1a',
  },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  thumbIcon: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Brand.cream,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  thumbIconLabel: { fontSize: 24 },
  gpsBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: Brand.green,
  },
  gpsBadgeLabel: { color: '#fff', fontSize: 8, fontWeight: '700' },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '600', color: Brand.navyDeep },
  rowMeta: {
    fontSize: 12,
    color: Brand.inkMuted,
    marginTop: 2,
  },
  rowCaption: {
    fontSize: 12,
    color: Brand.ink,
    marginTop: Spacing.one,
    fontStyle: 'italic',
  },
  rowActions: {
    flexDirection: 'column',
    gap: Spacing.two,
    alignItems: 'flex-end',
  },
  actionBtn: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.sm,
    minWidth: 64,
    alignItems: 'center',
  },
  actionPrimary: { backgroundColor: Brand.navyDeep },
  actionPrimaryLabel: { color: Brand.cream, fontSize: 13, fontWeight: '600' },
  actionGhost: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  actionGhostLabel: { color: Brand.red, fontSize: 12 },
  actionPressed: { opacity: 0.7 },
  emptyEyebrow: {
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: '700',
    color: Brand.gold,
    marginBottom: Spacing.two,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: Brand.navyDeep,
    marginBottom: Spacing.three,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 14,
    color: Brand.inkMuted,
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: Spacing.three,
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
  retryLabel: { color: Brand.cream, fontWeight: '600' },
});
