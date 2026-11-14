import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '../tokens';
import { Button } from './Button';

export type PairAction = {
  label: string;
  onPress: () => void;
  accessibilityHint?: string;
  testID?: string;
};

export type ActionPairProps = {
  /** The way out (*Done*). Leading in a row, second when stacked. */
  secondary: PairAction;
  /** The next useful act (*Rank titles*). The only Maroon fill; trailing in a row, first when stacked. */
  primary: PairAction;
  /** `secondary` (grey outline, the default) or `outline` (Maroon outline). */
  secondaryKind?: 'secondary' | 'outline';
  /**
   * The horizontal space the pair does **not** get from the window: the page gutters on
   * either side by default, which is where a `Screen` page puts it. A caller inside a
   * card or a sheet passes its own.
   */
  horizontalInset?: number;
  /**
   * Pinned under a scroll body, outside any `Screen includeBottomInset`: the pair then owns
   * the bottom edge and pads by the safe area (design-system.md §5, "The bottom edge
   * belongs to whatever is at the bottom"). Off by default, because a pair in a scroll body
   * on a `Screen` that already insets would pad twice.
   */
  pinned?: boolean;
  testID?: string;
};

/**
 * **A primary/secondary pair of equal standing in size, not in emphasis** (IMP1113-UI).
 *
 * design-system.md §8, *A pair of actions in one row*, as one component: two equal halves
 * side by side, secondary leading and the Maroon fill trailing, both `fit`. When the two
 * labels cannot both fit their halves at their natural size, the pair becomes two
 * full-width rows **with the primary on top**. It never shrinks one half to buy the other
 * room.
 *
 * **The layout is decided from the viewport, not from `flexWrap`** (the same section):
 * Yoga gives a flex child no automatic minimum size, so a wrap that would have saved a label
 * never fires. The window's width and font scale decide, against each label's advance
 * measured from Inter SemiBold (`PAIR_LABEL_EM`, re-measured from the font file by
 * `ActionPair.test.tsx`), with a conservative per-character estimate for any other label.
 *
 * **Equal heights and widths.** In a row each half is `flex: 1`, and `fit` keeps both
 * labels on one line, so two `md` buttons are the same height at every size. Stacked, both
 * are full width, and a label may wrap rather than clip.
 *
 * Why not `RankingSheet`'s reveal exits: those are the sheet's own, measured against its
 * own labels and its own bounded body, and lifting them out would reshape a shipped flow.
 * This is the page-level version of the same rule.
 */
export function ActionPair({
  secondary,
  primary,
  secondaryKind = 'secondary',
  horizontalInset = theme.layout.gutter * 2,
  pinned = false,
  testID,
}: ActionPairProps) {
  const { width, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const row = actionPairFitsRow(
    [secondary.label, primary.label],
    width,
    fontScale,
    horizontalInset,
  );

  // `Button` takes no style, so each half is a wrapper. Both are `fit` in a row, which
  // holds each label to one line: two `md` buttons of one line are one height.
  const primaryButton = (
    <View key="primary" style={row ? styles.half : undefined}>
      <Button
        label={primary.label}
        onPress={primary.onPress}
        accessibilityHint={primary.accessibilityHint}
        testID={primary.testID}
        fit={row}
      />
    </View>
  );
  const secondaryButton = (
    <View key="secondary" style={row ? styles.half : undefined}>
      <Button
        label={secondary.label}
        kind={secondaryKind}
        onPress={secondary.onPress}
        accessibilityHint={secondary.accessibilityHint}
        testID={secondary.testID}
        fit={row}
      />
    </View>
  );

  return (
    <View
      testID={testID}
      style={[
        row ? styles.row : styles.stack,
        pinned && { paddingBottom: Math.max(insets.bottom, theme.space[4]) },
      ]}
    >
      {/* Reading order follows the drawing order: secondary then primary in a row, the
          primary first when stacked. */}
      {row ? [secondaryButton, primaryButton] : [primaryButton, secondaryButton]}
    </View>
  );
}

/**
 * Each known label's advance width in Inter SemiBold, in em, measured from the font file
 * (`ActionPair.test.tsx` re-measures them, so the table cannot drift from the font). The
 * same method as `RankingSheet`'s reveal exits.
 */
export const PAIR_LABEL_EM: Record<string, number> = {
  Done: 2.534,
  'Rank titles': 5.03,
  Continue: 4.388,
};
/**
 * A label not in the table, per character: above the widest per-character average of the
 * measured labels (*Done*, 0.634em), so an unmeasured label errs toward stacking.
 */
export const LABEL_EM_PER_CHAR = 0.65;
/** `Button`'s `headline` label. */
const LABEL_SIZE = theme.typography.headline.fontSize;
/** 4% over the measured advance, for hinting and rounding (as `revealLabelWidth`). */
const ADVANCE_MARGIN = 1.04;
/** `fit`'s side padding, both sides, plus the 2pt border either side of a secondary. */
const FIT_CHROME = theme.space[3] * 2 + 4;

/** The natural width of one `fit` button with this label, at this font scale. */
export function pairLabelWidth(label: string, fontScale: number) {
  const em = PAIR_LABEL_EM[label] ?? label.length * LABEL_EM_PER_CHAR;
  return em * LABEL_SIZE * fontScale * ADVANCE_MARGIN + FIT_CHROME;
}

/**
 * Whether both labels fit their equal halves of the row at their natural size. Exported for
 * the layout tests: jest has no layout engine, so the arithmetic is what can be pinned.
 */
export function actionPairFitsRow(
  labels: readonly string[],
  windowWidth: number,
  fontScale: number,
  horizontalInset: number = theme.layout.gutter * 2,
) {
  const half = (windowWidth - horizontalInset - theme.space[2]) / 2;
  return labels.every((label) => pairLabelWidth(label, fontScale) <= half);
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'stretch', gap: theme.space[2] },
  stack: { gap: theme.space[2] },
  half: { flex: 1 },
});
