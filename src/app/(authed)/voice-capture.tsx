/**
 * Voice note capture — record an in-the-field audio note and queue
 * it for upload through the same sync layer that handles photos.
 *
 * UX: one big circular Record/Stop button. Tap-once records, tap-twice
 * stops. Duration shows live during the recording. After stop:
 * - Show a brief "saved" confirmation
 * - The capture flows through the queue → /v1/captures with
 *   `kind: voice_note`, content-type `audio/m4a`
 *
 * No transcription on-device — that lives server-side in a follow-up
 * milestone. The audit chain stores the raw .m4a; transcription is
 * a derived view.
 *
 * Best-effort geotag at start-of-recording, same pattern as the
 * photo capture screen.
 */

import {
  AudioModule,
  RecordingPresets,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Brand, Radius, Spacing } from '@/constants/theme';
import { type CaptureMeta, getCurrentGeo, newCaptureId } from '@/lib/capture';
import { enqueue } from '@/lib/queue';
import { syncNow } from '@/lib/sync';

type PermState = 'unknown' | 'granted' | 'denied-can-ask' | 'denied-blocked';

export default function VoiceCaptureScreen() {
  const router = useRouter();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);

  const [perm, setPerm] = useState<PermState>('unknown');
  const [savedCount, setSavedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [locationDenied, setLocationDenied] = useState(false);

  // Request microphone permission once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (cancelled) return;
      if (status.granted) {
        setPerm('granted');
      } else if (status.canAskAgain) {
        setPerm('denied-can-ask');
      } else {
        setPerm('denied-blocked');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startRecording = useCallback(async () => {
    if (recorderState.isRecording || busy) return;
    setBusy(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (e) {
      Alert.alert('Recording failed to start', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [recorder, recorderState.isRecording, busy]);

  const stopRecording = useCallback(async () => {
    if (!recorderState.isRecording || busy) return;
    setBusy(true);
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) {
        Alert.alert('No audio captured', 'The recording ended without a file.');
        return;
      }

      const meta: CaptureMeta = {
        id: newCaptureId(),
        kind: 'voice_note',
        localUri: uri,
        capturedAt: new Date().toISOString(),
        status: 'pending',
      };

      // Best-effort geotag, same posture as the photo screen.
      try {
        const geo = await getCurrentGeo({
          onDenied: () => setLocationDenied(true),
        });
        if (geo) {
          setLocationDenied(false);
          meta.geo = geo;
        }
      } catch {
        // swallow; locationDenied flag drives the UI hint
      }

      await enqueue(meta);
      setSavedCount((n) => n + 1);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void syncNow();
    } catch (e) {
      Alert.alert('Save failed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [recorder, recorderState.isRecording, busy]);

  // -------------------------------------------------------------------------
  // Permission gate
  // -------------------------------------------------------------------------

  if (perm === 'unknown') {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.center}>
          <ActivityIndicator color={Brand.gold} />
        </View>
      </SafeAreaView>
    );
  }

  if (perm !== 'granted') {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.center}>
          <Text style={styles.permTitle}>Microphone access needed</Text>
          <Text style={styles.permBody}>
            North Star uses the microphone to record on-site voice notes.
            Recordings stay on this device until you sync them to a workfile.
          </Text>
          <Pressable
            style={styles.permButton}
            onPress={async () => {
              if (perm === 'denied-can-ask') {
                const status = await AudioModule.requestRecordingPermissionsAsync();
                setPerm(status.granted ? 'granted' : 'denied-blocked');
              } else {
                await Linking.openSettings();
              }
            }}
          >
            <Text style={styles.permButtonLabel}>
              {perm === 'denied-can-ask' ? 'Allow microphone' : 'Open Settings'}
            </Text>
          </Pressable>
          <Pressable style={styles.permLater} onPress={() => router.back()}>
            <Text style={styles.permLaterLabel}>Not now</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // -------------------------------------------------------------------------
  // Recording surface
  // -------------------------------------------------------------------------

  const isRecording = recorderState.isRecording;
  const durationMs = recorderState.durationMillis ?? 0;

  return (
    <SafeAreaView style={styles.flex}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.topBar}>
          <Pressable style={styles.closeButton} onPress={() => router.back()}>
            <Text style={styles.closeLabel}>← Done</Text>
          </Pressable>
          {savedCount > 0 ? (
            <Text style={styles.savedBadge}>{savedCount} saved</Text>
          ) : null}
        </View>

        <Text style={styles.eyebrow}>VOICE NOTE</Text>
        <Text style={styles.title}>
          {isRecording ? 'Recording…' : 'Tap to record'}
        </Text>
        <Text style={styles.timer}>{formatDuration(durationMs)}</Text>

        {locationDenied ? (
          <View style={styles.geoHint}>
            <Text style={styles.geoHintLabel}>
              No location — recordings won&apos;t be geotagged
            </Text>
          </View>
        ) : null}

        <View style={styles.shutterWrap}>
          <Pressable
            style={[
              styles.shutter,
              isRecording && styles.shutterRecording,
              busy && styles.shutterBusy,
            ]}
            onPress={isRecording ? stopRecording : startRecording}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={isRecording ? 'Stop recording' : 'Start recording'}
          >
            {isRecording ? (
              <View style={styles.shutterStop} />
            ) : (
              <View style={styles.shutterDot} />
            )}
          </Pressable>
        </View>

        <Text style={styles.lede}>
          Recordings save locally with timestamp + best-effort geotag,
          then upload automatically when you have signal. Transcription
          happens server-side after sync.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );

}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60)
    .toString()
    .padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Brand.cream },
  scroll: { padding: Spacing.four, alignItems: 'center' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.five,
  },
  topBar: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.four,
  },
  closeButton: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  closeLabel: { color: Brand.navyDeep, fontSize: 15, fontWeight: '600' },
  savedBadge: {
    color: Brand.green,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    backgroundColor: Brand.surface,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.green,
  },
  eyebrow: {
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: '700',
    color: Brand.gold,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: Brand.navyDeep,
    marginTop: Spacing.two,
  },
  timer: {
    fontSize: 56,
    fontWeight: '300',
    color: Brand.ink,
    marginTop: Spacing.three,
    fontFamily: 'monospace',
    letterSpacing: 2,
  },
  geoHint: {
    marginTop: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.pill,
    backgroundColor: Brand.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.amber,
  },
  geoHintLabel: { color: Brand.amber, fontSize: 12, fontWeight: '600' },
  shutterWrap: {
    marginTop: Spacing.six,
    alignItems: 'center',
  },
  shutter: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: Brand.surface,
    borderWidth: 5,
    borderColor: Brand.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterRecording: {
    backgroundColor: Brand.red,
    borderColor: Brand.red,
  },
  shutterBusy: { opacity: 0.5 },
  shutterDot: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: Brand.red,
  },
  shutterStop: {
    width: 50,
    height: 50,
    borderRadius: 6,
    backgroundColor: '#fff',
  },
  lede: {
    fontSize: 13,
    color: Brand.inkMuted,
    lineHeight: 20,
    marginTop: Spacing.six,
    textAlign: 'center',
    paddingHorizontal: Spacing.three,
  },
  permTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Brand.navyDeep,
    textAlign: 'center',
    marginBottom: Spacing.three,
  },
  permBody: {
    fontSize: 14,
    color: Brand.inkMuted,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: Spacing.five,
  },
  permButton: {
    backgroundColor: Brand.navyDeep,
    paddingHorizontal: Spacing.five,
    paddingVertical: Spacing.three,
    borderRadius: Radius.md,
    marginBottom: Spacing.three,
  },
  permButtonLabel: { color: Brand.cream, fontSize: 15, fontWeight: '600' },
  permLater: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  permLaterLabel: { color: Brand.inkMuted, fontSize: 13 },
});
