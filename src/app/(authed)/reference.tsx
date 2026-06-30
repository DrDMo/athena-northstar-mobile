/**
 * Rule Reference — the appraiser's pocket-USPAP.
 *
 * Pulls the tenant's active rule catalog and surfaces a search box +
 * filterable list. Use case: appraiser is on-site, gets a question
 * about whether condition X needs a comp adjustment or whether form
 * Y is required for FHA, opens this tab, types "FHA lead", taps the
 * matching rule, reads the citation + on-fail message.
 *
 * v0.1 search matches against rule id, name, citation section, and
 * severity. Full-text search across the message bodies is a follow-
 * up; expect to need a server-side index when the catalog grows
 * past a few hundred rules.
 */

import { Ionicons } from '@react-native-vector-icons/ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Brand, Radius, Spacing } from '@/constants/theme';
import {
  getRuleCatalog,
  listRuleCatalogs,
  type RuleEntry,
} from '@/lib/api';

export default function ReferenceScreen() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogVersion, setCatalogVersion] = useState<string | null>(null);
  const [rules, setRules] = useState<RuleEntry[]>([]);
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const catalogs = await listRuleCatalogs();
      if (catalogs.length === 0) {
        setRules([]);
        setCatalogVersion(null);
        return;
      }
      // Use the most recently published catalog as the active one.
      const sorted = [...catalogs].sort(
        (a, b) =>
          new Date(b.published_at).getTime() -
          new Date(a.published_at).getTime(),
      );
      const active = sorted[0];
      setCatalogVersion(active.version);
      const { rules: pulled } = await getRuleCatalog(active.id);
      setRules(pulled);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Pull-to-refresh: always re-fetch the newest catalog, even if we
  // already have rules — an admin may have published a new version.
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      // Only auto-load on focus if we don't have rules yet — the
      // catalog is large and doesn't change often. Pull-to-refresh
      // handles the explicit re-fetch path.
      if (rules.length === 0 && !error) {
        load();
      }
    }, [load, rules.length, error]),
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter((r) => {
      const hay = [
        r.id,
        r.name,
        r.severity,
        r.jurisdiction,
        r.citation?.source,
        r.citation?.section,
        r.citation?.subsection,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [query, rules]);

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
          <Text style={styles.errTitle}>Couldn&apos;t load the catalog</Text>
          <Text style={styles.errBody}>{error}</Text>
          <Pressable style={styles.retry} onPress={load}>
            <Text style={styles.retryLabel}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (rules.length === 0) {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.center}>
          <Text style={styles.eyebrow}>RULE REFERENCE</Text>
          <Text style={styles.emptyTitle}>No catalog published</Text>
          <Text style={styles.emptyBody}>
            Once an administrator publishes a rule catalog for your tenant,
            the rules appear here for in-field reference.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.flex}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>RULE REFERENCE</Text>
        {catalogVersion ? (
          <Text style={styles.versionLabel}>{catalogVersion}</Text>
        ) : null}
        <View style={styles.searchBox}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search by id, name, citation, severity…"
            placeholderTextColor={Brand.inkFaint}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
        </View>
        <Text style={styles.matchCount}>
          {filtered.length} of {rules.length} rules
        </Text>
      </View>

      <FlatList
        contentContainerStyle={styles.list}
        data={filtered}
        keyExtractor={(r) => r.id}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Brand.gold}
          />
        }
        renderItem={({ item }) => (
          <RuleCard
            rule={item}
            expanded={expandedId === item.id}
            onToggle={() =>
              setExpandedId((cur) => (cur === item.id ? null : item.id))
            }
          />
        )}
      />
    </SafeAreaView>
  );
}

function RuleCard({
  rule,
  expanded,
  onToggle,
}: {
  rule: RuleEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const sevColor = severityColor(rule.severity);
  return (
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.severityDot, { backgroundColor: sevColor }]} />
        <View style={styles.cardHeaderText}>
          <Text style={styles.cardId} numberOfLines={1}>
            {rule.id}
          </Text>
          {rule.name ? (
            <Text style={styles.cardName} numberOfLines={expanded ? undefined : 2}>
              {rule.name}
            </Text>
          ) : null}
        </View>
      </View>

      {expanded ? (
        <View style={styles.cardBody}>
          {rule.citation ? (
            <View style={styles.citationBlock}>
              <Text style={styles.fieldLabel}>Citation</Text>
              <Text style={styles.fieldValue}>
                {[
                  rule.citation.source,
                  rule.citation.section,
                  rule.citation.subsection
                    ? `(${rule.citation.subsection})`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
              </Text>
              {rule.citation.url ? (
                <Pressable
                  style={styles.linkRow}
                  onPress={() => Linking.openURL(rule.citation!.url!)}
                  hitSlop={6}
                >
                  <Text style={styles.linkLabel}>Open primary source</Text>
                  <Ionicons
                    name="open-outline"
                    size={13}
                    color={Brand.navyDeep}
                  />
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {rule.message?.on_fail ? (
            <View style={styles.messageBlock}>
              <Text style={styles.fieldLabel}>When this rule fails</Text>
              <Text style={styles.fieldValue}>{rule.message.on_fail}</Text>
            </View>
          ) : null}

          {rule.message?.on_pass ? (
            <View style={styles.messageBlock}>
              <Text style={styles.fieldLabel}>When this rule passes</Text>
              <Text style={[styles.fieldValue, styles.fieldValueMuted]}>
                {rule.message.on_pass}
              </Text>
            </View>
          ) : null}

          <View style={styles.metaRow}>
            {rule.severity ? (
              <Text style={[styles.metaPill, { borderColor: sevColor, color: sevColor }]}>
                {rule.severity.toUpperCase()}
              </Text>
            ) : null}
            {rule.jurisdiction ? (
              <Text style={styles.metaPill}>{rule.jurisdiction}</Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}

function severityColor(sev?: string): string {
  switch (sev) {
    case 'critical':
    case 'material':
      return Brand.red;
    case 'minor':
    case 'low':
      return Brand.amber;
    case 'info':
      return Brand.inkMuted;
    default:
      return Brand.gold;
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Brand.cream },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.five,
  },
  header: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
    backgroundColor: Brand.cream,
    borderBottomColor: Brand.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  eyebrow: {
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: '700',
    color: Brand.gold,
  },
  versionLabel: {
    fontSize: 12,
    color: Brand.inkMuted,
    marginTop: Spacing.one,
    fontFamily: 'monospace',
  },
  searchBox: {
    marginTop: Spacing.three,
    backgroundColor: Brand.surface,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
    paddingHorizontal: Spacing.three,
  },
  searchInput: {
    fontSize: 15,
    color: Brand.ink,
    paddingVertical: Spacing.three,
  },
  matchCount: {
    fontSize: 11,
    color: Brand.inkMuted,
    marginTop: Spacing.two,
    textAlign: 'right',
  },
  list: { padding: Spacing.three, gap: Spacing.three },
  card: {
    backgroundColor: Brand.surface,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  cardPressed: { opacity: 0.85 },
  cardHeader: {
    flexDirection: 'row',
    gap: Spacing.three,
    alignItems: 'flex-start',
  },
  severityDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
  },
  cardHeaderText: { flex: 1 },
  cardId: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: Brand.inkMuted,
    letterSpacing: 0.5,
  },
  cardName: {
    fontSize: 15,
    fontWeight: '600',
    color: Brand.navyDeep,
    marginTop: 2,
    lineHeight: 20,
  },
  cardBody: {
    marginTop: Spacing.three,
    paddingTop: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Brand.border,
    gap: Spacing.three,
  },
  citationBlock: { gap: Spacing.one },
  messageBlock: { gap: Spacing.one },
  fieldLabel: {
    fontSize: 10,
    letterSpacing: 1.5,
    fontWeight: '700',
    color: Brand.gold,
  },
  fieldValue: {
    fontSize: 14,
    color: Brand.ink,
    lineHeight: 20,
  },
  fieldValueMuted: { color: Brand.inkMuted, fontStyle: 'italic' },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  linkLabel: {
    fontSize: 13,
    color: Brand.navyDeep,
    fontWeight: '600',
  },
  metaRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    flexWrap: 'wrap',
  },
  metaPill: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderRadius: Radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
    color: Brand.inkMuted,
    overflow: 'hidden',
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Brand.navyDeep,
    marginTop: Spacing.three,
    marginBottom: Spacing.three,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 14,
    color: Brand.inkMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  errTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: Brand.red,
    marginBottom: Spacing.two,
    textAlign: 'center',
  },
  errBody: {
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
