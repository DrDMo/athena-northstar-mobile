/**
 * Authed-group tab layout. Three primary destinations:
 *
 *   Assignments  — list of cases this appraiser is working on
 *   Capture       — quick action surface: take a photo, voice note,
 *                  start a workfile, etc. Designed for the
 *                  one-handed in-the-field workflow.
 *   Settings     — account info + sign out
 *
 * Sits inside the (authed) folder so the root layout's auth gate
 * runs first. If we land here without a session, the gate
 * redirects to /login before this layout mounts.
 */

import { Tabs } from 'expo-router';
import { Brand } from '@/constants/theme';

export default function AuthedLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Brand.gold,
        tabBarInactiveTintColor: Brand.inkMuted,
        tabBarStyle: {
          backgroundColor: Brand.cream,
          borderTopColor: Brand.border,
        },
        headerStyle: { backgroundColor: Brand.cream },
        headerTintColor: Brand.navyDeep,
        headerTitleStyle: { fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Assignments',
          tabBarLabel: 'Assignments',
        }}
      />
      <Tabs.Screen
        name="capture"
        options={{
          title: 'Capture',
          tabBarLabel: 'Capture',
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: 'Inbox',
          tabBarLabel: 'Inbox',
        }}
      />
      <Tabs.Screen
        name="reference"
        options={{
          title: 'Reference',
          tabBarLabel: 'Reference',
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarLabel: 'Settings',
        }}
      />
      {/* Hidden from the tab bar — routed to from Capture tiles. */}
      <Tabs.Screen
        name="photo-capture"
        options={{
          href: null,
          headerShown: false,
        }}
      />
      <Tabs.Screen
        name="voice-capture"
        options={{
          href: null,
          headerShown: false,
        }}
      />
      <Tabs.Screen
        name="assignments/[id]"
        options={{
          href: null,
          title: 'Assignment',
        }}
      />
    </Tabs>
  );
}
