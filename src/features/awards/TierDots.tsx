import { StyleSheet, View } from 'react-native';

import { theme } from '@/ui/tokens';

export type TierDotsProps = {
  /** 0, 1, 2 — or -1 before anything is earned. `AwardProgress.earnedTierIndex`. */
  earnedTierIndex: number;
};

/**
 * Three dots under a badge: bronze, silver, gold, filled as far as the reader has got.
 *
 *     ○ ○ ○   nothing yet
 *     ● ○ ○   bronze
 *     ● ● ○   silver
 *     ● ● ●   gold
 *
 * **Each dot keeps its own metal.** At silver the first dot stays bronze and only the
 * second turns silver; at gold all three are individually coloured. Recolouring every
 * earned dot to the highest metal is the obvious shortcut and it throws away the thing
 * the strip is for — a bronze dot beside a silver one *is* the progression, and three
 * identical gold dots would say only "finished", which the badge art already says.
 *
 * **Decorative, and hidden from the accessibility tree.** The row that owns these
 * announces its tier in words ("Dabbler earned", "Bronze locked"), so a screen reader
 * reading three dots would be repeating what it has already said in a form nobody can
 * act on. Colour is never the only carrier of this information.
 *
 * Deliberately not carousel pagination: the dots are 5pt with 3pt between them, pulled
 * up so they sit *on* the badge's lower edge rather than under it in a band of their
 * own. That overlap is what stops the row growing — the strip costs no height at all,
 * because it is positioned absolutely inside the badge's own box.
 */
export function TierDots({ earnedTierIndex }: TierDotsProps) {
  return (
    <View
      style={styles.strip}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {METALS.map((metal, index) => {
        const earned = index <= earnedTierIndex;
        return (
          <View
            key={metal}
            style={[
              styles.dot,
              earned
                ? { backgroundColor: theme.tier[metal] }
                : // A ring rather than a pale fill. At 5pt a low-opacity disc reads as a
                  // rendering artefact; an outline reads as an empty slot.
                  styles.locked,
            ]}
          />
        );
      })}
    </View>
  );
}

const METALS = ['bronze', 'silver', 'gold'] as const;

const DOT = 5;

const styles = StyleSheet.create({
  /**
   * Absolutely positioned over the bottom of the badge, so the row's height is still
   * set by the badge and the text beside it. Centred by stretching the full width of
   * the badge box rather than by a transform, which keeps it correct at any badge size.
   */
  strip: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 3,
  },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
  },
  locked: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.tier.locked,
  },
});
