import { StyleSheet, View } from 'react-native';

import { Button } from '@/ui/components';
import { theme } from '@/ui/tokens';

export type ProfileActionsProps = {
  onShare: () => void;
  onOpenAwards: () => void;
};

/**
 * `[ Share Profile ] [ bingd. Awards ]` — one component, both profiles.
 *
 * **Why it is a component and not a pattern.** The two screens each drew this row
 * themselves, and they drifted exactly the way two copies of anything drift: the
 * owner's filled Awards in Maroon, the other person's outlined it in grey, and the
 * founder's device pass found the same object wearing two treatments one tap apart.
 * The parity rule this pass is holding to — looking at somebody else should feel like
 * looking at your own profile — is not something two call sites can keep by agreement.
 * So the row is the component, and neither screen has an opinion about it.
 *
 * **Awards takes the fill and Share takes the outline**, which is the reverse of what
 * "primary action" would suggest and is the founder's decision. Share is the useful one
 * and Awards is the fun one; a row of two identical outlined buttons says neither, and
 * the fill is the only thing on a profile competing with the poster wall below it, so
 * it is spent on the control that is meant to be tempting rather than on the one people
 * already know how to find. It is the same on both screens because it is the same
 * object read about a different person.
 *
 * **`fit` is load-bearing rather than defensive.** `bingd. Awards` in half of a gutter
 * row is about 162pt at `md`, and half of a 320pt screen is 140 — so on the narrow
 * phones this app supports, and on any phone at a raised Dynamic Type size, the label
 * wrapped and the button grew to two lines beside a one-line Share Profile. `Button`'s
 * own note has the arithmetic. The label is not the thing to change: it is the product
 * name and it is on the sheet the button opens.
 */
export function ProfileActions({ onShare, onOpenAwards }: ProfileActionsProps) {
  return (
    <View style={styles.row}>
      <View style={styles.half}>
        <Button label="Share Profile" kind="secondary" fit onPress={onShare} />
      </View>
      <View style={styles.half}>
        <Button label="bingd. Awards" fit onPress={onOpenAwards} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Two equal halves rather than one button and a chip: they are different kinds of
  // thing, and equal weight is what stops the fill reading as the only real control.
  row: { flexDirection: 'row', gap: theme.space[2] },
  half: { flex: 1 },
});
