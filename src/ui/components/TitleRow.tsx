import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Poster } from './Poster';
import { Text } from './Text';

export type TitleRowProps = {
  title: string;
  year?: number | null;
  posterUri?: string | null;
  bucketLabel?: string;
  position?: number;
  category?: string;
  /** Queued write awaiting sync (offline-sync.md §4). */
  pending?: boolean;
  onPress?: () => void;
};

/**
 * The workhorse row. Metadata carries the bucket label and rank when both
 * exist: "Loved it · #4 in Movies".
 *
 * A pending row stays fully legible at 70% opacity with a Sage sync glyph —
 * never a spinner and never greyed out, because the user's action did happen.
 */
export function TitleRow({
  title,
  year,
  posterUri,
  bucketLabel,
  position,
  category,
  pending = false,
  onPress,
}: TitleRowProps) {
  const metadata = [
    bucketLabel,
    position && category ? `#${position} in ${category}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, year, metadata].filter(Boolean).join(', ')}
      accessibilityHint={pending ? 'Saved on this device, waiting to sync' : undefined}
      onPress={onPress}
      style={[styles.row, pending && styles.pending]}
    >
      <Poster uri={posterUri} title={title} size="sm" />
      <View style={styles.text}>
        <Text variant="headline" numberOfLines={2}>
          {title}
          {year ? ` (${year})` : ''}
        </Text>
        {metadata ? (
          <Text variant="footnote" tone="tertiary" numberOfLines={1}>
            {metadata}
          </Text>
        ) : null}
      </View>
      {pending ? <View style={styles.syncGlyph} accessibilityElementsHidden /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.rowMinHeight,
    paddingVertical: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
  },
  text: { flex: 1, gap: theme.space[1] },
  pending: { opacity: 0.7 },
  syncGlyph: {
    width: theme.space[2],
    height: theme.space[2],
    borderRadius: theme.radius.full,
    backgroundColor: theme.semantic.progress,
  },
});
