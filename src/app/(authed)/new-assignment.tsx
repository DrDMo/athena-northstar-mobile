/**
 * New assignment — create a PENDING draft from the phone.
 *
 * The website is still the system of record for paid, live assignments
 * (the $99 pay-to-activate charge runs through Stripe hosted Checkout on
 * the web). This screen only mints the unpaid *draft*: `POST /v1/cases`
 * inserts a `payment_status='pending'` case and charges nothing — the
 * charge is a separate `POST /v1/assignments/checkout` the user completes
 * on the web. Creating the draft here lets a field appraiser start an
 * assignment and immediately file captures to it, then pay later.
 *
 * Both inputs are optional and map to {@link createAssignment}'s
 * `{ domain?, jurisdiction? }`. Left blank, the API client defaults them
 * (domain `appraisal`, jurisdiction `US-WA`) so the common case is a
 * single tap.
 *
 * On success we `router.replace` to the new assignment's detail so the
 * user lands somewhere they can upload — and a back-swipe returns to the
 * list, not to this empty form.
 */

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
import { createAssignment } from '@/lib/api';

export default function NewAssignmentScreen() {
  const router = useRouter();
  const [domain, setDomain] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    if (busy) return;
    setBusy(true);
    try {
      const created = await createAssignment({
        // Trim + drop empties so the API client's defaults apply when a
        // field is left blank.
        domain: domain.trim() || undefined,
        jurisdiction: jurisdiction.trim() || undefined,
      });
      // Replace (not push) so back-swipe returns to the list, not this form.
      router.replace(`/assignments/${created.id}`);
    } catch (e) {
      Alert.alert('Couldn’t create assignment', (e as Error).message);
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
          <Text style={styles.eyebrow}>NEW ASSIGNMENT</Text>
          <Text style={styles.title}>Start a draft</Text>
          <Text style={styles.lede}>
            This creates an unpaid draft so you can start filing captures
            right away. It’s free to create — the $99 activation is paid
            later on the web app. The draft shows in your list marked
            “Pending payment” until then.
          </Text>

          <Text style={styles.label}>Domain</Text>
          <TextInput
            style={styles.input}
            value={domain}
            onChangeText={setDomain}
            placeholder="appraisal"
            placeholderTextColor={Brand.inkFaint}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />
          <Text style={styles.hint}>Leave blank to use “appraisal”.</Text>

          <Text style={styles.label}>Jurisdiction</Text>
          <TextInput
            style={styles.input}
            value={jurisdiction}
            onChangeText={setJurisdiction}
            placeholder="US-WA"
            placeholderTextColor={Brand.inkFaint}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!busy}
          />
          <Text style={styles.hint}>Leave blank to use “US-WA”.</Text>

          <Pressable
            style={({ pressed }) => [
              styles.submit,
              busy && styles.submitBusy,
              pressed && !busy && styles.submitPressed,
            ]}
            onPress={onSubmit}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={Brand.cream} />
            ) : (
              <Text style={styles.submitLabel}>Create draft</Text>
            )}
          </Pressable>

          <Pressable style={styles.cancel} onPress={() => router.back()} disabled={busy}>
            <Text style={styles.cancelLabel}>Cancel</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Brand.cream },
  scroll: { padding: Spacing.four },
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
    marginBottom: Spacing.five,
  },
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
  hint: {
    fontSize: 12,
    color: Brand.inkFaint,
    marginTop: Spacing.one,
  },
  submit: {
    backgroundColor: Brand.navyDeep,
    paddingVertical: Spacing.three,
    borderRadius: Radius.md,
    alignItems: 'center',
    marginTop: Spacing.five,
  },
  submitBusy: { opacity: 0.7 },
  submitPressed: { opacity: 0.85 },
  submitLabel: { color: Brand.cream, fontSize: 16, fontWeight: '700' },
  cancel: {
    alignItems: 'center',
    paddingVertical: Spacing.three,
    marginTop: Spacing.two,
  },
  cancelLabel: { color: Brand.inkMuted, fontSize: 14 },
});
