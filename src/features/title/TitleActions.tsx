import { Ionicons } from '@expo/vector-icons';
import { Animated, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

import { Text } from '@/ui/components';
import { hapticSelection } from '@/ui/haptics';
import { usePressScale, usePulse } from '@/ui/press';
import { brand, paperAlpha, theme } from '@/ui/tokens';

/**
 * The icon controls' own width; `hitSlop` makes up the rest of the 44pt target.
 *
 * 32 since the fourth control (Add to List, founder QA 2026-09-21), and four again since
 * 2026-11-21 (Recommend back beside the ⋯). The cluster still wraps
 * as a last resort rather than truncate the one word the row exists to say, but the screen
 * moves it before that happens: see {@link titleActionsFit}.
 */
const ICON_BOX = 32;

/** The word `Ranked` in `headline` at the default text size, as rendered. */
const RANKED_LABEL = 63;

/**
 * One character of `headline` at the default text size, from `Ranked`'s measured width.
 * The labels this control now carries (TV show & season ranking, 2026-11-14) are longer
 * than the two it was measured for, so the fit is estimated from the label rather than
 * from the wider of `Rank` and `Ranked`.
 */
const HEADLINE_CHAR = RANKED_LABEL / 'Ranked'.length;

/**
 * **The label may grow with the reader's text size up to this, then fits itself to the
 * row** (TV show & season ranking, 2026-11-14). `Rank Season` and `Log rewatch` are twice
 * `Rank`, and the cluster is one row at every width now: beyond 1.5x the label is scaled
 * down to fit rather than wrapping the icons under it or being cut. 1.5x of `headline` is
 * still a 25pt word.
 */
export const RANK_LABEL_MAX_SCALE = 1.5;
/**
 * **The smallest the word ever draws, as a share of its default size** (title actions
 * polish, 2026-11-21): 0.7, the floor this control has always had at the default text
 * size — about 12pt for `Rank Season`, 10.5pt for the compact `Log rewatch`.
 *
 * It used to be 0.7 *of the scaled size*, which at 1.5x is 1.05x the default: with four
 * controls on a 320pt phone at the largest text sizes the word could not shrink to the row
 * and ellipsized (`Rank Sea…`). The floor is held in absolute terms instead (see
 * {@link rankLabelMinimumScale}), so the word fits itself down to what it already draws at
 * its tightest by default, and never below. At every width this app runs at the row needs
 * no more than that (`TitleActions.test.ts`, "the four-control row").
 */
export const RANK_LABEL_MIN_FIT = 0.7;

/**
 * `minimumFontScale` for the word at this text size: {@link RANK_LABEL_MIN_FIT} of the
 * *default* size, expressed against the size the label is drawn at (capped at
 * {@link RANK_LABEL_MAX_SCALE}). At or below 1x this is 0.7, exactly as before.
 */
export function rankLabelMinimumScale(fontScale: number): number {
  const drawn = Math.min(Math.max(fontScale, 1), RANK_LABEL_MAX_SCALE);
  return RANK_LABEL_MIN_FIT / drawn;
}

/** The words this control can say, unranked, by kind (brief §8). */
export const RANK_LABEL = {
  movie: 'Rank Movie',
  series: 'Rank Show',
  season: 'Rank Season',
} as const;

/**
 * **The drawn height of the filled Rank control** (visual refine, 2026-11-12).
 *
 * Rank used to take its height from the 44pt target itself, which made the filled Maroon
 * block the tallest thing in the row and read heavier than the glyphs beside it. It is
 * drawn 8pt shorter now and {@link RANK_SLOP} gives the 8 back, so the press target is
 * still 44: the compact rewatch form's arithmetic (`rankCompact`, 36pt with 4pt of slop
 * each side), reused rather than a second one invented. On the immersive page that also
 * makes Rank and the Log rewatch that replaces it once ranked one height.
 *
 * The 17pt `headline` label (a 22pt line, 33pt at the 1.5x cap) still sits inside it, and
 * `minHeight` lets the box grow rather than clip if it ever did not. The outlined `Ranked`
 * keeps the full 44: only the invitation is lightened.
 */
export const RANK_VISIBLE_HEIGHT = theme.layout.minTapTarget - 8;
/** Vertical slop that lifts a {@link RANK_VISIBLE_HEIGHT} control back to the 44pt target. */
export const RANK_SLOP = {
  top: (theme.layout.minTapTarget - RANK_VISIBLE_HEIGHT) / 2,
  bottom: (theme.layout.minTapTarget - RANK_VISIBLE_HEIGHT) / 2,
} as const;

/** What around the word does not scale: padding, the tick, its gap, the border, the margin. */
const RANK_CHROME = theme.space[3] * 2 + theme.layout.icon.sm + theme.space[2] + 2 + theme.space[1];

/**
 * Whether the cluster fits on one line in a column this wide.
 *
 * Decided from the viewport and never from `flexWrap` (design-system.md §8). Left to wrap,
 * a 375pt phone orphaned the last glyph on a line of its own. Always measured against
 * `Ranked`, or the label the control will actually say, so a title does not change layout
 * the moment it is ranked. Every kind has a rank control since 2026-11-14: a film, a whole
 * show and a season are each rankable in their own pool.
 */
export function titleActionsFit(
  columnWidth: number,
  fontScale: number,
  { rank, icons, label }: { rank: boolean; icons: number; label?: string },
): boolean {
  const glyphs = icons * (ICON_BOX + theme.space[1]);
  // Only the word grows with the text size, and only to the cap the label renders with.
  // Scaling the whole control would underestimate it below 100%, which is exactly where
  // the last glyph used to get stranded.
  const word = label ? label.length * HEADLINE_CHAR : RANKED_LABEL;
  const scale = Math.min(fontScale, RANK_LABEL_MAX_SCALE);
  return (rank ? RANK_CHROME + word * scale : 0) + glyphs <= columnWidth;
}

/**
 * **The ⋯ menu's one editing row, worded for what exists** (founder's final specification,
 * 2026-11-21). It opens the existing log sheet on the existing log; the label says what the
 * reader will find there and promises nothing the data does not have.
 *
 *   ranked                       Edit ranking / …   the band chooser corrects the ranking
 *                                                   (no viewing recorded)
 *   logged or imported, unranked Edit log / …       no ranking exists to edit; the bands
 *                                                   there are a first ranking
 *   no log                       none               Rank is already the door to that sheet
 *
 * The second half names the writing that is there — `review` for a published one, `note`
 * for a private one, `Add note` for none — because "Add note" over a review would be a
 * promise about the wrong thing. The same rule holds for a film, a season and a whole
 * show, each its own log; a show shown with its seasons' average and no ranking of its own
 * is an unranked show and reads by whether the show itself is logged.
 */
export function titleEditLabel({
  ranked,
  logged,
  hasReview,
  hasPrivateNote,
}: {
  ranked: boolean;
  logged: boolean;
  hasReview: boolean;
  hasPrivateNote: boolean;
}): string | null {
  if (!ranked && !logged) return null;
  const writing = hasReview ? 'review' : hasPrivateNote ? 'note' : 'Add note';
  return `${ranked ? 'Edit ranking' : 'Edit log'} / ${writing}`;
}

export type RankAction = {
  /** Whether this reader has already ranked it. Decides the word and the treatment. */
  ranked: boolean;
  /** The whole sentence, for a reader who cannot see the control. */
  accessibilityLabel: string;
  accessibilityHint?: string;
  /**
   * Unranked: the log sheet, where a band is chosen and a first ranking begins.
   * Ranked: *Log rewatch*, the rewatch sheet, on both layouts since 2026-11-21. The
   * correction of an existing ranking is the ⋯ menu's *Edit ranking / Add note*.
   *
   * **This control never chooses between the three ranking intents itself.** Adjusting a
   * placement and declaring a rewatch are different things with different consequences,
   * and the reader says which they mean — in the menu, or by a label that names exactly
   * one of them (PRD §10, `20260826000500`). A control that guessed would be the founder's
   * Terrace House bug rebuilt.
   */
  onPress: () => void;
  /**
   * The word and glyph the control draws. The title page passes `Rank Movie` / `Rank Show`
   * / `Rank Season` unranked and *Log rewatch* ranked (both layouts since 2026-11-21).
   * Absent, the control reads Rank or Ranked.
   */
  label?: string;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  /**
   * The smaller, secondary form — *Log rewatch*, where the reader's score is the emphasis
   * and this is the way into another viewing (Cinematic Editorial brief, §2). Visually
   * 36pt with a quieter label; the touch target stays 44pt through its slop. Absent
   * everywhere else, so every other Rank is unchanged.
   */
  compact?: boolean;
  /**
   * **The label is never cut** (UI cohesion pass, 2026-11-06): the control may take the
   * whole width of its row, and the icons wrap under it instead — the rule this control
   * already follows on artwork. For the immersive page's floating card, which is wide
   * enough for it; the original page's narrow identity column keeps its ceiling.
   */
  unclamped?: boolean;
};

export type IconAction = {
  accessibilityLabel: string;
  onPress: () => void;
  selected?: boolean;
  disabled?: boolean;
};

export type TitleActionsProps = {
  /** Present for every kind since 2026-11-14 (a whole show is rankable in its own pool). */
  rank: RankAction | null;
  /** The watchlist bookmark. Every kind of title has one, and it stays one tap. */
  save: IconAction;
  /**
   * **Recommend, back on the row** (founder's review of the live build, 2026-11-21): the
   * paper plane, between the bookmark and the ⋯, opening the Recommend sheet — where
   * Share off bingd also lives. The pre-#350 control unchanged: label, haptic, pulse on
   * every press (sending is always an addition) and style. Null hides it.
   */
  recommend?: IconAction | null;
  /**
   * **The page's ⋯, last on the row** (title actions menu, 2026-11-21). It used to be the
   * top bar's right-hand control; the bar keeps Back alone. Every title has it, because
   * Add to list applies to every movie, season and whole show. Never selected, and it
   * opens a menu rather than adding anything, so it takes the press and the haptic but
   * not the bookmark's pulse.
   */
  more: IconAction;
  /**
   * `paper`, the default, is the original page: Ink glyphs on Paper. `artwork` is the
   * immersive page, where the cluster sits on the darkened artwork and the same
   * controls draw in Parchment. Nothing else about them changes.
   */
  tone?: 'paper' | 'artwork';
};

/**
 * **`[ ★ Rank Movie ] [ 🔖 ] [ ➤ ] [ ⋯ ]`, or `[ ↻ Log rewatch ] [ 🔖 ] [ ➤ ] [ ⋯ ]` once
 * ranked — one compact cluster, and one design at every width.**
 *
 * ---------------------------------------------------------------------------
 * FOUR CONTROLS (founder's review of the live build, 2026-11-21)
 *
 * The labelled rank control, the one-tap watchlist bookmark, Recommend's paper plane, and
 * the page's ⋯, in that order. #350 had taken Recommend into the menu; it is back on the
 * row, opening the Recommend sheet where Share off bingd also lives. Add to List stays in
 * the ⋯, which holds Add to list, one *Edit ranking / Add note* door into the existing log
 * sheet, and Remove from collection (`app/title/[id].tsx`). The ⋯ stays off the top bar.
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
 * in this app and in every other; a paper plane beside it is not ambiguous once the thing
 * beside it says Rank; and a ⋯ is a menu on every platform. Each keeps its full spoken
 * name, which is where a screen reader gets it, and each clears 44pt through its own box
 * rather than through slop, so the cluster's height is the target's height.
 *
 * Unranked draws filled Maroon — it is an invitation, and the page's one primary action.
 * Ranked draws outlined — it is a fact you may edit. That pair is the app's standing
 * button hierarchy (design-system.md §8) and is unchanged from before this redesign.
 */
export function TitleActions({
  rank,
  save,
  recommend = null,
  more,
  tone = 'paper',
}: TitleActionsProps) {
  const { fontScale } = useWindowDimensions();
  /**
   * **The page's primary act gives under a thumb** (founder premium pass, 2026-09-08).
   *
   * Rank is the button the whole title page is arranged around, and Log rewatch is the
   * door into another viewing. The two icon controls beside it take the same treatment
   * through `IconControl`, so the cluster answers a thumb as one surface rather than as
   * one animated control standing next to two that do not move.
   */
  const rankPress = usePressScale();
  const onArtwork = tone === 'artwork';

  return (
    <View testID="title-actions" style={styles.cluster}>
      {rank ? (
        <Animated.View style={[styles.rankWrap, rankPress.pressStyle]}>
          <Pressable
            testID={rank.ranked ? 'title-action-ranked' : 'title-action-rank'}
            accessibilityRole="button"
            accessibilityState={{ selected: rank.ranked }}
            accessibilityLabel={rank.accessibilityLabel}
            accessibilityHint={rank.accessibilityHint}
            onPress={rank.onPress}
            onPressIn={rankPress.onPressIn}
            onPressOut={rankPress.onPressOut}
            // The filled Rank is drawn short and takes the slop that returns it to 44pt; the
            // compact rewatch keeps its own; the outlined Ranked is drawn at 44 and needs none.
            hitSlop={rank.compact ? { top: 4, bottom: 4 } : !rank.ranked ? RANK_SLOP : undefined}
            style={({ pressed }) => [
              styles.rank,
              rank.ranked ? (onArtwork ? styles.rankedOnArtwork : styles.ranked) : styles.unranked,
              // On the artwork the label is never truncated: the icons wrap instead.
              (onArtwork || rank.unclamped) && styles.rankOnArtwork,
              rank.compact && styles.rankCompact,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name={rank.icon ?? (rank.ranked ? 'checkmark-circle' : 'star-outline')}
              size={theme.layout.icon.sm}
              color={
                rank.ranked
                  ? onArtwork
                    ? brand.parchment
                    : theme.semantic.action
                  : theme.semantic.actionText
              }
            />
            {/* One line, always, and never cut: past `RANK_LABEL_MAX_SCALE` the word fits
              itself to the row instead (2026-11-14). A two-line `Rank Season` is a control
              that has changed shape rather than a label that has grown, and a wrapped
              cluster is two rows where the founder asked for one. */}
            <Text
              variant={rank.compact ? 'subhead' : 'headline'}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={rankLabelMinimumScale(fontScale)}
              maxFontSizeMultiplier={RANK_LABEL_MAX_SCALE}
              style={styles.rankLabel}
              testID="title-action-rank-label"
              tone={rank.ranked && !onArtwork ? 'action' : 'inverse'}
            >
              {rank.label ?? (rank.ranked ? 'Ranked' : 'Rank')}
            </Text>
          </Pressable>
        </Animated.View>
      ) : null}

      <IconControl
        onArtwork={onArtwork}
        testID="title-action-save"
        icon={save.selected ? 'bookmark' : 'bookmark-outline'}
        action={save}
      />

      {recommend ? (
        <IconControl
          onArtwork={onArtwork}
          testID="title-action-recommend"
          icon="paper-plane-outline"
          action={recommend}
        />
      ) : null}

      <IconControl
        onArtwork={onArtwork}
        testID="title-action-more"
        icon="ellipsis-horizontal"
        action={more}
        pulse={false}
      />
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
  pulse = true,
  onArtwork = false,
}: {
  onArtwork?: boolean;
  testID: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  action: IconAction;
  /** Whether a press that turns the control on pulses. False for the ⋯, which opens a menu. */
  pulse?: boolean;
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
         * The bookmark and Recommend are the reader saving or sending, which is the
         * `selection` class in `ui/haptics.ts`: light, and the same word every other
         * bookmark in the app now speaks. The ⋯ takes the same light tick.
         *
         * The pulse fires only when the control is turning *on*. `action.selected` is the
         * state before the press, so `!action.selected` is the press that adds something —
         * and un-saving gets no celebration, because a flourish for undoing is the app
         * disagreeing with the reader. Recommend has no selected state, so it pulses on
         * every press, which is correct: sending is always an addition. The ⋯ passes
         * `pulse={false}`: opening a menu adds nothing.
         */
        onPress={() => {
          hapticSelection();
          if (pulse && !action.selected) pop.pulse();
          action.onPress();
        }}
        disabled={action.disabled}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        hitSlop={{ left: 6, right: 6 }}
        style={({ pressed }) => [styles.icon, pressed && styles.pressed]}
      >
        <Animated.View style={pop.pulseStyle}>
          <Ionicons
            name={icon}
            size={theme.layout.icon.md}
            // Maroon when held, neutral otherwise — the app's one selected-control treatment,
            // the same pair the feed row and the search row draw.
            color={
              onArtwork
                ? brand.parchment
                : action.selected
                  ? theme.semantic.action
                  : theme.text.secondary
            }
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
  /**
   * **One row, at every width and text size** (TV show & season ranking, 2026-11-14):
   * Rank / Log rewatch · Watchlist · Recommend · ⋯ (2026-11-21). The icons keep their fixed
   * boxes, so their targets never shrink; the labelled control is the one that gives,
   * by fitting its word (above), never by pushing a glyph onto a second line.
   */
  cluster: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    columnGap: theme.space[1],
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
     * **No `minWidth` here, and the reason is worth keeping.**
     *
     * `Rank` and `Ranked` are two characters apart, so the content-sized control grows
     * when a ranking lands and carries the bookmark and recommend glyphs a step right.
     * The obvious fix — a floor at the wider label's width, 132 — was written and then
     * removed, because it overflows: this row lives in the identity column beside the
     * poster, not across the screen, and that column is about 164pt on a 320pt phone and
     * 219pt on a 375. A 132 floor plus two 44pt glyphs plus their gaps needs 236pt, so
     * the floor would push the icons under the poster or off the edge on every phone
     * narrower than about 393pt.
     *
     * `flexShrink: 1` is load-bearing precisely because of that: `Ranked` already gives
     * width back on a narrow column, which is what keeps the row inside it. A floor takes
     * that away. Removing the sideways twitch needs the icons anchored to the column's
     * trailing edge, or a label pair of equal length — both changes to an approved layout
     * rather than a defect fix, so neither is taken here.
     */
    maxWidth: theme.layout.control.inlineButtonMaxWidth,
    // Trimmed with the fourth control so `Ranked` and three icons share one line at 375pt.
    paddingHorizontal: theme.space[3],
    marginRight: theme.space[1],
    borderRadius: theme.radius.control,
  },
  /** Filled Maroon, drawn at {@link RANK_VISIBLE_HEIGHT}; `RANK_SLOP` keeps the 44pt target. */
  unranked: { backgroundColor: theme.semantic.action, minHeight: RANK_VISIBLE_HEIGHT },
  ranked: {
    backgroundColor: theme.surface.raised,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.semantic.action,
  },
  /** Log rewatch on the artwork: a quiet outline, so Rank stays the only filled control. */
  rankedOnArtwork: {
    backgroundColor: paperAlpha(0.08),
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: paperAlpha(0.5),
  },
  // On the artwork card the control may take the whole row, but it still gives width back
  // to the icons beside it: they stay on this line (2026-11-14).
  rankOnArtwork: { flexShrink: 1, maxWidth: '100%' },
  rankLabel: { flexShrink: 1 },
  /** The press-scale wrapper gives width back with the control inside it. */
  rankWrap: { flexShrink: 1, minWidth: 0 },
  rankCompact: {
    minHeight: theme.layout.minTapTarget - 8,
    paddingHorizontal: theme.space[2] + 2,
    gap: theme.space[1] + 2,
  },
  // 32pt boxes with a 6pt hitSlop each side, so every glyph still clears the 44pt target.
  icon: {
    width: ICON_BOX,
    height: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
});
