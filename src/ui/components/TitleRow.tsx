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
  /** Draws a hairline under the row, inset to the text column. */
  divided?: boolean;
  /**
   * A little more vertical air, for rows carrying three lines of text.
   *
   * The compact row's 4pt of padding is right for a title and one subtitle; with a
   * `secondary` *and* a `tertiary` — the Sent-to-you rows, where the sender sentence
   * is the point — the last line sat nearly flush against the divider, which is the
   * cramped spacing the founder flagged. Scoped as a prop rather than changed
   * globally, because the density of every other list is intentional.
   */
  spacious?: boolean;
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
  divided = false,
  spacious = false,
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
      style={[
        styles.row,
        compact && styles.rowCompact,
        spacious && styles.rowSpacious,
        pending && styles.pending,
      ]}
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
      {divided ? <View style={styles.divider} pointerEvents="none" /> : null}
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
    // Three rather than two. The founder's note was that rows felt crowded, and
    // the row's height was set by its poster with barely a hairline of air above
    // and below the text — eight more points per row is the difference between a
    // list and a stack.
    paddingVertical: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
  },
  /**
   * The separator, inset to the text rather than run edge to edge.
   *
   * A full-bleed rule cuts the poster column off from the words beside it and makes
   * the list read as a table. Starting it where the text starts lets the artwork
   * column run unbroken down the page, which is the Feed's own treatment.
   */
  divider: {
    position: 'absolute',
    left: theme.layout.gutter + theme.poster.row.width + theme.space[3],
    right: theme.layout.gutter,
    bottom: 0,
    height: StyleSheet.hairlineWidth * 2,
    backgroundColor: theme.border.hairline,
  },
  rowCompact: {
    minHeight: theme.layout.compactRow,
    paddingVertical: theme.space[1],
  },
  // After `rowCompact` in the cascade, so a compact-and-spacious row gets the air.
  rowSpacious: { paddingVertical: theme.space[2] },
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
