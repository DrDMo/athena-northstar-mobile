/**
 * CaptureRow — presentational row for a single capture: thumbnail (or
 * kind icon) with an optional GPS badge, plus a title/meta/caption body.
 *
 * Purely presentational. It renders the *tappable content* only — the
 * Inbox composes this alongside its own File/Delete action column as a
 * sibling (see `inbox.tsx`), while the assignment detail uses it
 * read-only with just `onPress`.
 *
 * The styles here are moved verbatim from the two screens that used to
 * carry their own copies, so the brand look is byte-identical.
 *
 * `showSize` appends `· <bytes>` to the meta line; the Inbox sets it so
 * its long-standing "5m ago · 1.2 MB" display is preserved exactly.
 */

import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Brand, Radius, Spacing } from '@/constants/theme';
import type { CaptureSummary } from '@/lib/api';
import { iconFor, labelFor, relativeTime } from '@/lib/captureLabels';

export function CaptureRow({
  item,
  thumbUrl,
  onPress,
  showSize = false,
}: {
  item: CaptureSummary;
  thumbUrl?: string | null;
  onPress: () => void;
  /** When true, append `· <bytes>` to the meta line (Inbox display). */
  showSize?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.rowTap, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${labelFor(item.kind)}`}
    >
      <View style={styles.thumbWrap}>
        {item.kind === 'photo' && thumbUrl ? (
          <Image source={{ uri: thumbUrl }} style={styles.thumb} />
        ) : item.kind === 'photo' ? (
          <View style={[styles.thumb, styles.thumbPlaceholder]}>
            <ActivityIndicator color={Brand.gold} size="small" />
          </View>
        ) : (
          <View style={[styles.thumb, styles.thumbIcon]}>
            <Text style={styles.thumbIconLabel}>{iconFor(item.kind)}</Text>
          </View>
        )}
        {item.geo ? (
          <View style={styles.gpsBadge}>
            <Text style={styles.gpsBadgeLabel}>GPS</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{labelFor(item.kind)}</Text>
        <Text style={styles.rowMeta}>
          {showSize
            ? `${relativeTime(item.captured_at)} · ${formatBytes(item.size_bytes)}`
            : relativeTime(item.captured_at)}
        </Text>
        {item.caption ? (
          <Text style={styles.rowCaption} numberOfLines={2}>
            {item.caption}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Human byte size ("512 B", "1.2 KB", "3.4 MB"). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  rowTap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  rowPressed: { opacity: 0.7 },
  thumbWrap: { position: 'relative' },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: Radius.sm,
    backgroundColor: '#1a1a1a',
  },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  thumbIcon: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Brand.cream,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Brand.border,
  },
  thumbIconLabel: { fontSize: 24 },
  gpsBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: Brand.green,
  },
  gpsBadgeLabel: { color: '#fff', fontSize: 8, fontWeight: '700' },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '600', color: Brand.navyDeep },
  rowMeta: { fontSize: 12, color: Brand.inkMuted, marginTop: 2 },
  rowCaption: {
    fontSize: 12,
    color: Brand.ink,
    marginTop: Spacing.one,
    fontStyle: 'italic',
  },
});
