/**
 * Assignment detail. Shows the assignment + its workfiles +
 * source-document attachments. From here the user starts capture
 * sessions (photos, voice notes, etc.) tied to a specific workfile.
 *
 * v0.1 is read-only — the live workfile-create + attachment-upload
 * happen via the web app. Subsequent milestones add native capture
 * + offline upload here so the field workflow stays inside the
 * mobile surface.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Brand, Radius, Spacing } from '@/constants/theme';
import { getAssignment, type AssignmentSummary } from '@/lib/api';

export default function AssignmentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [assignment, setAssignment] = useState<AssignmentSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const got = await getAssignment(id);
      setAssignment(got);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
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
          <Pressable style={styles.retry} onPress={() => router.back()}>
            <Text style={styles.retryLabel}>← Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.flex}>
      <ScrollView contentContainerStyle={styles.scroll}>
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

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Workfiles</Text>
          <Text style={styles.sectionBody}>
            Native workfile creation + attachment upload land in a
            follow-up milestone. For now, manage workfiles in the web
            app; this screen lists them once they exist.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Field capture</Text>
          <Text style={styles.sectionBody}>
            Tap the Capture tab to start a photo + geotag + voice-note
            session. Captures stay on this device until you sync them
            to a workfile.
          </Text>
        </View>
      </ScrollView>
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

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Brand.cream },
  scroll: { padding: Spacing.four, gap: Spacing.four },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.five,
  },
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
  section: {
    backgroundColor: Brand.surface,
    padding: Spacing.four,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: Brand.gold,
    marginBottom: Spacing.two,
  },
  sectionBody: { fontSize: 14, lineHeight: 22, color: Brand.inkMuted },
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
