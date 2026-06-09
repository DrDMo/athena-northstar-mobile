/**
 * Session storage — wraps `expo-secure-store` so the rest of the
 * app talks to a typed get/set/clear pair and never the raw key.
 *
 * The session token here is the value of the `session=…` cookie
 * the backend issues at POST /v1/auth/sessions. The mobile client
 * stores it in the iOS keychain (or Android keystore) and attaches
 * it as a `Cookie: session=<token>` header on every API call.
 *
 * Why not use the platform's HTTP cookie jar?
 *   React Native's `fetch` doesn't reliably persist cookies across
 *   app cold-starts on every platform/engine combination. Storing
 *   the token ourselves and sending it explicitly is one fewer
 *   thing that can break.
 */

import * as SecureStore from 'expo-secure-store';

const KEY = 'northstar.session';

export async function loadSession(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY);
}

export async function saveSession(token: string): Promise<void> {
  await SecureStore.setItemAsync(KEY, token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
