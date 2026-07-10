/**
 * Login screen. POSTs to /v1/auth/sessions; on success the API
 * client persists the session cookie via expo-secure-store and
 * the root layout's auth-gate routes us into the (authed) group.
 *
 * #593: accounts with two-factor turned on get `mfa_required` and no
 * session token. The screen swaps to a code entry that exchanges the
 * challenge for a real session. Before this, `login()` was typed as
 * returning a user, so the app called `setAuth()` on the challenge body,
 * appeared signed in, and then 401'd on every request.
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

import { Brand, Fonts, Radius, Spacing } from '@/constants/theme';
import { login, verifyMfa } from '@/lib/api';
import { setAuth } from '@/lib/auth-store';

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /** Non-null once the server asks for a second factor (#593). */
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');

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
      const result = await login({ email: email.trim(), password });
      if (result.kind === 'mfa_required') {
        // The password has done its job. Drop it before the code screen
        // renders, so nothing there can leak the secret.
        setPassword('');
        setMfaChallenge(result.mfaChallengeToken);
        return;
      }
      // #514: publish the user to the shared store BEFORE navigating, so the
      // root auth-gate sees the signed-in user and doesn't bounce us back.
      setAuth(result.me);
      router.replace('/');
    } catch (e) {
      Alert.alert('Sign in failed', (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmitCode() {
    if (!mfaChallenge) return;
    const trimmed = code.trim();
    if (trimmed.length < 6) {
      Alert.alert(
        'Enter your code',
        'Type the 6-digit code from your authenticator app, or one of your backup codes.',
      );
      return;
    }
    setSubmitting(true);
    try {
      const me = await verifyMfa({
        mfaChallengeToken: mfaChallenge,
        code: trimmed,
      });
      setAuth(me);
      router.replace('/');
    } catch (e) {
      Alert.alert('That code did not work', (e as Error).message);
      setCode('');
    } finally {
      setSubmitting(false);
    }
  }

  /** Abandon the challenge and start over from the password. */
  function backToPassword() {
    setMfaChallenge(null);
    setCode('');
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
        </View>

        {mfaChallenge ? (
          <View style={styles.form}>
            <Text style={styles.label}>Authentication code</Text>
            <Text style={styles.stepHint}>
              Enter the 6-digit code from your authenticator app. You can
              also use one of your backup codes.
            </Text>
            <TextInput
              // A fresh field, never the password input reused: React
              // recycling that node is how the web app briefly showed a
              // password in clear text (#590).
              key="mfa-code"
              style={styles.input}
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              placeholderTextColor={Brand.inkFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              autoFocus
              editable={!submitting}
            />

            <Pressable
              style={({ pressed }) => [
                styles.button,
                (submitting || pressed) && styles.buttonPressed,
              ]}
              onPress={onSubmitCode}
              disabled={submitting}
            >
              <Text style={styles.buttonLabel}>
                {submitting ? 'Verifying…' : 'Verify'}
              </Text>
            </Pressable>

            <Pressable onPress={backToPassword} disabled={submitting}>
              <Text style={[styles.fine, styles.linkish]}>
                ← Back to sign in
              </Text>
            </Pressable>
          </View>
        ) : (
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
            key="password"
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
        )}
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
  stepHint: {
    fontSize: 13,
    color: Brand.inkMuted,
    lineHeight: 19,
    marginBottom: Spacing.three,
  },
  linkish: {
    color: Brand.navyDeep,
    textDecorationLine: 'underline',
  },
});
