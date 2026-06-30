/**
 * Capture detail — open a single capture from the Inbox to see its
 * meta and, for voice notes, the typed transcription.
 *
 * The list endpoints (`GET /v1/captures` for the unfiled inbox,
 * `GET /v1/cases/{id}/captures` for a filed assignment) already return
 * `transcript_status` + `transcript_text`, so the first paint comes
 * from the list data the user just tapped. When the caller hands us a
 * `caseId` route param, this capture is *filed* and won't be in the
 * inbox, so we fall back to the assignment's captures. Pull-to-refresh
 * re-polls the transcription pipeline via `refreshTranscript`, which
 * returns the freshest single capture — handy while a job is running.
 *
 * Voice-note states the appraiser can land on:
 *   - completed → show the transcript text
 *   - queued / in_progress → "Queued" / "Transcribing…"
 *   - failed → "Transcription failed"
 *   - null/none → "Not transcribed yet"
 */

import { Ionicons } from '@react-native-vector-icons/ionicons';
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
  listAssignmentCaptures,
  listCaptureInbox,
  refreshTranscript,
  type CaptureSummary,
} from '@/lib/api';
import { labelFor } from '@/lib/captureLabels';

export default function CaptureDetailScreen() {
  const { id, caseId } = useLocalSearchParams<{ id: string; caseId?: string }>();
  const router = useRouter();
  const [capture, setCapture] = useState<CaptureSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // First paint: resolve this capture. There's no single-capture GET, so
  // we look in the unfiled inbox first (the path from the Inbox tab). If
  // it's not there AND we were handed a `caseId` (the path from an
  // assignment detail), it's a *filed* capture — fall back to that
  // assignment's captures, which is where filed rows live. Both list
  // endpoints already carry the transcript fields, so either source
  // gives a fully-populated row.
  const resolveCapture = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const inbox = await listCaptureInbox();
      let found = inbox.find((c) => c.id === id) ?? null;
      if (!found && caseId) {
        const filed = await listAssignmentCaptures(caseId);
        found = filed.find((c) => c.id === id) ?? null;
      }
      if (!found) {
        setError(
          caseId
            ? 'This capture is no longer available.'
            : 'This capture is no longer in your inbox.',
        );
      } else {
        setCapture(found);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id, caseId]);

  useFocusEffect(
    useCallback(() => {
      resolveCapture();
    }, [resolveCapture]),
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
  retryRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  retryLabel: { color: Brand.cream, fontWeight: '600' },
});
