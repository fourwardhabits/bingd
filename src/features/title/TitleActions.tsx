import { Ionicons } from '@expo/vector-icons';
import { Animated, Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { hapticSelection } from '@/ui/haptics';
import { usePressScale, usePulse } from '@/ui/press';
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
 * **It is content-sized, and that is the founder's fourth and final correction**
 * (2026-09-07). The arrangement this replaces gave the labelled control `flex: 1` — the
 * whole width the two glyphs left — on the reasoning that width makes it unmistakably
 * the primary act. On the device it did the opposite: a full-width control at the top of
 * a reading page is a form's submit button, and the row read as chrome laid across the
 * page rather than as something belonging to the title above it. `Rank` and `Ranked` are
 * about 104 and 132 points of label; that is what they now measure, with
 * `inlineButtonMaxWidth` as the guard at 130% type.
 *
 * The trailing space to its right is not waste, it is the signal: it is what says the
 * group has ended.
 *
 * **The row lives inside the identity column now**, beside the poster, directly under
 * the personal-context line — not below the whole poster/identity region. The founder's
 * note is that waiting for the bottom of a 150pt poster to place a 44pt button leaves an
 * obvious dead band above it on every short title. The component takes no horizontal
 * padding of its own for that reason: it is inside a block that is already inset.
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
  /**
   * **The page's primary act gives under a thumb** (founder premium pass, 2026-09-08).
   *
   * Rank is the button the whole title page is arranged around, and Ranked is the door
   * into the ranking menu. The two icon controls beside it take the same treatment
   * through `IconControl`, so the cluster answers a thumb as one surface rather than as
   * one animated control standing next to two that do not move.
   */
  const rankPress = usePressScale();

  return (
    <View testID="title-actions" style={styles.cluster}>
      {rank ? (
        <Animated.View style={rankPress.pressStyle}>
          <Pressable
            testID={rank.ranked ? 'title-action-ranked' : 'title-action-rank'}
            accessibilityRole="button"
            accessibilityState={{ selected: rank.ranked }}
            accessibilityLabel={rank.accessibilityLabel}
            accessibilityHint={rank.accessibilityHint}
            onPress={rank.onPress}
            onPressIn={rankPress.onPressIn}
            onPressOut={rankPress.onPressOut}
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
            {/* One line, always. The button is content-sized with a ceiling, so the only
              way the label could break is at a text size where it meets that ceiling —
              and a two-line `Ranked` is a control that has changed shape rather than a
              label that has grown. */}
            <Text
              variant="headline"
              numberOfLines={1}
              tone={rank.ranked ? 'action' : 'inverse'}
            >
              {rank.ranked ? 'Ranked' : 'Rank'}
            </Text>
          </Pressable>
        </Animated.View>
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
  const press = usePressScale({ enabled: !action.disabled });
  const pop = usePulse();

  return (
    <Animated.View style={press.pressStyle}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityState={{
          selected: Boolean(action.selected),
          disabled: Boolean(action.disabled),
        }}
        accessibilityLabel={action.accessibilityLabel}
        /**
         * **Selection, and a pulse on the way on** (founder premium pass, 2026-09-08).
         *
         * Both controls this draws — bookmark and recommend — are the reader saving or
         * sending, which is the `selection` class in `ui/haptics.ts`: light, and the same
         * word every other bookmark in the app now speaks.
         *
         * The pulse fires only when the control is turning *on*. `action.selected` is the
         * state before the press, so `!action.selected` is the press that adds something —
         * and un-saving gets no celebration, because a flourish for undoing is the app
         * disagreeing with the reader. Recommend has no selected state, so it pulses on
         * every press, which is correct: sending is always an addition.
         */
        onPress={() => {
          hapticSelection();
          if (!action.selected) pop.pulse();
          action.onPress();
        }}
        disabled={action.disabled}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={({ pressed }) => [styles.icon, pressed && styles.pressed]}
      >
        <Animated.View style={pop.pulseStyle}>
          <Ionicons
            name={icon}
            size={theme.layout.icon.md}
            // Maroon when held, neutral otherwise — the app's one selected-control treatment,
            // the same pair the feed row and the search row draw.
            color={action.selected ? theme.semantic.action : theme.text.secondary}
          />
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  /**
   * One left-aligned group inside the identity column.
   *
   * No horizontal padding: the block above it is already inset by the gutter and this
   * row sits in the same column as the title. No top padding either — the screen owns
   * the distance from the personal-context line, because that gap is one interval in a
   * spacing contract the screen holds and not a property of a button cluster.
   *
   * `align-items: center` rather than `stretch`, so the two 44pt icon boxes and the
   * label-sized button share a centre line whatever the label does at large type.
   */
  cluster: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: theme.space[2],
  },
  rank: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
    /**
     * Sized by its label, capped, and never stretched.
     *
     * `flexShrink: 1` rather than `flex: 1`: it takes exactly the width `Rank` or
     * `Ranked` needs and gives width back only if the row genuinely runs out — which,
     * with two 44pt glyphs beside it and a 168pt ceiling, it cannot at any width this
     * app runs at. That is the difference between a compact control and the full-width
     * one the founder rejected.
     */
    flexShrink: 1,
    /**
     * A floor as well as a ceiling, so `Rank` and `Ranked` are the same width.
     *
     * Without it the control grew by two characters at the moment a ranking succeeded and
     * pushed the bookmark and recommend glyphs sideways — a twitch at exactly the wrong
     * moment. The floor is the wider label's own default-type width; see the token.
     */
    minWidth: theme.layout.control.inlineButtonMinWidth,
    maxWidth: theme.layout.control.inlineButtonMaxWidth,
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
