import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/ui/components';
import { theme } from '@/ui/tokens';

export type ProfileActionsProps = {
  onShare: () => void;
  /**
   * The act that sits beside Share, and the one thing in this row that depends on who
   * is looking.
   *
   * `Invite friends` on the owner's own profile; nothing at all on somebody else's,
   * where inviting people "from" another person's page would be a sentence with the
   * wrong subject. Absent, Share takes the whole row rather than half of it and a
   * dangling gap.
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
 * On somebody else's profile the trailing slot is empty and Follow keeps the full-width
 * row underneath, which is the louder of the two positions and where the relationship
 * control belongs.
 * ---------------------------------------------------------------------------
 *
 * **`fit` is load-bearing rather than defensive.** A two-word label in half of a gutter
 * row is about 162pt at `md`, and half of a 320pt screen is 140 — so on the narrow
 * phones this app supports, and on any phone at a raised Dynamic Type size, a label
 * wrapped and its button grew to two lines beside a one-line neighbour. `Button`'s own
 * note has the arithmetic.
 */
export function ProfileActions({ onShare, trailing }: ProfileActionsProps) {
  return (
    <View style={styles.row}>
      <View style={styles.half}>
        <Button label="Share Profile" kind="secondary" fit onPress={onShare} />
      </View>
      {trailing ? <View style={styles.half}>{trailing}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Two equal halves rather than one button and a chip: they are different kinds of
  // thing, and equal weight is what stops the fill reading as the only real control.
  row: { flexDirection: 'row', gap: theme.space[2] },
  half: { flex: 1 },
});
