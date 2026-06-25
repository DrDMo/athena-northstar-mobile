/**
 * Capture detail — open a single capture from the Inbox to see its
 * meta and, for voice notes, the typed transcription.
 *
 * The list endpoint (`GET /v1/captures`) already returns
 * `transcript_status` + `transcript_text`, so the first paint comes
 * from the inbox data the user just tapped. Pull-to-refresh re-polls
 * the transcription pipeline via `refreshTranscript`, which returns
 * the freshest single capture — handy while a job is still running.
 *
 * Voice-note states the appraiser can land on:
 *   - completed → show the transcript text
 *   - queued / in_progress → "Queued" / "Transcribing…"
 *   - failed → "Transcription failed"
 *   - null/none → "Not transcribed yet"
 */

import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Brand, Radius, Spacing } from '@/constants/theme';
import {
  listCaptureInbox,
  refreshTranscript,
  type CaptureSummary,
} from '@/lib/api';

export default function CaptureDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [capture, setCapture] = useState<CaptureSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // First paint: pull the inbox and find this capture. There's no
  // single-capture GET, but the inbox already carries everything we
  // need (including the transcript fields).
  const loadFromInbox = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const all = await listCaptureInbox();
      const found = all.find((c) => c.id === id) ?? null;
      if (!found) {
        setError('This capture is no longer in your inbox.');
      } else {
        setCapture(found);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      loadFromInbox();
    }, [loadFromInbox]),
  );

  // Pull-to-refresh re-polls the transcription pipeline and swaps in
  // the fresh capture. Friendly errors surface as a notice line rather
  // than blowing away the screen.
  const onRefresh = useCallback(async () => {
    if (!id) return;
    setRefreshing(true);
    setNotice(null);
    try {
      const updated = await refreshTranscript(id);
      setCapture(updated);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [id]);

  if (loading) {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.center}>
          <ActivityIndicator color={Brand.gold} />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !capture) {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Couldn&apos;t open this capture</Text>
          <Text style={styles.errorBody}>{error ?? 'Not found.'}</Text>
          <Pressable style={styles.retry} onPress={() => router.back()}>
            <Text style={styles.retryLabel}>← Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const isVoice = capture.kind === 'voice_note';

  return (
    <SafeAreaView style={styles.flex}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Brand.gold}
          />
        }
      >
        <Text style={styles.eyebrow}>{labelFor(capture.kind).toUpperCase()}</Text>
        <Text style={styles.title}>{labelFor(capture.kind)}</Text>

        <View style={styles.metaBlock}>
          <MetaRow label="Captured" value={fmtDateTime(capture.captured_at)} />
          <MetaRow label="Uploaded" value={fmtDateTime(capture.uploaded_at)} />
          {capture.geo?.lat != null && capture.geo?.lon != null ? (
            <MetaRow
              label="Location"
              value={`${capture.geo.lat.toFixed(5)}, ${capture.geo.lon.toFixed(5)}`}
            />
          ) : (
            <MetaRow label="Location" value="No geotag" />
          )}
        </View>

        {capture.caption ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Caption</Text>
            <Text style={styles.sectionBody}>{capture.caption}</Text>
          </View>
        ) : null}

        {isVoice ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Transcription</Text>
            {capture.transcript_text ? (
              <Text style={styles.transcript}>{capture.transcript_text}</Text>
            ) : (
              <Text style={styles.statusLine}>
                {transcriptStatusLine(capture.transcript_status)}
              </Text>
            )}
            <Text style={styles.refreshHint}>Pull down to refresh.</Text>
          </View>
        ) : null}

        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
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

/** Plain-language line for a voice note that has no transcript text. */
function transcriptStatusLine(status?: string): string {
  switch (status) {
    case 'in_progress':
      return 'Transcribing…';
    case 'queued':
      return 'Queued';
    case 'failed':
      return 'Transcription failed';
    case 'completed':
      // Completed but no text — treat as empty result.
      return 'No speech found in this recording.';
    default:
      return 'Not transcribed yet';
  }
}

function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
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
  metaValue: { color: Brand.ink, fontSize: 13 },
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
  transcript: {
    fontSize: 15,
    lineHeight: 24,
    color: Brand.ink,
  },
  statusLine: {
    fontSize: 15,
    color: Brand.inkMuted,
    fontStyle: 'italic',
  },
  refreshHint: {
    fontSize: 12,
    color: Brand.inkFaint,
    marginTop: Spacing.three,
  },
  notice: {
    fontSize: 13,
    color: Brand.amber,
    textAlign: 'center',
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
