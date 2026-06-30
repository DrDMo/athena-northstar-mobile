/**
 * Login screen. POSTs to /v1/auth/sessions; on success the API
 * client persists the session cookie via expo-secure-store and
 * the root layout's auth-gate routes us into the (authed) group.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
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
import Constants from 'expo-constants';

import { Brand, Fonts, Radius, Spacing } from '@/constants/theme';
import { login } from '@/lib/api';
import { setAuth } from '@/lib/auth-store';

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit() {
    if (!email.trim() || !password) {
      Alert.alert(
        'Missing fields',
        'Enter the email and password from your North Star tenant.',
      );
      return;
    }
    setSubmitting(true);
    try {
      // #514: publish the user to the shared store BEFORE navigating, so the
      // root auth-gate sees the signed-in user and doesn't bounce us back.
      const me = await login({ email: email.trim(), password });
      setAuth(me);
      router.replace('/');
    } catch (e) {
      Alert.alert('Sign in failed', (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brandBlock}>
          <Text style={styles.eyebrow}>ATHENA SYSTEMS</Text>
          <Text style={styles.wordmark}>North Star</Text>
          <Text style={styles.descriptor}>Appraisal · Field</Text>
          <View style={styles.goldRule} />
          <Text style={styles.tagline}>Trusted Decision Infrastructure</Text>
          <View style={styles.buildBadge}>
            <Text style={styles.buildBadgeText}>
              BUILD {Constants.nativeAppVersion ??
                Constants.expoConfig?.version ??
                '?'}{' · '}
              {String(Constants.nativeBuildVersion ?? '?')}
            </Text>
          </View>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Work email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@firm.example"
            placeholderTextColor={Brand.inkFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            editable={!submitting}
          />

          <Text style={[styles.label, { marginTop: Spacing.four }]}>
            Password
          </Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="your tenant password"
            placeholderTextColor={Brand.inkFaint}
            secureTextEntry
            textContentType="password"
            editable={!submitting}
          />

          <Pressable
            style={({ pressed }) => [
              styles.button,
              (submitting || pressed) && styles.buttonPressed,
            ]}
            onPress={onSubmit}
            disabled={submitting}
          >
            <Text style={styles.buttonLabel}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </Text>
          </Pressable>

          <Text style={styles.fine}>
            New here? Sign up at athenadecisionsystems.com — the mobile
            app uses the same account as the web product.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Brand.cream },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: Spacing.five,
  },
  brandBlock: {
    alignItems: 'center',
    marginBottom: Spacing.six,
  },
  eyebrow: {
    fontSize: 11,
    letterSpacing: 3,
    fontWeight: '700',
    color: Brand.inkMuted,
  },
  wordmark: {
    fontSize: 48,
    color: Brand.navyDeep,
    fontFamily: Fonts?.serif,
    marginTop: Spacing.two,
    letterSpacing: -0.5,
  },
  descriptor: {
    fontSize: 18,
    color: Brand.gold,
    fontFamily: Fonts?.serif,
    letterSpacing: 0.5,
    marginTop: 2,
  },
  goldRule: {
    width: 80,
    height: 1.5,
    backgroundColor: Brand.gold,
    marginTop: Spacing.four,
  },
  tagline: {
    fontSize: 13,
    color: Brand.inkMuted,
    marginTop: Spacing.three,
    letterSpacing: 0.5,
  },
  // A deliberately loud build stamp so it's obvious at a glance which build
  // is actually installed (reads the NATIVE binary's version, not app.json).
  buildBadge: {
    marginTop: Spacing.three,
    backgroundColor: Brand.gold,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Radius.sm,
  },
  buildBadgeText: {
    color: Brand.navyDeep,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
  },
  form: {
    backgroundColor: Brand.surface,
    borderRadius: Radius.md,
    padding: Spacing.five,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.5,
    color: Brand.inkMuted,
    marginBottom: Spacing.two,
  },
  input: {
    borderBottomWidth: 1,
    borderColor: Brand.border,
    paddingVertical: Spacing.three,
    fontSize: 16,
    color: Brand.ink,
  },
  button: {
    marginTop: Spacing.five,
    backgroundColor: Brand.navyDeep,
    paddingVertical: Spacing.four,
    borderRadius: Radius.sm,
    alignItems: 'center',
  },
  buttonPressed: { opacity: 0.7 },
  buttonLabel: {
    color: Brand.cream,
    fontWeight: '600',
    fontSize: 15,
    letterSpacing: 0.5,
  },
  fine: {
    marginTop: Spacing.four,
    fontSize: 12,
    color: Brand.inkMuted,
    textAlign: 'center',
    lineHeight: 18,
  },
});
