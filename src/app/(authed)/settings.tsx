/**
 * Settings tab. Account info + sign-out for now. Future:
 * tenant switcher (for users on multiple tenants), default
 * jurisdiction picker, capture defaults (geotag on/off,
 * audio quality), about/legal.
 */

import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Constants from 'expo-constants';

import { Brand, Radius, Spacing } from '@/constants/theme';
import { fetchMe, logout, type AuthMe } from '@/lib/api';
import type { CaptureMeta } from '@/lib/capture';
import { loadQueue } from '@/lib/queue';
import { syncNow } from '@/lib/sync';

export default function SettingsScreen() {
  const router = useRouter();
  const [me, setMe] = useState<AuthMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [queue, setQueue] = useState<CaptureMeta[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const [got, q] = await Promise.all([fetchMe(), loadQueue()]);
          if (cancelled) return;
          setMe(got);
          setQueue(q);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const onSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await syncNow();
      const fresh = await loadQueue();
      setQueue(fresh);
      setLastSync(
        result.attempted === 0
          ? 'No items to sync'
          : `${result.succeeded} synced · ${result.failed} failed`,
      );
    } finally {
      setSyncing(false);
    }
  }, []);

  const pendingCount = queue.filter(
    (c) => c.status === 'pending' || c.status === 'failed',
  ).length;
  const syncedCount = queue.filter((c) => c.status === 'synced').length;

  function onSignOut() {
    Alert.alert(
      'Sign out',
      'Sign out of this device? Your captured-but-not-synced files stay on the device until you sign back in.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/login');
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.center}>
          <ActivityIndicator color={Brand.gold} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.flex}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.eyebrow}>ACCOUNT</Text>
        <View style={styles.card}>
          <Row label="Email" value={me?.email ?? '—'} />
          <Row label="Tenant" value={me?.tenant_slug ?? '—'} />
          <Row label="Role" value={me?.role ?? '—'} />
          {me?.display_name ? (
            <Row label="Display name" value={me.display_name} />
          ) : null}
        </View>

        <Text style={styles.eyebrow}>CAPTURE QUEUE</Text>
        <View style={styles.card}>
          <Row label="Pending upload" value={String(pendingCount)} />
          <Row label="Synced" value={String(syncedCount)} />
          {lastSync ? <Row label="Last attempt" value={lastSync} /> : null}
          <Pressable
            style={[styles.syncButton, syncing && styles.syncButtonBusy]}
            onPress={onSyncNow}
            disabled={syncing}
          >
            {syncing ? (
              <ActivityIndicator color={Brand.cream} />
            ) : (
              <Text style={styles.syncButtonLabel}>Sync now</Text>
            )}
          </Pressable>
        </View>

        <Pressable style={styles.signOut} onPress={onSignOut}>
          <Text style={styles.signOutLabel}>Sign out</Text>
        </Pressable>

        <View style={styles.aboutBlock}>
          <Text style={styles.aboutTitle}>About</Text>
          <Text style={styles.aboutBody}>
            North Star Appraisal, v{Constants.expoConfig?.version ?? '0.1.0'}
            {'\n'}
            Athena Systems · athenadecisionsystems.com
            {'\n'}
            Web app: appraisal.athenanorthstar.com
            {'\n'}
            Verifier: verify.athenanorthstar.com
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Brand.cream },
  scroll: { padding: Spacing.four, gap: Spacing.four },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: {
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: '700',
    color: Brand.gold,
  },
  card: {
    backgroundColor: Brand.surface,
    padding: Spacing.four,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowLabel: { color: Brand.inkMuted, fontSize: 13 },
  rowValue: { color: Brand.ink, fontSize: 13, fontFamily: 'monospace' },
  signOut: {
    marginTop: Spacing.three,
    backgroundColor: Brand.surface,
    paddingVertical: Spacing.four,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.red,
    alignItems: 'center',
  },
  signOutLabel: { color: Brand.red, fontWeight: '600' },
  syncButton: {
    marginTop: Spacing.three,
    backgroundColor: Brand.navyDeep,
    paddingVertical: Spacing.three,
    borderRadius: Radius.sm,
    alignItems: 'center',
  },
  syncButtonBusy: { opacity: 0.6 },
  syncButtonLabel: { color: Brand.cream, fontWeight: '600' },
  aboutBlock: {
    marginTop: Spacing.five,
  },
  aboutTitle: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: Brand.inkMuted,
    marginBottom: Spacing.two,
  },
  aboutBody: {
    fontSize: 12,
    color: Brand.inkFaint,
    lineHeight: 20,
    fontFamily: 'monospace',
  },
});
