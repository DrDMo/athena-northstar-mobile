/**
 * Address lookup — set the subject **property address** for an
 * assignment from where the appraiser is standing.
 *
 * Flow:
 *   1. Get the current GPS fix (expo-location, foreground permission).
 *   2. Reverse-geocode it (`Location.reverseGeocodeAsync`) into a
 *      street address, formatted from the SDK 56
 *      `LocationGeocodedAddress` fields (streetNumber, street, city,
 *      region, postalCode).
 *   3. Show that address EDITABLE — reverse geocoding is approximate at
 *      the curb, so the appraiser confirms or corrects it.
 *   4. On confirm:
 *        (a) capture it as a `text_note` (caption
 *            `Subject address: <addr>`) — a durable, audit-chained
 *            record that travels through the same offline sync queue as
 *            a photo, AND
 *        (b) SET it as the chosen assignment's subject property address
 *            via {@link setAssignmentProperty} (GET-merge-PATCH of
 *            `domain_extension.property_address`).
 *
 * The user picks the assignment with the shared {@link pickAssignment}
 * picker (same one the Inbox / text-note / MLS-scan screens use). If
 * they skip the picker (keep-in-inbox), we still save the text_note (a)
 * but can't set a property on a specific assignment (b) — the note lands
 * in the inbox to triage later.
 *
 * Honesty about (b): the deployed `PATCH /v1/cases/{id}` accepts ONLY a
 * `name` field (its DTO has `deny_unknown_fields`), so a PATCH carrying
 * `domain_extension` currently 422s — until the backend adds the field
 * (in progress). `setAssignmentProperty` handles that gracefully
 * (returns `persisted: false`, doesn't throw; see the long note on
 * {@link setAssignmentProperty}), and we surface that truthfully rather
 * than claim a save that didn't take. The address text_note (a) is the
 * durable record regardless.
 */

import { Ionicons } from '@react-native-vector-icons/ionicons/static';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
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
import { setAssignmentProperty } from '@/lib/api';
import { pickAssignment } from '@/lib/assignment-picker';
import {
  type CaptureMeta,
  getCurrentGeo,
  newCaptureId,
  writeTextNoteFile,
} from '@/lib/capture';
import { enqueue } from '@/lib/queue';
import { syncNow } from '@/lib/sync';

type Geo = NonNullable<CaptureMeta['geo']>;

/**
 * Build a one-line street address from an SDK 56 reverse-geocode hit.
 * Joins the parts that exist, in mailing order, skipping nulls so we
 * never emit "undefined" or dangling commas.
 */
function formatAddress(a: Location.LocationGeocodedAddress): string {
  const line1 = [a.streetNumber, a.street].filter(Boolean).join(' ').trim();
  const cityState = [a.city, a.region].filter(Boolean).join(', ').trim();
  const tail = [cityState, a.postalCode].filter(Boolean).join(' ').trim();
  return [line1 || a.name, tail].filter(Boolean).join(', ').trim();
}

export default function AddressCaptureScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<'locating' | 'ready' | 'denied'>('locating');
  const [address, setAddress] = useState('');
  const [geo, setGeo] = useState<Geo | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const locate = useCallback(async () => {
    setPhase('locating');
    try {
      // Shared one-shot geotag (consistent accuracy across all capture
      // screens). A denied permission resolves to `undefined` — drop into
      // the richer `denied` phase so the appraiser can still type one.
      const fix = await getCurrentGeo();
      if (!fix) {
        setPhase('denied');
        return;
      }
      setGeo(fix);

      // Reverse geocode is best-effort: a fix without a street match
      // (rural, offline geocoder) still lets the appraiser type one.
      try {
        const hits = await Location.reverseGeocodeAsync({
          latitude: fix.lat,
          longitude: fix.lon,
        });
        if (hits.length > 0) setAddress(formatAddress(hits[0]));
      } catch {
        // leave the field empty for manual entry
      }
      setPhase('ready');
    } catch (e) {
      Alert.alert('Location failed', (e as Error).message);
      setPhase('ready'); // let them type one anyway
    }
  }, []);

  useEffect(() => {
    void locate();
  }, [locate]);

  async function onConfirm() {
    if (busy) return;
    const addr = address.trim();
    if (!addr) {
      Alert.alert('No address', 'Type or correct the address before saving.');
      return;
    }
    setBusy(true);
    try {
      // Pick the assignment to set the property on. Skipping (inbox) is
      // allowed — we still save the note, just can't set a property.
      let assignmentId: string | null = null;
      try {
        assignmentId = await pickAssignment();
      } catch {
        assignmentId = null;
      }

      // (a) Durable text_note record of the subject address — same
      //     offline sync path as a photo / voice note.
      const id = newCaptureId();
      const localUri = writeTextNoteFile(id, `Subject address: ${addr}`);
      const meta: CaptureMeta = {
        id,
        kind: 'text_note',
        localUri,
        capturedAt: new Date().toISOString(),
        caption: `Subject address: ${addr}`,
        status: 'pending',
      };
      if (assignmentId) meta.assignmentId = assignmentId;
      if (geo) meta.geo = geo;
      await enqueue(meta);
      void syncNow();

      // (b) Set it as the assignment's subject property address, if one
      //     was picked. GET-merge-PATCH; verify it actually persisted.
      if (!assignmentId) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(
          'Saved to inbox',
          'The address note is saved. Pick an assignment next time to set it as the subject property address.',
          [{ text: 'Done', onPress: () => router.back() }],
        );
        return;
      }

      try {
        const result = await setAssignmentProperty(assignmentId, addr);
        if (result.persisted) {
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          );
          Alert.alert(
            'Subject address set',
            `“${addr}” is now the assignment's subject property.`,
            [{ text: 'Done', onPress: () => router.back() }],
          );
        } else {
          // The note is saved; the property field didn't take because the
          // server's PATCH doesn't accept domain_extension yet. Be honest.
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Warning,
          );
          Alert.alert(
            'Address noted',
            'The address is saved as a note on this assignment. Setting it as the subject property field on the website isn’t available from the app yet — set it there if you need the labelled field.',
            [{ text: 'OK', onPress: () => router.back() }],
          );
        }
      } catch (e) {
        // The text_note (a) is already saved + queued; the property set
        // (b) failed. Don't lose the note — report (b) only.
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert(
          'Address noted',
          `Saved the address as a note, but couldn’t set the subject property field: ${
            (e as Error).message
          }`,
          [{ text: 'OK', onPress: () => router.back() }],
        );
      }
    } catch (e) {
      Alert.alert('Save failed', (e as Error).message);
    } finally {
      // Always release the busy lock. The result Alerts above are
      // non-blocking (Alert.alert returns immediately), so clearing busy
      // here releases the Cancel button while the alert is up — a dismiss
      // can never strand the screen. The note is already enqueued, so
      // backing out loses nothing.
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.topBar}>
            {/* Never gated on `busy`: the user must always be able to
                back out. The note is enqueued before any result alert, so
                backing out during a save loses nothing. */}
            <Pressable
              style={[styles.closeButton, styles.closeRow]}
              onPress={() => router.back()}
            >
              <Ionicons name="arrow-back" size={15} color={Brand.navyDeep} />
              <Text style={styles.closeLabel}>Cancel</Text>
            </Pressable>
          </View>

          <Text style={styles.eyebrow}>ADDRESS LOOKUP</Text>
          <Text style={styles.title}>Subject property address</Text>
          <Text style={styles.lede}>
            We read your current location and look up the nearest street
            address. Reverse geocoding is approximate at the curb —
            confirm or correct it, then set it as the assignment&apos;s
            subject property.
          </Text>

          {phase === 'denied' ? (
            <View style={styles.deniedBox}>
              <Text style={styles.deniedTitle}>Location access needed</Text>
              <Text style={styles.deniedBody}>
                North Star uses your location to look up the subject
                property address. You can still type one in below.
              </Text>
              <Pressable
                style={styles.deniedButton}
                onPress={() => Linking.openSettings()}
              >
                <Text style={styles.deniedButtonLabel}>Open Settings</Text>
              </Pressable>
            </View>
          ) : null}

          <Text style={styles.label}>Address</Text>
          <View style={styles.addressRow}>
            <TextInput
              style={[styles.input, styles.addressInput]}
              value={address}
              onChangeText={setAddress}
              placeholder={
                phase === 'locating' ? 'Finding your location…' : 'Street, City, ST ZIP'
              }
              placeholderTextColor={Brand.inkFaint}
              editable={!busy && phase !== 'locating'}
              multiline
              textAlignVertical="top"
            />
          </View>

          {phase === 'locating' ? (
            <View style={styles.locatingRow}>
              <ActivityIndicator color={Brand.gold} />
              <Text style={styles.locatingLabel}>Locating…</Text>
            </View>
          ) : (
            <Pressable
              style={[styles.relocate, styles.relocateRow]}
              onPress={() => void locate()}
              disabled={busy}
            >
              <Ionicons name="locate" size={14} color={Brand.gold} />
              <Text style={styles.relocateLabel}>Use my current location</Text>
            </Pressable>
          )}

          {geo ? (
            <Text style={styles.coords}>
              {geo.lat.toFixed(5)}, {geo.lon.toFixed(5)}
              {geo.accuracyMeters
                ? ` · ±${Math.round(geo.accuracyMeters)}m`
                : ''}
            </Text>
          ) : null}

          <Pressable
            style={({ pressed }) => [
              styles.save,
              (busy || phase === 'locating') && styles.saveBusy,
              pressed && !busy && styles.savePressed,
            ]}
            onPress={onConfirm}
            disabled={busy || phase === 'locating'}
          >
            {busy ? (
              <ActivityIndicator color={Brand.cream} />
            ) : (
              <Text style={styles.saveLabel}>Confirm address</Text>
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
  deniedBox: {
    backgroundColor: Brand.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
    borderRadius: Radius.md,
    padding: Spacing.three,
    marginBottom: Spacing.four,
  },
  deniedTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Brand.navyDeep,
    marginBottom: Spacing.two,
  },
  deniedBody: {
    fontSize: 13,
    color: Brand.inkMuted,
    lineHeight: 20,
    marginBottom: Spacing.three,
  },
  deniedButton: {
    alignSelf: 'flex-start',
    backgroundColor: Brand.navyDeep,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: Radius.md,
  },
  deniedButtonLabel: { color: Brand.cream, fontSize: 14, fontWeight: '600' },
  label: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    color: Brand.inkMuted,
    marginBottom: Spacing.two,
    marginTop: Spacing.two,
  },
  addressRow: { flexDirection: 'row' },
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
  addressInput: { flex: 1, minHeight: 72 },
  locatingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  locatingLabel: { fontSize: 13, color: Brand.inkMuted },
  relocate: {
    alignSelf: 'flex-start',
    paddingVertical: Spacing.two,
    marginTop: Spacing.two,
  },
  relocateRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  relocateLabel: { fontSize: 14, color: Brand.gold, fontWeight: '600' },
  coords: {
    fontSize: 12,
    color: Brand.inkFaint,
    marginTop: Spacing.one,
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
