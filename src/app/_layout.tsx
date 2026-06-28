/**
 * Root layout — owns the auth gate.
 *
 * On every cold start we look for a stored session and call
 * /v1/auth/me. If the session is missing/expired we redirect to
 * /login; otherwise we render the (authed) stack.
 *
 * Splash stays up until we've made the first auth decision so the
 * user never sees a flash of the login screen if they're already
 * signed in.
 */

import {
  DarkTheme,
  DefaultTheme,
  Stack,
  ThemeProvider,
  useRouter,
  useSegments,
} from 'expo-router';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import {
  PlayfairDisplay_400Regular,
  PlayfairDisplay_500Medium,
  PlayfairDisplay_600SemiBold,
  PlayfairDisplay_700Bold,
  useFonts,
} from '@expo-google-fonts/playfair-display';

import { fetchMe } from '@/lib/api';
import { setAuth, useAuth } from '@/lib/auth-store';
import { startAutoSyncOnReconnect, syncNow } from '@/lib/sync';
import { Brand } from '@/constants/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const segments = useSegments();
  // #514: `me`/`ready` come from the shared auth store, not local state, so
  // a fresh login (or sign-out) updates the gate too — otherwise the gate
  // keeps its cold-start value and bounces the user.
  const { me, ready } = useAuth();

  // Load Playfair Display once at the root. Splash stays up until both
  // fonts AND auth have resolved; otherwise the wordmark would
  // re-render at first paint (visible "font swap" flash).
  const [fontsLoaded] = useFonts({
    PlayfairDisplay_400Regular,
    PlayfairDisplay_500Medium,
    PlayfairDisplay_600SemiBold,
    PlayfairDisplay_700Bold,
  });

  // First-mount auth check. We deliberately swallow errors here —
  // a transient network failure on cold start shouldn't lock the
  // user out; we just route them to login and let the explicit
  // login flow surface a real error.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const got = await fetchMe();
        if (!cancelled) setAuth(got);
      } catch {
        if (!cancelled) setAuth(null);
      } finally {
        // setAuth() already marks the store ready; just drop the splash.
        if (!cancelled) {
          SplashScreen.hideAsync().catch(() => {});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // After auth resolves, register a network listener that auto-syncs
  // the capture queue whenever the device transitions offline → online.
  // Also kicks one sync attempt on mount in case captures are queued
  // from a previous session.
  useEffect(() => {
    if (!ready || !me) return;
    void syncNow();
    const unsubscribe = startAutoSyncOnReconnect();
    return unsubscribe;
  }, [ready, me]);

  // Once we know who the user is, redirect appropriately. We use
  // `segments[0]` to decide whether the current route is in the
  // authed group or the public login screen.
  useEffect(() => {
    if (!ready) return;
    const inAuthGroup = segments[0] === '(authed)';
    if (!me && inAuthGroup) {
      router.replace('/login');
    } else if (me && !inAuthGroup) {
      router.replace('/');
    }
  }, [ready, me, segments, router]);

  if (!ready || !fontsLoaded) return null;

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: Brand.cream },
          headerTintColor: Brand.navyDeep,
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: Brand.cream },
        }}
      >
        <Stack.Screen name="(authed)" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack>
    </ThemeProvider>
  );
}
