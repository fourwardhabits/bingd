import type { ReactNode } from 'react';
import { PixelRatio, StyleSheet, View, useWindowDimensions } from 'react-native';

import { Button } from '@/ui/components';
import { theme } from '@/ui/tokens';

export type ProfileActionsProps = {
  onShare: () => void;
  /**
   * The act that sits beside Share, and the one thing in this row that depends on who
   * is looking.
   *
   * `Invite friends` on the owner's own profile; the relationship — Follow, Following,
   * Requested, Unblock — on somebody else's. Those are the same act pointed at the two
   * populations a profile has, and neither one is available on the other's page:
   * inviting people "from" another person's profile would be a sentence with the wrong
   * subject, and nobody follows themselves.
   *
   * Which leaves one case with no trailing act at all — `/u/<your own handle>`, which
   * resolves to the visitor screen showing your own profile. Absent, Share takes the
   * whole row rather than half of it and a dangling gap.
   *
   * **A node, not a variant.** A caller that renders `null` here still occupies the
   * slot, so the *decision* to leave it empty has to be made by the caller passing
   * nothing. That is the trade for a slot the row has no opinion about.
   */
  trailing?: ReactNode;
};

/**
 * `[ Share Profile ] [ Invite friends ]` — the profile's header actions, one row.
 *
 * **Why it is a component and not a pattern.** The two profile screens each drew this
 * row themselves and drifted exactly the way two copies of anything drift: one filled a
 * button in Maroon that the other outlined in grey, so the same object wore two
 * treatments one tap apart. The parity rule this holds to — looking at somebody else
 * should feel like looking at your own profile — is not something two call sites can
 * keep by agreement.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY THE PAIR IS NO LONGER SHARE + AWARDS
 *
 * The row was `[ Share Profile ] [ bingd. Awards ]`, with Invite friends full width
 * underneath. Awards has a **section** on the profile now — three slots, above Goals,
 * with its own See all into the same sheet this button used to open (`ProfileAwards`).
 * A button whose only job is to open a surface already on the page is a duplicate
 * affordance, and it was occupying the more valuable of the two positions.
 *
 * So Invite friends comes up out of the third row and takes the slot. That is the
 * founder's decision and it is also the honest hierarchy: **Share Profile is what you
 * do with people who are already here, Invite friends is how anybody new arrives**, and
 * on an app with no users yet the second is the more valuable act.
 *
 * **Invite takes the fill and Share takes the outline.** One filled control per row —
 * the fill is the only thing on a profile competing with the poster wall below it, so
 * it is spent on the growth act rather than on the one people already know how to find.
 * Share is `secondary`, which is a real button and not a de-emphasised one.
 *
 * ---------------------------------------------------------------------------
 * AND WHY THE RELATIONSHIP IS IN THE TRAILING HALF
 *
 * `[ Share Profile ] [ Follow / Following / Requested ]` is what somebody else's
 * profile draws — the same row, the same two halves, the same fill on the trailing act.
 *
 * It was Share full width with Follow full width underneath, which is where the
 * founder's device pass landed: *viewing another user's profile does not feel like
 * viewing your own*. The two screens shared this row already; what they did not share
 * was the number of rows, so a visitor's action area was two stacked bars against one
 * split bar on their own page. **Self and other are a permission difference, not a
 * geometry difference** — the trailing half is precisely where the permission lives,
 * and both screens now have exactly one action row.
 *
 * The fill lands on the trailing act on both, and for the same reason: Invite friends
 * is how somebody new arrives, Follow is how this reader arrives at *this person*.
 * `Following` and `Requested` give up the fill and keep the Maroon as an outline, which
 * is the state change reading as a state change — `FollowControl` has that argument.
 * ---------------------------------------------------------------------------
 *
 * **`fit` is load-bearing rather than defensive.** A two-word label in half of a gutter
 * row is about 162pt at `md`, and half of a 320pt screen is 140 — so on the narrow
 * phones this app supports, and on any phone at a raised Dynamic Type size, a label
 * wrapped and its button grew to two lines beside a one-line neighbour. `Button`'s own
 * note has the arithmetic.
 */
/**
 * **One above the other at a large system text size** (Visual 2.1 check, 2026-11-03).
 *
 * `fit` lets a label shrink to 85% to stay on one line in its half, and below that it
 * truncates. At 130% on a 320pt phone, and at 200% everywhere, "Invite friends" does not
 * fit its half even at 85%, so the pair stacks: each button full width, its label whole.
 * Nothing can measure text before it is drawn, so this estimates the longest label this
 * row carries ("Invite friends", 14 characters) at about 0.48em of the 17pt headline,
 * which errs towards stacking. At 100% the row is unchanged on every supported width.
 */
const LONGEST_LABEL = 14;
const HEADLINE_CHAR = 17 * 0.48;
const FIT_FLOOR = 0.85;
const FIT_PADDING = theme.space[3] * 2;

export const stackProfileActions = (width: number, fontScale: number) => {
  const half = (width - theme.layout.gutter * 2 - theme.space[2]) / 2;
  return LONGEST_LABEL * HEADLINE_CHAR * fontScale * FIT_FLOOR + FIT_PADDING > half;
};

export function ProfileActions({ onShare, trailing }: ProfileActionsProps) {
  // `useWindowDimensions` re-renders this when the width or the text size changes.
  const { width } = useWindowDimensions();
  const stacked = Boolean(trailing) && stackProfileActions(width, PixelRatio.getFontScale());
  return (
    <View style={stacked ? styles.column : styles.row} testID="profile-actions">
      <View style={stacked ? null : styles.half}>
        <Button label="Share Profile" kind="secondary" fit onPress={onShare} />
      </View>
      {trailing ? <View style={stacked ? null : styles.half}>{trailing}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Two equal halves rather than one button and a chip: they are different kinds of
  // thing, and equal weight is what stops the fill reading as the only real control.
  row: { flexDirection: 'row', gap: theme.space[2] },
  // Stacked, the two keep equal weight by being equally wide.
  column: { gap: theme.space[2] },
  half: { flex: 1 },
});
