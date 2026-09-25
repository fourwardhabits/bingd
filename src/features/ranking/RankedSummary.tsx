import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { RankingCategory } from '@/features/collection/use-collection';
import { posterUri } from '@/lib/images';
import { Poster, ScoreBadge, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * **What you just ranked** — the payoff both ranking sources end on (founder,
 * 2026-09-23 and the Done addendum, 2026-09-24).
 *
 * Refine had this and the backlog did not, which meant somebody could place forty titles
 * from Unranked and be shown a number. One component now, used by both, so the two
 * cannot drift apart again the way the skip link and the card framing did.
 *
 * ---------------------------------------------------------------------------
 * WHAT A ROW SAYS, AND WHAT IT REFUSES TO
 *
 * Poster, title, where it now sits, and the score — in the app's own row grammar and the
 * app's own maroon `ScoreBadge`. The position uses the title page's words, `#7 in Movies`,
 * because a reader who sees that label on a title page and a different one here has to
 * work out whether they mean the same thing.
 *
 * There is deliberately **no old position, no movement arrow, no previous score, no watch
 * date and nothing social**. A summary is a statement of standing, not a diff: five rows
 * of `#9 → #7` is a page about the last two minutes rather than about the list, and a
 * watch date here would imply ranking had something to do with when a title was seen,
 * which is the one thing it must never imply.
 *
 * The position is omitted outright when the server named no valid ordinal. A blank where
 * a number belongs is worse than a row that does not claim one.
 */
export type RankedSummaryTitle = {
  mediaItemId: string;
  title: string;
  /** The canonical position this title now holds. Omitted when absent or nonsensical. */
  position?: number | null;
  posterPath?: string | null;
  score?: number | null;
  bucket?: string | null;
};

/** The title page's words for a standing, so the two surfaces cannot word it differently. */
export function placeLabel(position: number | null | undefined, medium: RankingCategory) {
  if (typeof position !== 'number' || !Number.isInteger(position) || position <= 0) return null;
  return `#${position} in ${medium === 'movies' ? 'Movies' : 'TV'}`;
}

/** The server's band name, only when it is one the badge can speak aloud. */
function bucketOf(bucket: string | null | undefined) {
  return bucket === 'loved' || bucket === 'fine' || bucket === 'not_for_me' ? bucket : null;
}

export function RankedSummaryRow({
  title,
  medium,
}: {
  title: RankedSummaryTitle;
  medium: RankingCategory;
}) {
  const place = placeLabel(title.position, medium);

  return (
    <View style={styles.row} accessible accessibilityRole="text" testID="ranked-summary-row">
      <Poster uri={posterUri(title.posterPath ?? null, 'card')} title={title.title} size="row" />
      <View style={styles.rowText}>
        <Text variant="callout" numberOfLines={2}>
          {title.title}
        </Text>
        {place ? (
          <Text variant="footnote" tone="tertiary" numberOfLines={1}>
            {place}
          </Text>
        ) : null}
      </View>
      {typeof title.score === 'number' ? (
        <ScoreBadge score={title.score} bucket={bucketOf(title.bucket)} size="sm" />
      ) : null}
    </View>
  );
}

/**
 * The whole completion screen: a heading, the rows, whatever the flow wants to say under
 * them, and its actions.
 *
 * **It scrolls and its actions stay reachable**, which is the requirement that shapes it.
 * A sitting has no practical ceiling — somebody working through an imported library can
 * place fifty titles before they tap Done — so the rows are the scrolling part and the
 * actions sit outside the scroll view, pinned at the foot. Putting the buttons inside the
 * list is what makes a long session end with a reader flicking to find Done.
 *
 * **No helper sentence under the rows** (founder, 2026-09-25). It carried "You're caught
 * up." here and "Nothing else needs a look right now." on Refine; both restated what the
 * heading and the rows had already said, and the instruction was to remove rather than
 * reword. What is left is the count, the titles and the actions — and the actions are
 * where "there is more" is expressed, by Keep ranking being offered or not.
 */
export function RankedSummary({
  heading,
  titles,
  medium,
  actions,
}: {
  heading: string;
  titles: readonly RankedSummaryTitle[];
  medium: RankingCategory;
  /** The buttons, pinned below the scroll so a long list cannot bury them. */
  actions: React.ReactNode;
}) {
  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        testID="ranked-summary-scroll"
        // A long sitting is the case this exists for, so the indicator is worth having.
        showsVerticalScrollIndicator
      >
        <Text variant="title2" accessibilityRole="header">
          {heading}
        </Text>
        <View style={styles.rows}>
          {titles.map((title) => (
            <RankedSummaryRow key={title.mediaItemId} title={title} medium={medium} />
          ))}
        </View>
      </ScrollView>
      <View style={styles.actions}>{actions}</View>
    </View>
  );
}

/** How a sitting's count is said. Exported so both flows word it identically. */
export const rankedHeading = (count: number, verb: 'ranked' | 'checked') =>
  count === 1 ? `1 title ${verb}` : `${count} titles ${verb}`;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    minHeight: theme.layout.minTapTarget,
  },
  headerTitle: { flex: 1 },
  done: { color: theme.semantic.action },
  pressed: { opacity: 0.7 },
  scroll: { padding: theme.layout.gutter, gap: theme.space[3] },
  rows: { gap: theme.space[1] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    // A little more air than a list row: these are the whole screen, not a dense index.
    paddingVertical: theme.space[2],
  },
  rowText: { flex: 1, gap: 2 },
  // Outside the ScrollView, so fifty rows cannot push Done off the bottom.
  actions: {
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    paddingBottom: theme.space[3],
  },
});

/**
 * **The session header, with Done where the close button was** (founder addendum,
 * 2026-09-24).
 *
 * A reader with four hundred unranked titles should not have to empty the queue to be
 * shown what they just did. Done ends the sitting *and* pays it off: it routes to the
 * same summary the natural ending uses, listing only what this sitting actually placed.
 *
 * It replaces the `×` rather than joining it. Two exits in one corner is two things to
 * reason about — one of them discarding the payoff — and the founder's instruction is
 * that Done is the way out. A reader who force-quits or uses the system back gesture
 * still leaves silently, because neither of those is a decision to finish.
 *
 * The word is a text action rather than a glyph because it is the primary way out of a
 * screen somebody may be on for ten minutes, and `×` reads as *discard* next to a list
 * of work.
 */
export function SessionHeader({
  title,
  progress,
  onDone,
}: {
  title: string;
  /** The right-hand count, when the flow has an honest one to show. */
  progress?: React.ReactNode;
  /**
   * Omitted on every phase that draws its own terminal action — the summary, the
   * checkpoint, the caught-up screen, an empty pool, a failure. Two Dones in one frame
   * is two things to reason about, and on those screens the one in the body is the one
   * that carries the meaning.
   */
  onDone?: () => void;
}) {
  return (
    <View style={styles.header}>
      <Text variant="headline" accessibilityRole="header" style={styles.headerTitle}>
        {title}
      </Text>
      {progress}
      {onDone ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Done"
        accessibilityHint="Ends this sitting and shows what you ranked"
        hitSlop={theme.space[3]}
        onPress={onDone}
        style={({ pressed }) => (pressed ? styles.pressed : undefined)}
      >
        <Text variant="callout" style={styles.done}>
          Done
        </Text>
      </Pressable>
      ) : null}
    </View>
  );
}
