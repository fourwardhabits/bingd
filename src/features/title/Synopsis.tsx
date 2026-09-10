import { StyleSheet } from 'react-native';

import { ClampedText, collapse as collapseAt } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * How many lines the collapsed synopsis takes. Four is the founder's number.
 *
 * It is also a hard ceiling and not only a target — see `ClampedText`, which carries it
 * as `numberOfLines` on the visible text.
 */
export const COLLAPSED_LINES = 4;

/**
 * The title page's overview, clamped to four lines with `more` **on the fourth**.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS REPLACED
 *
 * `more` was a second `Text` under the prose. So a synopsis that filled its clamp put
 * the word on a line of its own — three full lines, four words, then a lone `more` — and
 * the block spent a whole line of the page saying one word. It also pushed the genres
 * away from the paragraph they belong beside, which is what made the founder read the
 * page as a stack of bands rather than as a column of prose.
 *
 * ---------------------------------------------------------------------------
 * THE MEASUREMENT NOW LIVES IN THE DESIGN SYSTEM
 *
 * Everything about how the fourth line is measured and trimmed is `ClampedText`, and it
 * moved there rather than being copied: the founder's physical pass on iOS 1.0.1 build 8
 * found the Feed's note text expanding on a tap with nothing on screen to say so, and
 * the honest fix for that is this component's own contract applied to it — not a second
 * implementation that can drift from this one. The reasoning for the two invisible
 * passes, the word-boundary trim and the marker living *inside* the clamp is all there.
 *
 * What stays here is the part that is about the title page: four lines, the block's
 * inset, and the two labels a synopsis is opened and closed with.
 */
export function Synopsis({ text }: { text: string }) {
  return (
    <ClampedText
      text={text}
      clamp={COLLAPSED_LINES}
      testIDPrefix="synopsis"
      expandLabel="Expand description"
      // A synopsis closes again, which is the one difference from a note in the feed:
      // it is a block on a page the reader stays on rather than a row in a list.
      collapseLabel="Collapse description"
      style={styles.block}
    />
  );
}

/**
 * The collapse arithmetic at this component's own clamp.
 *
 * Kept as a named export because the four-line contract is asserted against a table of
 * measured line widths, which is where the decision is actually made. The function is
 * `ClampedText`'s; only the clamp is this component's.
 */
export function collapse(args: {
  lines: { text: string; width: number }[] | null;
  markerWidth: number | null;
  available: number | null;
}) {
  return collapseAt({ ...args, clamp: COLLAPSED_LINES });
}

const styles = StyleSheet.create({
  /**
   * The prose, full width, with the founder's 14–16 above it.
   *
   * The gap used to be supplied by the action row's own bottom edge, and when the actions
   * moved up into the identity column the synopsis was left sitting directly against
   * whichever of the two columns above it was taller — text glued to a poster on one
   * title and to a button on the next. `space[4]` is the same interval as the gutter it
   * is inset by, so the block reads as one inset field rather than as a paragraph that
   * happened to land there.
   */
  block: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[4] },
});
