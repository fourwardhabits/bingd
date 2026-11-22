import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '@/ui/tokens';

/**
 * **The Feed post's card** (refined card feed, founder spec 2026-11-22, Concept B).
 *
 * A subtle surface rather than the flat stream: `surface.raised` white on the Paper page,
 * a 1pt `border.hairline` outline and `radius.card` corners. No shadow at all, so the
 * card is defined by a change of surface and a very light line, never by a lift. The edge
 * sits on the screen's gutter, so a card lines up with the section headings and the
 * Trending shelf above it.
 */
export const FEED_CARD = {
  /** Screen edge to card edge: the screen's gutter. */
  margin: theme.layout.gutter,
  /**
   * Card edge to its content, on every side: one 12pt step. The one inset of a post: the
   * avatar and headline, the hero artwork, the review, the reaction summary and the rail's
   * scrolling viewport all take it, so their edges line up (founder, 2026-11-22).
   */
  inset: theme.space[3],
  /** The outline. 1pt rather than a hairline, which on a 3x screen is a third of a point and vanishes against white. */
  border: 1,
  /** Cream between two cards. */
  between: theme.space[3],
  /**
   * The first post under RECENT ACTIVITY: 8pt above the card, so heading to avatar is
   * still the 20pt it was (8 + the card's 12pt inset) and the heading belongs to the post.
   */
  leading: theme.space[2],
} as const;

/** The width inside a card's outline on a screen `screenWidth` wide. */
export const feedCardInnerWidth = (screenWidth: number) =>
  screenWidth - FEED_CARD.margin * 2 - FEED_CARD.border * 2;

/** The width of a card's content (its inset applied) on a screen `screenWidth` wide. */
export const feedCardContentWidth = (screenWidth: number) =>
  feedCardInnerWidth(screenWidth) - FEED_CARD.inset * 2;

export type FeedPostSurfaceProps = {
  children: ReactNode;
  /** The first post under the heading (`FEED_CARD.leading`). */
  leading?: boolean;
  /**
   * The child is a full-width row with its own gutters and closing rule (`ActivityRow`,
   * `FollowStoryRow`): its gutters are brought in to the card's inset and its rule, which
   * the card's outline replaces, is clipped. The rows themselves are unchanged, so the
   * profile and the conversation page, which draw them flat, are too.
   */
  row?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function FeedPostSurface({
  children,
  leading = false,
  row = false,
  style,
  testID = 'feed-post-surface',
}: FeedPostSurfaceProps) {
  return (
    <View style={[styles.surface, leading && styles.leading, style]} testID={testID}>
      {row ? <View style={styles.row}>{children}</View> : children}
    </View>
  );
}

/** What a row-shaped child's own closing rule measures (`ActivityRow`, `FollowStoryRow`). */
const ROW_RULE = StyleSheet.hairlineWidth * 2;

const styles = StyleSheet.create({
  surface: {
    marginHorizontal: FEED_CARD.margin,
    marginBottom: FEED_CARD.between,
    backgroundColor: theme.surface.raised,
    borderRadius: theme.radius.card,
    borderWidth: FEED_CARD.border,
    borderColor: theme.border.hairline,
    overflow: 'hidden',
  },
  leading: { marginTop: FEED_CARD.leading },
  row: {
    marginHorizontal: -(theme.layout.gutter - FEED_CARD.inset),
    marginBottom: -ROW_RULE,
  },
});
