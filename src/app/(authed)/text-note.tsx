/**
 * Text note capture — type an in-the-field note and queue it for
 * upload through the same sync layer that handles photos + voice notes.
 *
 * No-binary upload: the backend captures handler
 * (`POST /v1/captures`) REQUIRES a non-empty multipart `file` part — it
 * has no meta-only path and rejects an empty upload with
 * `400 "uploaded file is empty"`. So a text note carries its body as a
 * temp `.txt` file (written via {@link writeTextNoteFile}, content-type
 * `text/plain; charset=utf-8` — the server's default for `text_note`).
 * A short title travels in `meta.caption`; the full body is the file.
 *
 * Filing: the appraiser can file the note to an assignment at save time
 * (reusing the Inbox's assignment picker) or leave it in the inbox to
 * triage later — same posture as a photo.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Brand, Radius, Spacing } from '@/constants/theme';
import {
  type CaptureMeta,
  getCurrentGeo,
  newCaptureId,
  writeTextNoteFile,
} from '@/lib/capture';
import { pickAssignment } from '@/lib/assignment-picker';
import { enqueue } from '@/lib/queue';
import { syncNow } from '@/lib/sync';

export default function TextNoteScreen() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [locationDenied, setLocationDenied] = useState(false);

  async function onSave() {
    if (busy) return;
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      Alert.alert('Nothing to save', 'Type a note before saving.');
      return;
    }
    setBusy(true);
    try {
      // Let the user file to an assignment now, or keep it in the inbox.
      // A picker failure (e.g. offline) isn't fatal — fall back to inbox.
      let assignmentId: string | null = null;
      try {
        assignmentId = await pickAssignment();
      } catch {
        assignmentId = null;
      }

      const id = newCaptureId();
      // Write the body to a temp .txt — this is the file the sync layer
      // uploads as the required `file` part (no meta-only path exists).
      const localUri = writeTextNoteFile(id, trimmedBody);

      const meta: CaptureMeta = {
        id,
        kind: 'text_note',
        localUri,
        capturedAt: new Date().toISOString(),
        // A short label in meta.caption; the full text is the file body.
        caption: title.trim() || trimmedBody.slice(0, 80),
        status: 'pending',
      };
      if (assignmentId) meta.assignmentId = assignmentId;

      // Best-effort geotag, same posture as the photo/voice screens.
      try {
        const geo = await getCurrentGeo({
          onDenied: () => setLocationDenied(true),
        });
        if (geo) meta.geo = geo;
      } catch {
        // swallow — a note without a geotag is fine
      }

      await enqueue(meta);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void syncNow();
      router.back();
    } catch (e) {
      Alert.alert('Save failed', (e as Error).message);
    } finally {
      // Always release the busy lock so the Cancel/Save controls can never
      // be stranded disabled (e.g. if the picker resolved oddly). router
      // navigates away on success; resetting here on an already-popped
      // screen is a harmless no-op.
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.topBar}>
            {/* Never gated on `busy` — the user must always be able to
                back out (the picker / save can otherwise leave them
                stranded). router.back() during a save is safe; the
                in-flight enqueue still completes. */}
            <Pressable
              style={[styles.closeButton, styles.closeRow]}
              onPress={() => router.back()}
            >
              <Ionicons name="arrow-back" size={15} color={Brand.navyDeep} />
              <Text style={styles.closeLabel}>Cancel</Text>
            </Pressable>
          </View>

          <Text style={styles.eyebrow}>TEXT NOTE</Text>
          <Text style={styles.title}>Write a note</Text>
          <Text style={styles.lede}>
            Typed notes save on this device and upload when you have
            signal — same as a photo or voice note. File it to an
            assignment now, or keep it in your inbox to triage later.
          </Text>

          {locationDenied ? (
            <View style={styles.geoHint}>
              <Text style={styles.geoHintLabel}>
                No location — this note won&apos;t be geotagged
              </Text>
            </View>
          ) : null}

          <Text style={styles.label}>Title (optional)</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Roof condition"
            placeholderTextColor={Brand.inkFaint}
            editable={!busy}
            returnKeyType="next"
          />

          <Text style={styles.label}>Note</Text>
          <TextInput
            style={[styles.input, styles.bodyInput]}
            value={body}
            onChangeText={setBody}
            placeholder="What you observed…"
            placeholderTextColor={Brand.inkFaint}
            editable={!busy}
            multiline
            textAlignVertical="top"
          />

          <Pressable
            style={({ pressed }) => [
              styles.save,
              busy && styles.saveBusy,
              pressed && !busy && styles.savePressed,
            ]}
            onPress={onSave}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={Brand.cream} />
            ) : (
              <Text style={styles.saveLabel}>Save note</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Brand.cream },
  scroll: { padding: Spacing.four },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.three,
  },
  closeButton: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  closeRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  closeLabel: { color: Brand.navyDeep, fontSize: 15, fontWeight: '600' },
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
  lede: {
    fontSize: 14,
    color: Brand.inkMuted,
    lineHeight: 22,
    marginTop: Spacing.three,
    marginBottom: Spacing.four,
  },
  geoHint: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.pill,
    backgroundColor: Brand.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.amber,
    marginBottom: Spacing.two,
  },
  geoHintLabel: { color: Brand.amber, fontSize: 12, fontWeight: '600' },
  label: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    color: Brand.inkMuted,
    marginBottom: Spacing.two,
    marginTop: Spacing.three,
  },
  input: {
    backgroundColor: Brand.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 16,
    color: Brand.ink,
  },
  bodyInput: {
    minHeight: 160,
  },
  save: {
    backgroundColor: Brand.navyDeep,
    paddingVertical: Spacing.three,
    borderRadius: Radius.md,
    alignItems: 'center',
    marginTop: Spacing.five,
  },
  saveBusy: { opacity: 0.7 },
  savePressed: { opacity: 0.85 },
  saveLabel: { color: Brand.cream, fontSize: 16, fontWeight: '700' },
});
