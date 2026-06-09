/**
 * Capture entry point — the big-buttoned in-the-field surface.
 *
 * v0.1 ships as a placeholder grid. Each tile becomes a real
 * capture flow in a follow-up milestone:
 *
 *   - Photo: expo-camera, EXIF + GPS preserved
 *   - Voice note: expo-av, .m4a recordings
 *   - Sketch: react-native-svg + gesture-handler canvas
 *   - Address lookup: Apple Maps / Geocoder reverse-geocode
 *   - Scan barcode (MLS sticker on listing flyer): expo-barcode-scanner
 *
 * One-handed UX is the design constraint here — most field
 * appraisers are holding a tape measure or clipboard in the other
 * hand. Big tap targets, voice-first where possible.
 */

import { useRouter } from 'expo-router';
import { StyleSheet, Text, View, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Brand, Radius, Spacing } from '@/constants/theme';

type Tile = {
  key: string;
  title: string;
  sub: string;
  href?: '/photo-capture' | '/voice-capture';
  disabled?: boolean;
};

const TILES: Tile[] = [
  { key: 'photo', title: 'Photo', sub: 'with EXIF + GPS', href: '/photo-capture' },
  { key: 'voice', title: 'Voice note', sub: '.m4a recording', href: '/voice-capture' },
  { key: 'sketch', title: 'Sketch', sub: 'finger or stylus', disabled: true },
  { key: 'address', title: 'Address', sub: 'lookup + reverse geocode', disabled: true },
  { key: 'mls', title: 'MLS scan', sub: 'barcode → comp', disabled: true },
  { key: 'note', title: 'Text note', sub: 'tag to a workfile', disabled: true },
];

export default function CaptureScreen() {
  const router = useRouter();
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
                if (t.href) router.push(t.href);
              }}
            >
              <Text style={styles.tileTitle}>{t.title}</Text>
              <Text style={styles.tileSub}>{t.sub}</Text>
              {t.disabled ? <Text style={styles.tileSoon}>SOON</Text> : null}
            </Pressable>
          ))}
        </View>

        <Text style={styles.fine}>
          Photo capture is live. Voice, sketch, address and MLS-scan
          flows ship in subsequent milestones. Captures stay on this
          device until sync-to-workfile (m4) — for now they queue in
          the photo screen and clear when you leave it.
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
