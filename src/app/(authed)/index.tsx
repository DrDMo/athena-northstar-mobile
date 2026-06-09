/**
 * Assignments list — the home tab.
 *
 * Pulls /v1/cases for the current tenant and renders one row per
 * active assignment. Empty state nudges the user to create their
 * first assignment from the web app for now; in a follow-up
 * milestone we add a "+ New" affordance directly here.
 */

import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
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
          <Text style={styles.emptyTitle}>No active assignments</Text>
          <Text style={styles.emptyBody}>
            Open one from the web app at appraisal.athenanorthstar.com
            — it&apos;ll show up here on the next refresh.
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
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => router.push(`/assignments/${item.id}`)}
          >
            <Text style={styles.rowTitle}>
              {item.name ?? item.id.slice(0, 8)}
            </Text>
            <Text style={styles.rowMeta}>
              {item.jurisdiction ?? '—'} · {item.state}
            </Text>
          </Pressable>
        )}
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
  rowTitle: {
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
