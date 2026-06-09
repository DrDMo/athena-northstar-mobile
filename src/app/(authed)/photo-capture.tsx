/**
 * Photo capture — the v0.1 "press the big button, get a geotagged
 * shot" surface. Takes a photo via expo-camera, asks Location for
 * the current fix, and stages a {@link CaptureMeta} record in
 * component state. Sync to workfile lands in m4.
 *
 * UX shape:
 *   - Fullscreen camera preview
 *   - Single round shutter button bottom-center
 *   - Top-left close button returns to the Capture tab
 *   - Top-right flips between back / front camera
 *   - After shutter fires: brief flash, then a thumbnail strip at
 *     the bottom showing all captures from this session
 *
 * Permissions:
 *   - Camera is requested on mount; if denied, we show a friendly
 *     "open Settings" affordance instead of the preview.
 *   - Location is requested lazily on first shot. If denied, photos
 *     still capture, just without the geotag — the appraiser can
 *     always add address metadata later.
 */

import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Brand, Radius, Spacing } from '@/constants/theme';
import { type CaptureMeta, newCaptureId } from '@/lib/capture';
import { enqueue } from '@/lib/queue';
import { syncNow } from '@/lib/sync';

type Facing = 'back' | 'front';

export default function PhotoCaptureScreen() {
  const router = useRouter();
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<Facing>('back');
  const [busy, setBusy] = useState(false);
  const [captures, setCaptures] = useState<CaptureMeta[]>([]);
  const [locationDenied, setLocationDenied] = useState(false);

  const onShutter = useCallback(async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        // EXIF must be preserved for the audit chain — the server
        // hashes the original bytes, and EXIF is part of that hash.
        exif: true,
        // Keep full-fidelity; no compression here. The server
        // re-encodes for display on smaller bandwidth profiles.
        quality: 1.0,
        skipProcessing: false,
      });

      if (!photo?.uri) return;

      const meta: CaptureMeta = {
        id: newCaptureId(),
        kind: 'photo',
        localUri: photo.uri,
        capturedAt: new Date().toISOString(),
        exif: photo.exif as Record<string, unknown> | undefined,
        status: 'pending',
      };

      // Best-effort geotag. The capture itself is the source of
      // truth — losing the geo doesn't fail the shot.
      try {
        const loc = await getLocationOnce();
        if (loc) {
          meta.geo = loc;
        }
      } catch (e) {
        // swallow; locationDenied flag will surface the UI hint
      }

      setCaptures((prev) => [meta, ...prev]);

      // Persist to the queue + kick a sync attempt in the background.
      // Fire-and-forget; syncNow is idempotent and offline-tolerant.
      enqueue(meta).then(() => {
        void syncNow();
      });
    } catch (e) {
      Alert.alert('Capture failed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const flipCamera = useCallback(() => {
    setFacing((f) => (f === 'back' ? 'front' : 'back'));
  }, []);

  const close = useCallback(() => {
    router.back();
  }, [router]);

  // Permission-gate: ask once, then either show preview or the deny-state UI.
  if (!permission) {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.center}>
          <ActivityIndicator color={Brand.gold} />
        </View>
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.flex}>
        <View style={styles.center}>
          <Text style={styles.permTitle}>Camera access needed</Text>
          <Text style={styles.permBody}>
            North Star uses the camera to capture geotagged property
            photos. Photos stay on this device until you sync them to
            a workfile.
          </Text>
          {permission.canAskAgain ? (
            <Pressable style={styles.permButton} onPress={requestPermission}>
              <Text style={styles.permButtonLabel}>Allow camera</Text>
            </Pressable>
          ) : (
            <Pressable
              style={styles.permButton}
              onPress={() => Linking.openSettings()}
            >
              <Text style={styles.permButtonLabel}>Open Settings</Text>
            </Pressable>
          )}
          <Pressable style={styles.permLater} onPress={() => router.back()}>
            <Text style={styles.permLaterLabel}>Not now</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.previewWrap}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
      />

      <SafeAreaView style={styles.overlay} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <Pressable style={styles.iconButton} onPress={close} hitSlop={12}>
            <Text style={styles.iconButtonLabel}>✕</Text>
          </Pressable>
          <Pressable style={styles.iconButton} onPress={flipCamera} hitSlop={12}>
            <Text style={styles.iconButtonLabel}>⤾</Text>
          </Pressable>
        </View>

        {locationDenied ? (
          <View style={styles.geoHint}>
            <Text style={styles.geoHintLabel}>
              No location — photos won&apos;t be geotagged
            </Text>
          </View>
        ) : null}

        {captures.length > 0 ? (
          <FlatList
            horizontal
            data={captures}
            keyExtractor={(c) => c.id}
            contentContainerStyle={styles.thumbStrip}
            showsHorizontalScrollIndicator={false}
            renderItem={({ item }) => (
              <View style={styles.thumb}>
                <Image source={{ uri: item.localUri }} style={styles.thumbImg} />
                {item.geo ? (
                  <View style={styles.thumbGeoBadge}>
                    <Text style={styles.thumbGeoLabel}>GPS</Text>
                  </View>
                ) : null}
              </View>
            )}
          />
        ) : null}

        <View style={styles.shutterRow}>
          <View style={styles.shutterSide}>
            <Text style={styles.counter}>
              {captures.length === 0 ? '' : `${captures.length} taken`}
            </Text>
          </View>
          <Pressable
            style={[styles.shutter, busy && styles.shutterBusy]}
            onPress={onShutter}
            disabled={busy}
          >
            <View style={styles.shutterInner} />
          </Pressable>
          <View style={styles.shutterSide} />
        </View>
      </SafeAreaView>
    </View>
  );

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function getLocationOnce(): Promise<CaptureMeta['geo']> {
    const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      if (!canAskAgain) setLocationDenied(true);
      return undefined;
    }
    setLocationDenied(false);
    const pos = await Location.getCurrentPositionAsync({
      accuracy:
        Platform.OS === 'ios'
          ? Location.Accuracy.Highest
          : Location.Accuracy.High,
    });
    return {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracyMeters: pos.coords.accuracy ?? undefined,
      altitude: pos.coords.altitude ?? undefined,
    };
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Brand.cream },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.five,
  },
  previewWrap: { flex: 1, backgroundColor: '#000' },
  overlay: {
    flex: 1,
    justifyContent: 'space-between',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: Spacing.four,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonLabel: { color: '#fff', fontSize: 22, fontWeight: '600' },
  geoHint: {
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(138, 90, 0, 0.85)',
  },
  geoHintLabel: { color: '#fff', fontSize: 12, fontWeight: '600' },
  thumbStrip: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  thumb: {
    width: 68,
    height: 68,
    borderRadius: Radius.sm,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
    overflow: 'hidden',
    backgroundColor: '#222',
  },
  thumbImg: { width: '100%', height: '100%' },
  thumbGeoBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: 'rgba(31, 107, 58, 0.92)',
  },
  thumbGeoLabel: { color: '#fff', fontSize: 8, fontWeight: '700' },
  shutterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: Spacing.four,
  },
  shutterSide: { width: 80, alignItems: 'center' },
  counter: { color: '#fff', fontSize: 12, fontWeight: '600' },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterBusy: { opacity: 0.5 },
  shutterInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#fff',
  },
  permTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Brand.navyDeep,
    textAlign: 'center',
    marginBottom: Spacing.three,
  },
  permBody: {
    fontSize: 14,
    color: Brand.inkMuted,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: Spacing.five,
  },
  permButton: {
    backgroundColor: Brand.navyDeep,
    paddingHorizontal: Spacing.five,
    paddingVertical: Spacing.three,
    borderRadius: Radius.md,
    marginBottom: Spacing.three,
  },
  permButtonLabel: { color: Brand.cream, fontSize: 15, fontWeight: '600' },
  permLater: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  permLaterLabel: { color: Brand.inkMuted, fontSize: 13 },
});
