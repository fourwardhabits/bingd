import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

export type RankAction = {
  /** Whether this reader has already ranked it. Decides the word and the treatment. */
  ranked: boolean;
  /** The whole sentence, for a reader who cannot see the control. */
  accessibilityLabel: string;
  accessibilityHint?: string;
  /**
   * Unranked: the log sheet, where a band is chosen and a first ranking begins.
   * Ranked: the ranking-options menu.
   *
   * **This control never chooses between the three ranking intents itself.** Adjusting a
   * placement and declaring a rewatch are different things with different consequences,
   * and the menu is where a reader says which they mean (PRD §10, `20260826000500`). A
   * control that guessed would be the founder's Terrace House bug rebuilt.
   */
  onPress: () => void;
};

export type IconAction = {
  accessibilityLabel: string;
  onPress: () => void;
  selected?: boolean;
  disabled?: boolean;
};

export type TitleActionsProps = {
  /** Absent for a series, which cannot be ranked (PRD §10). */
  rank: RankAction | null;
  /** The watchlist bookmark. Every kind of title has one. */
  save: IconAction;
  /** Absent for a series, which cannot be recommended (PRD §10). */
  recommend: IconAction | null;
};

/**
 * **`[ ✓ Ranked ] [ 🔖 ] [ ➤ ]` — one compact cluster, and one design at every width.**
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FOUNDER LOCKED, AND WHAT IT REPLACES
 *
 * This row has now been three things: labelled Maroon chips low on the page, then bare
 * glyphs beside the score with a full-height `Ranked` chip somewhere else, then three
 * equal icon-and-caption shares of the page width. The last of those is what this
 * replaces, and two things were wrong with it.
 *
 * **The rank control lost its word.** `Rank` is the page's one primary action and
 * `Ranked` is a state you can act on; a glyph says neither. It keeps its text here, in
 * both states, at every width — there is deliberately no responsive switch between a
 * labelled button and an icon, because a control that is a word on one phone and a
 * symbol on another is two controls.
 *
 * **Three equal shares read as a toolbar, and a right-hung cluster read as detached.**
 * The first arrangement stretched three identical icon shares across the page — a band
 * of chrome, the dashboard feeling this whole pass is removing. The second hung a
 * content-sized cluster from the right under the poster, and on the device that floated
 * in a corner with a blank column above it. This is the third and it is the ordinary
 * one: a single row directly after the identity block, the labelled control taking the
 * width the two glyphs leave. One row, one strong control, two quiet ones — and the
 * synopsis begins a short way beneath.
 *
 * ---------------------------------------------------------------------------
 * WHY ONLY THE FIRST ONE IS LABELLED
 *
 * Because only one of them is the primary act. A bookmark is a bookmark on every screen
 * in this app and in every other; a paper plane beside it, in a cluster about one title,
 * is not ambiguous once the thing beside it says Rank. Both keep their full spoken names,
 * which is where a screen reader gets them, and both clear 44pt through their own box
 * rather than through slop, so the cluster's height is the target's height.
 *
 * Unranked draws filled Maroon — it is an invitation, and the page's one primary action.
 * Ranked draws outlined — it is a fact you may edit. That pair is the app's standing
 * button hierarchy (design-system.md §8) and is unchanged from before this redesign.
 */
export function TitleActions({ rank, save, recommend }: TitleActionsProps) {
  return (
    <View testID="title-actions" style={styles.cluster}>
      {rank ? (
        <Pressable
          testID={rank.ranked ? 'title-action-ranked' : 'title-action-rank'}
          accessibilityRole="button"
          accessibilityState={{ selected: rank.ranked }}
          accessibilityLabel={rank.accessibilityLabel}
          accessibilityHint={rank.accessibilityHint}
          onPress={rank.onPress}
          style={({ pressed }) => [
            styles.rank,
            rank.ranked ? styles.ranked : styles.unranked,
            pressed && styles.pressed,
          ]}
        >
          <Ionicons
            name={rank.ranked ? 'checkmark-circle' : 'star-outline'}
            size={theme.layout.icon.sm}
            color={rank.ranked ? theme.semantic.action : theme.semantic.actionText}
          />
          <Text variant="headline" tone={rank.ranked ? 'action' : 'inverse'}>
            {rank.ranked ? 'Ranked' : 'Rank'}
          </Text>
        </Pressable>
      ) : null}

      <IconControl
        testID="title-action-save"
        icon={save.selected ? 'bookmark' : 'bookmark-outline'}
        action={save}
      />

      {recommend ? (
        <IconControl
          testID="title-action-recommend"
          icon="paper-plane-outline"
          action={recommend}
        />
      ) : null}
    </View>
  );
}

/**
 * A secondary act, as a glyph in a 44pt box.
 *
 * The box rather than `hitSlop`, because these sit next to each other and next to a
 * button: overlapping slop between neighbours is how a press lands on the wrong one.
 */
function IconControl({
  testID,
  icon,
  action,
}: {
  testID: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  action: IconAction;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{
        selected: Boolean(action.selected),
        disabled: Boolean(action.disabled),
      }}
      accessibilityLabel={action.accessibilityLabel}
      onPress={action.onPress}
      disabled={action.disabled}
      style={({ pressed }) => [styles.icon, pressed && styles.pressed]}
    >
      <Ionicons
        name={icon}
        size={theme.layout.icon.md}
        // Maroon when held, neutral otherwise — the app's one selected-control treatment,
        // the same pair the feed row and the search row draw.
        color={action.selected ? theme.semantic.action : theme.text.secondary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /**
   * One row across the content width, directly after the identity block.
   *
   * The top padding is also the clearance for the score, which overhangs the poster's
   * lower edge by a few points on its caption; the row is the first thing beneath it.
   */
  cluster: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[5],
  },
  rank: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
    // The width the two glyphs leave. It makes the labelled control unmistakably the
    // primary act, and `Rank` and `Ranked` the same object at two lengths rather than a
    // control that resizes the moment you use it.
    flex: 1,
    paddingHorizontal: theme.space[4],
    borderRadius: theme.radius.control,
  },
  unranked: { backgroundColor: theme.semantic.action },
  ranked: {
    backgroundColor: theme.surface.raised,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.semantic.action,
  },
  icon: {
    width: theme.layout.minTapTarget,
    height: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
});
