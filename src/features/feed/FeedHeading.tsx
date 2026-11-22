import { SectionHeader } from '@/ui/components';
import { theme } from '@/ui/tokens';

export type FeedHeadingProps = {
  /** As written; the token uppercases it and a screen reader hears it as given. */
  title: string;
  /**
   * The heading's own line height rather than a 44pt row (`SectionHeader`'s `tight`): RECENT
   * ACTIVITY, whose first post sits a fixed distance under it. Type is unchanged.
   */
  tight?: boolean;
};

/**
 * How far the Feed tab's headings grow with the reader's text size: the type scale's own
 * display ceiling, 130% (design-system.md §4), rather than a number chosen here.
 *
 * At 130% on a 320pt phone the longest word any of them holds, LEADERBOARD, still fits
 * beside the three-way toggle, so no heading has to shrink or break inside a word; DISCOVER
 * PEOPLE and TRENDING NOW wrap at their space instead.
 */
export const FEED_HEADING_MAX_SCALE = theme.typography.display.maxFontSizeMultiplier;

/**
 * **The Feed tab's one section heading** (header consistency, founder spec 2026-11-22).
 *
 *     TRENDING NOW                    [Feed] [Trophy] [People]
 *     LEADERBOARD                     [Feed] [Trophy] [People]
 *     DISCOVER PEOPLE                 [Feed] [Trophy] [People]
 *     ─────────────
 *     RECENT ACTIVITY
 *
 * Every heading the tab draws is this — the three modes' headings in the content heading
 * row, and RECENT ACTIVITY under the shelf — so they cannot come apart again. Production
 * had them at three sizes: LEADERBOARD and DISCOVER PEOPLE were drawn with `fit`, which
 * shrank each onto one line by however much it needed, and TRENDING NOW was not.
 *
 * It is `SectionHeader` at `size="large"` (`sectionHeaderLarge`, 15pt, Maroon, uppercase)
 * with one ceiling for all of them, `FEED_HEADING_MAX_SCALE`. Nothing is shrunk to fit, so
 * at every text size every heading on the tab is the same size as every other; a long
 * heading wraps at a word instead. RECENT ACTIVITY is the same type in a secondary place —
 * under the shelf and its rule, opposite no control — and only its spacing differs.
 */
export function FeedHeading({ title, tight = false }: FeedHeadingProps) {
  return (
    <SectionHeader title={title} size="large" maxScale={FEED_HEADING_MAX_SCALE} tight={tight} />
  );
}
