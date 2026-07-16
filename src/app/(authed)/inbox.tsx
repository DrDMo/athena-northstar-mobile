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
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { CaptureRow } from '@/components/CaptureRow';
import { Brand, Radius, Spacing } from '@/constants/theme';
import {
  deleteCapture,
  assignmentPickerLabel,
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

  // TODO(picker-reuse, low): this `showAssignmentPicker` duplicates
  // `src/lib/assignment-picker.ts` (the same slice(0, 8) + label format).
  // A future cleanup could build this on `pickAssignment()` — call it,
  // and on a resolved id run the link + optimistic-remove below. Left
  // as-is for now because the inbox flow has behavior the shared picker
  // doesn't: a distinct "No assignments — create one first" message on
  // the empty case (the shared picker silently resolves to null), no
  // "Keep in inbox" affordance, and a link side-effect bound to each
  // button. Migrating risks regressing the file/delete path, which must
  // stay byte-for-byte identical, so the shared picker isn't adopted here
  // yet. Don't break the inbox.

  // Declared before onLinkCapture so the picker is in scope when the
  // assignments promise resolves (avoids a use-before-declare).
  const showAssignmentPicker = useCallback(
    (capture: CaptureSummary, assignments: AssignmentSummary[]) => {
      const buttons = assignments.slice(0, 8).map((a) => ({
        text: assignmentPickerLabel(a),
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
          <InboxCaptureRow
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
// Row — the shared presentational CaptureRow (thumb + GPS + body), wrapped
// here with the Inbox-only File/Delete action column as a sibling. The
// `showSize` flag preserves the Inbox's "5m ago · 1.2 MB" meta line.
// ---------------------------------------------------------------------------

function InboxCaptureRow({
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
      <CaptureRow item={item} thumbUrl={thumbUrl} onPress={onOpen} showSize />

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
