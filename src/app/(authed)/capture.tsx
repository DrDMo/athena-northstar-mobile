/**
 * Capture entry point — the big-buttoned in-the-field surface.
 *
 * Photo and Voice note are live: each writes a real file, queues it to
 * the on-device store (AsyncStorage), and syncs to the backend when
 * signal returns. The queue survives app restarts, so nothing is lost
 * in a dead zone. The remaining tiles are still placeholders:
 *
 *   - Photo: expo-camera, EXIF + GPS preserved          (LIVE)
 *   - Voice note: expo-audio, .m4a recordings           (LIVE)
 *   - Sketch: react-native-svg + gesture-handler canvas, exported to
 *     PNG via react-native-view-shot                    (LIVE)
 *   - Address lookup: expo-location reverse-geocode → sets the
 *     assignment's subject property address             (LIVE)
 *   - Scan barcode (MLS sticker on listing flyer): expo-camera scanner (LIVE)
 *   - Text note: tag a typed note to a workfile         (LIVE)
 *
 * One-handed UX is the design constraint here — most field
 * appraisers are holding a tape measure or clipboard in the other
 * hand. Big tap targets, voice-first where possible.
 */

import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Brand, Radius, Spacing } from '@/constants/theme';
import type { CaptureMeta } from '@/lib/capture';
import { loadQueue } from '@/lib/queue';
import { getLastSyncStatus, syncNow, type SyncStatus } from '@/lib/sync';

type Tile = {
  key: string;
  title: string;
  sub: string;
  href?:
    | '/photo-capture'
    | '/voice-capture'
    | '/text-note'
    | '/mls-scan'
    | '/sketch-capture'
    | '/address-capture';
  disabled?: boolean;
};

const TILES: Tile[] = [
  { key: 'photo', title: 'Photo', sub: 'with EXIF + GPS', href: '/photo-capture' },
  { key: 'voice', title: 'Voice note', sub: '.m4a recording', href: '/voice-capture' },
  { key: 'sketch', title: 'Sketch', sub: 'finger or stylus', href: '/sketch-capture' },
  { key: 'address', title: 'Address', sub: 'lookup + reverse geocode', href: '/address-capture' },
  { key: 'mls', title: 'MLS scan', sub: 'barcode → comp', href: '/mls-scan' },
  { key: 'note', title: 'Text note', sub: 'tag to a workfile', href: '/text-note' },
];

export default function CaptureScreen() {
  const router = useRouter();

  // #543: the Capture Queue lives here on the Capture tab (moved out of
  // Settings) — this is where captures happen, so the pending/synced counts
  // and the manual "Sync now" belong front-and-center. Also surfaces the last
  // sync outcome + any error, so an upload failure is visible without logs.
  const [sync, setSync] = useState<SyncStatus>(getLastSyncStatus());
  const [syncing, setSyncing] = useState(false);
  const [queue, setQueue] = useState<CaptureMeta[]>([]);

  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      await syncNow();
    } finally {
      setSync(getLastSyncStatus());
      setQueue(await loadQueue());
      setSyncing(false);
    }
  }, []);

  // Refresh counts and kick a sync each time the tab regains focus: a new
  // capture may have been added since we were last here, and returning with
  // signal should push anything still pending. syncNow guards re-entry.
  useFocusEffect(
    useCallback(() => {
      void runSync();
    }, [runSync]),
  );

  const pendingCount = queue.filter(
    (c) => c.status === 'pending' || c.status === 'failed',
  ).length;
  const syncedCount = queue.filter((c) => c.status === 'synced').length;

  return (
    <SafeAreaView style={styles.flex}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.eyebrow}>FIELD CAPTURE</Text>
        <Text style={styles.title}>Quick actions</Text>
        <Text style={styles.lede}>
          Captures stay on this device until you sync them to a
          workfile. Geotag + timestamp travel with the file so the
          audit chain can witness when + where each piece of
          evidence was taken.
        </Text>

        <Text style={styles.queueEyebrow}>CAPTURE QUEUE</Text>
        <View style={styles.queueCard}>
          <View style={styles.queueRow}>
            <Text style={styles.queueLabel}>Waiting to upload</Text>
            <Text style={styles.queueValue}>{pendingCount}</Text>
          </View>
          <View style={styles.queueRow}>
            <Text style={styles.queueLabel}>Synced</Text>
            <Text style={styles.queueValue}>{syncedCount}</Text>
          </View>
          {sync.ranAt ? (
            <View style={styles.queueRow}>
              <Text style={styles.queueLabel}>Last sync</Text>
              <Text style={styles.queueValue}>
                {sync.succeeded} sent · {sync.failed} failed
              </Text>
            </View>
          ) : null}
          {sync.lastError ? (
            <Text style={styles.queueError}>{sync.lastError}</Text>
          ) : null}
          <Pressable
            style={({ pressed }) => [
              styles.syncBtn,
              (syncing || pressed) && styles.syncBtnPressed,
            ]}
            onPress={runSync}
            disabled={syncing}
          >
            <Text style={styles.syncBtnText}>
              {syncing ? 'Syncing…' : 'Sync now'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.grid}>
          {TILES.map((t) => (
            <Pressable
              key={t.key}
              style={({ pressed }) => [
                styles.tile,
                t.disabled && styles.tileDisabled,
                pressed && !t.disabled && styles.tilePressed,
              ]}
              disabled={t.disabled}
              onPress={() => {
                if (t.href === '/sketch-capture') {
                  // #711 part 2c: every route into the sketch editor
                  // stamps a fresh `entry`, and the editor's session
                  // effect re-keys on it — the tile always opens a BLANK
                  // sketch, never another assignment's leftover canvas
                  // (the screen stays mounted in the tab navigator, so
                  // without this the last drawing would still be there).
                  router.push({
                    pathname: '/sketch-capture',
                    params: { entry: String(Date.now()) },
                  });
                } else if (t.href) {
                  router.push(t.href);
                }
              }}
            >
              <Text style={styles.tileTitle}>{t.title}</Text>
              <Text style={styles.tileSub}>{t.sub}</Text>
              {t.disabled ? <Text style={styles.tileSoon}>SOON</Text> : null}
            </Pressable>
          ))}
        </View>

        <Text style={styles.fine}>
          Every quick action is live. Each capture is saved on this
          device and waits in a queue that survives closing the app, then
          syncs to your workfile when you have signal. Address lookup also
          sets the subject property on the assignment you pick.
        </Text>
      </ScrollView>
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
  queueEyebrow: {
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: '700',
    color: Brand.gold,
    marginBottom: Spacing.two,
  },
  queueCard: {
    backgroundColor: Brand.surface,
    padding: Spacing.four,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
    gap: Spacing.two,
    marginBottom: Spacing.five,
  },
  queueRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  queueLabel: { color: Brand.inkMuted, fontSize: 13 },
  queueValue: { color: Brand.ink, fontSize: 13, fontWeight: '600' },
  queueError: {
    color: Brand.red,
    fontSize: 12,
    lineHeight: 18,
  },
  syncBtn: {
    marginTop: Spacing.two,
    backgroundColor: Brand.navyDeep,
    paddingVertical: Spacing.three,
    borderRadius: Radius.sm,
    alignItems: 'center',
  },
  syncBtnPressed: { opacity: 0.7 },
  syncBtnText: {
    color: Brand.cream,
    fontWeight: '700',
    fontSize: 13,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three,
  },
  tile: {
    width: '48%',
    aspectRatio: 1,
    backgroundColor: Brand.surface,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
    padding: Spacing.four,
    justifyContent: 'flex-end',
  },
  tileDisabled: { opacity: 0.6 },
  tilePressed: { opacity: 0.8 },
  tileTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Brand.navyDeep,
  },
  tileSub: {
    fontSize: 12,
    color: Brand.inkMuted,
    marginTop: Spacing.one,
  },
  tileSoon: {
    position: 'absolute',
    top: Spacing.three,
    right: Spacing.three,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: Brand.gold,
    backgroundColor: Brand.cream,
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderRadius: Radius.sm,
    overflow: 'hidden',
  },
  fine: {
    fontSize: 12,
    color: Brand.inkMuted,
    lineHeight: 18,
    marginTop: Spacing.five,
    textAlign: 'center',
  },
});
