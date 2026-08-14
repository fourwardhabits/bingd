import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Poster } from './Poster';
import { Text } from './Text';

export type TitleRowProps = {
  title: string;
  year?: number | null;
  posterUri?: string | null;
  size?: 'xs' | 'sm';
  secondary?: ReactNode;
  tertiary?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  pending?: boolean;
  onPress: () => void;
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
  size = 'sm',
  secondary,
  tertiary,
  leading,
  trailing,
  pending = false,
  onPress,
}: TitleRowProps) {
  const compact = size === 'xs';
  const secondaryLabel = typeof secondary === 'string' ? secondary : null;
  const tertiaryLabel = typeof tertiary === 'string' ? tertiary : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, year, secondaryLabel, tertiaryLabel].filter(Boolean).join(', ')}
      accessibilityHint={pending ? 'Saved on this device, waiting to sync' : undefined}
      onPress={onPress}
      style={[styles.row, compact && styles.rowCompact, pending && styles.pending]}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <Poster uri={posterUri} title={title} size={compact ? 'xs' : 'sm'} />
      <View style={styles.text}>
        <Text variant={compact ? 'callout' : 'headline'} numberOfLines={2}>
          {title}
          {year ? ` (${year})` : ''}
        </Text>
        {typeof secondary === 'string' ? (
          <Text variant="footnote" tone="secondary" numberOfLines={1}>
            {secondary}
          </Text>
        ) : (
          secondary
        )}
        {typeof tertiary === 'string' ? (
          <Text variant="footnote" tone="tertiary" numberOfLines={1}>
            {tertiary}
          </Text>
        ) : (
          tertiary
        )}
      </View>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      {pending ? <View style={styles.syncGlyph} accessibilityElementsHidden /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space[3],
    minHeight: theme.layout.row.media,
    paddingVertical: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
  },
  rowCompact: {
    minHeight: theme.layout.row.dense,
    paddingVertical: theme.space[1],
  },
  leading: {
    width: theme.layout.row.ordinalColumn,
    minHeight: theme.poster.sm.height,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: 2, minHeight: theme.poster.sm.height, justifyContent: 'center' },
  trailing: {
    minHeight: theme.poster.sm.height,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  pending: { opacity: 0.7 },
  syncGlyph: {
    width: theme.space[2],
    height: theme.space[2],
    borderRadius: theme.radius.full,
    backgroundColor: theme.semantic.progress,
  },
});
