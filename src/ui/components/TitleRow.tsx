import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Poster } from './Poster';
import { Text } from './Text';

export type TitleRowProps = {
  title: string;
  year?: number | null;
  posterUri?: string | null;
  /** `row` is the compact default. `sm` is for the few places a roomier row is
   *  deliberate — a seasons list, where the poster is the differentiator. */
  size?: 'row' | 'xs' | 'sm';
  secondary?: ReactNode;
  tertiary?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  pending?: boolean;
  onPress: () => void;
};

/**
 * The workhorse row — Letterboxd's diary row (design-system.md §8).
 *
 * The rebuild that matters is invisible in the markup: the text block no longer
 * carries `minHeight: poster.sm.height`. It did, on the text, the leading column
 * and the trailing column all at once, which meant an 84pt poster set the height
 * of a row holding two lines of type. Artwork was dictating the rhythm of every
 * list in the app, and no amount of tuning the padding could recover the density
 * while that pin was there.
 *
 * Now the type sets the height and the poster fits inside it. This also keeps
 * the row honest under Dynamic Type: the poster is a fixed size, so a row grows
 * with its text rather than clipping it.
 *
 * A pending row stays fully legible at 70% opacity with a Sage sync glyph —
 * never a spinner and never greyed out, because the user's action did happen.
 */
export function TitleRow({
  title,
  year,
  posterUri,
  size = 'row',
  secondary,
  tertiary,
  leading,
  trailing,
  pending = false,
  onPress,
}: TitleRowProps) {
  const compact = size !== 'sm';
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
      <Poster uri={posterUri} title={title} size={size} />
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
    // Centred, not top-aligned. With the poster no longer taller than the text,
    // top alignment leaves the badge and the artwork floating above a one-line
    // subtitle.
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.row.media,
    paddingVertical: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
  },
  rowCompact: {
    minHeight: theme.layout.compactRow,
    paddingVertical: theme.space[1],
  },
  leading: {
    width: theme.layout.row.ordinalColumn,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: 1, justifyContent: 'center' },
  trailing: { justifyContent: 'center', alignItems: 'flex-end' },
  pending: { opacity: 0.7 },
  syncGlyph: {
    width: theme.space[2],
    height: theme.space[2],
    borderRadius: theme.radius.full,
    backgroundColor: theme.semantic.progress,
  },
});
