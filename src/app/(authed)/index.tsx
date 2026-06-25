/**
 * Assignments list — the home tab.
 *
 * Pulls /v1/cases for the current tenant and renders one row per
 * assignment. A "+ New" button (header + empty-state) opens the
 * new-assignment form so the appraiser can start a draft from the
 * phone instead of switching to the web app.
 *
 * Pending drafts: `POST /v1/cases` creates an unpaid
 * `payment_status='pending'` draft (the $99 activation is paid on the
 * web). The backend list (`case_files::list_for_tenant`) has NO
 * payment_status filter, so it returns pending drafts alongside paid
 * assignments. Rather than hide them, we render pending rows with a
 * "Pending payment" badge so a draft created here stays visible until
 * the user pays for it.
 */

import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { useCallback, useLayoutEffect, useState } from 'react';
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

import { Brand, Radius, Spacing } from '@/constants/theme';
import { listAssignments, type AssignmentSummary } from '@/lib/api';

export default function AssignmentsScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const [items, setItems] = useState<AssignmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const got = await listAssignments();
      setItems(got);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Re-fetch every time the tab gains focus — covers the case
  // where the user creates an assignment elsewhere (web, another
  // device) and comes back to this tab.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Header "+ New" affordance. Set here (not in the layout) so the
  // press handler can use this screen's router.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          style={({ pressed }) => [styles.headerBtn, pressed && styles.headerBtnPressed]}
          onPress={() => router.push('/new-assignment')}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="New assignment"
        >
          <Text style={styles.headerBtnLabel}>+ New</Text>
        </Pressable>
      ),
    });
  }, [navigation, router]);

  function onRefresh() {
    setRefreshing(true);
    load();
  }

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
          <Text style={styles.errorTitle}>Couldn&apos;t load assignments</Text>
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
          <Text style={styles.emptyTitle}>No assignments yet</Text>
          <Text style={styles.emptyBody}>
            Start one here, or open it from the web app at
            appraisal.athenanorthstar.com — it&apos;ll show up here on the
            next refresh.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.newBtn, pressed && styles.newBtnPressed]}
            onPress={() => router.push('/new-assignment')}
          >
            <Text style={styles.newBtnLabel}>+ New assignment</Text>
          </Pressable>
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
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        renderItem={({ item }) => {
          const pending = item.payment_status === 'pending';
          return (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => router.push(`/assignments/${item.id}`)}
            >
              <View style={styles.rowTop}>
                <Text style={styles.rowTitle}>
                  {item.name ?? item.id.slice(0, 8)}
                </Text>
                {pending ? (
                  <View style={styles.pendingBadge}>
                    <Text style={styles.pendingBadgeLabel}>Pending payment</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.rowMeta}>
                {item.jurisdiction ?? '—'} · {item.state}
              </Text>
            </Pressable>
          );
        }}
      />
    </SafeAreaView>
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
  list: { padding: Spacing.four, gap: Spacing.three },
  row: {
    backgroundColor: Brand.surface,
    padding: Spacing.four,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  rowPressed: { opacity: 0.7 },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  rowTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: Brand.navyDeep,
  },
  rowMeta: {
    marginTop: Spacing.one,
    fontSize: 12,
    color: Brand.inkMuted,
    letterSpacing: 0.5,
  },
  pendingBadge: {
    backgroundColor: Brand.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.amber,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.three,
    paddingVertical: 2,
  },
  pendingBadgeLabel: {
    color: Brand.amber,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  headerBtn: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  headerBtnPressed: { opacity: 0.6 },
  headerBtnLabel: {
    color: Brand.gold,
    fontSize: 16,
    fontWeight: '700',
  },
  newBtn: {
    backgroundColor: Brand.navyDeep,
    paddingHorizontal: Spacing.five,
    paddingVertical: Spacing.three,
    borderRadius: Radius.md,
    marginTop: Spacing.five,
  },
  newBtnPressed: { opacity: 0.85 },
  newBtnLabel: { color: Brand.cream, fontSize: 15, fontWeight: '700' },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: Brand.navyDeep,
    marginBottom: Spacing.three,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 14,
    color: Brand.inkMuted,
    textAlign: 'center',
    lineHeight: 22,
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
