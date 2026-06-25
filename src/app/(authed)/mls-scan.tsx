/**
 * MLS barcode scan — point the camera at the barcode on a listing
 * flyer / MLS sticker, and capture the scanned value as a note.
 *
 * Uses expo-camera's BUILT-IN barcode scanning (`CameraView` +
 * `onBarcodeScanned` + `barcodeScannerSettings`, per the SDK 56 docs)
 * — no extra scanner library. expo-camera is already a dependency.
 *
 * On a scan we capture the value as a `text_note` (kind reuse — the
 * barcode payload is just text) with a `MLS/comp: <value>` caption,
 * routed through the same temp-`.txt` upload path as a typed note
 * (the backend requires a non-empty `file` part; see
 * {@link writeTextNoteFile}). The appraiser can file it to an
 * assignment at scan time or leave it in the inbox.
 */

import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Brand, Radius, Spacing } from '@/constants/theme';
import {
  type CaptureMeta,
  getCurrentGeo,
  newCaptureId,
  writeTextNoteFile,
} from '@/lib/capture';
import { pickAssignment } from '@/lib/assignment-picker';
import { enqueue } from '@/lib/queue';
import { syncNow } from '@/lib/sync';

export default function MlsScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [locationDenied, setLocationDenied] = useState(false);
  // Lock so a barcode held in frame fires onBarcodeScanned once, not
  // every camera frame.
  const handled = useRef(false);

  const onBarcodeScanned = useCallback(
    async ({ data }: { data: string }) => {
      if (handled.current || busy) return;
      const value = data?.trim();
      if (!value) return;
      handled.current = true;
      setBusy(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      try {
        // File to an assignment now, or keep in the inbox. Not fatal if
        // the picker can't load (offline) — fall back to inbox.
        let assignmentId: string | null = null;
        try {
          assignmentId = await pickAssignment();
        } catch {
          assignmentId = null;
        }

        const id = newCaptureId();
        // The scanned value is the note body; reuse the text_note path.
        const localUri = writeTextNoteFile(id, value);

        const meta: CaptureMeta = {
          id,
          kind: 'text_note',
          localUri,
          capturedAt: new Date().toISOString(),
          caption: `MLS/comp: ${value}`,
          status: 'pending',
        };
        if (assignmentId) meta.assignmentId = assignmentId;

        try {
          const geo = await getCurrentGeo({
            onDenied: () => setLocationDenied(true),
          });
          if (geo) meta.geo = geo;
        } catch {
          // a scan without a geotag is fine
        }

        await enqueue(meta);
        void syncNow();
        Alert.alert('Scanned', `Saved “${value}”.`, [
          { text: 'Scan another', onPress: () => resetForNextScan() },
          { text: 'Done', style: 'cancel', onPress: () => router.back() },
        ]);
      } catch (e) {
        Alert.alert('Save failed', (e as Error).message, [
          { text: 'Try again', onPress: () => resetForNextScan() },
          { text: 'Done', style: 'cancel', onPress: () => router.back() },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, router],
  );

  function resetForNextScan() {
    handled.current = false;
  }

  // --- Permission gate ---
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
            North Star uses the camera to scan the barcode on an MLS
            sticker or listing flyer. The scanned value saves on this
            device until you sync it to a workfile.
          </Text>
          {permission.canAskAgain ? (
            <Pressable style={styles.permButton} onPress={requestPermission}>
              <Text style={styles.permButtonLabel}>Allow camera</Text>
            </Pressable>
          ) : (
            <Pressable style={styles.permButton} onPress={() => Linking.openSettings()}>
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

  // --- Scanner ---
  return (
    <View style={styles.previewWrap}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        // While we're saving a scan, stop the handler firing again.
        onBarcodeScanned={busy || handled.current ? undefined : onBarcodeScanned}
        barcodeScannerSettings={{
          barcodeTypes: [
            'qr',
            'ean13',
            'ean8',
            'upc_a',
            'upc_e',
            'code39',
            'code93',
            'code128',
            'itf14',
            'codabar',
            'pdf417',
            'datamatrix',
          ],
        }}
      />

      <SafeAreaView style={styles.overlay} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <Pressable style={styles.iconButton} onPress={() => router.back()} hitSlop={12}>
            <Text style={styles.iconButtonLabel}>✕</Text>
          </Pressable>
        </View>

        <View style={styles.reticleWrap}>
          <View style={styles.reticle} />
          <Text style={styles.hint}>
            {busy ? 'Saving…' : 'Point at the barcode on the listing flyer'}
          </Text>
          {locationDenied ? (
            <Text style={styles.geoHint}>
              No location — this scan won&apos;t be geotagged
            </Text>
          ) : null}
        </View>

        <View style={styles.bottomBar}>
          {busy ? <ActivityIndicator color="#fff" /> : null}
        </View>
      </SafeAreaView>
    </View>
  );
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
    justifyContent: 'flex-start',
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
  reticleWrap: {
    alignItems: 'center',
    gap: Spacing.four,
  },
  reticle: {
    width: 240,
    height: 160,
    borderWidth: 3,
    borderColor: Brand.gold,
    borderRadius: Radius.lg,
    backgroundColor: 'transparent',
  },
  hint: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingVertical: Spacing.two,
    borderRadius: Radius.pill,
    overflow: 'hidden',
  },
  geoHint: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    backgroundColor: 'rgba(138, 90, 0, 0.85)',
    borderRadius: Radius.pill,
    overflow: 'hidden',
  },
  bottomBar: {
    minHeight: 60,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
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
