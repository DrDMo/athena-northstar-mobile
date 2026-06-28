/**
 * #514: shared auth store.
 *
 * The root auth-gate (`app/_layout.tsx`) and the login / settings screens
 * must agree on the current user. The gate used to hold `me` in local
 * state set ONLY at cold start, so a fresh login — which saves a session
 * token but had no way to reach back into the gate's state — left the gate
 * still believing `me` was null. The gate then bounced the just-logged-in
 * user straight back to /login (and, symmetrically, sign-out left a stale
 * `me` that bounced the user back INTO the app). The bug was invisible in
 * Expo Go because fast-refresh re-runs the cold-start effect; it only bit
 * the production APK.
 *
 * This module is the single source of truth both the gate and the screens
 * read and write, via `useSyncExternalStore`.
 */
import { useSyncExternalStore } from 'react';
import type { AuthMe } from './api';

export type AuthState = {
  /** The signed-in user, or null when signed out. */
  me: AuthMe | null;
  /** True once the first auth decision (cold-start check) has resolved. */
  ready: boolean;
};

let state: AuthState = { me: null, ready: false };
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Set the signed-in user (or null) and mark auth resolved. */
export function setAuth(me: AuthMe | null): void {
  state = { me, ready: true };
  emit();
}

/** Clear the user on sign-out (keeps `ready` true). */
export function clearAuth(): void {
  state = { me: null, ready: true };
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): AuthState {
  return state;
}

/** Subscribe a component to the shared auth state. */
export function useAuth(): AuthState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
