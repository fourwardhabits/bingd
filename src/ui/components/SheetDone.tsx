import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

/**
 * **The way out of a utility sheet** (founder, device QA, 2026-09-25).
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT A BUTTON
 *
 * These sheets — Where to watch, bingd Awards, a sitting's ranked titles — are
 * *statements*. Nothing in them is a decision, and the only thing to do with one is stop
 * reading it. A filled Maroon `Button` is the app's strongest call to action, and
 * spending it on "I have finished looking at this" made the least consequential control
 * on the screen the loudest thing on it.
 *
 * So: Maroon words, no fill, at the same weight as *New list* — which is the existing
 * treatment for an action that is available rather than urged. No icon: a plus belongs to
 * a control that creates something, and this ends something.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT SITS, AND WHY IT ADDS NO INSET OF ITS OWN
 *
 * Its first version paid the device's bottom inset here, on top of the inset `Sheet`
 * already pays on the sheet body — so on a phone reporting a 48pt navigation bar the band
 * under the word measured about 108pt, which is what the founder saw in bingd Awards as
 * an empty region held open for one word. **`Sheet` owns a sheet's bottom clearance and
 * this owns none**, which is also why there is exactly one place to change it.
 *
 * Right-aligned rather than centred (founder, 2026-09-25). A centred word reads as the
 * screen's subject; against the right edge it reads as the way out, which is what it is
 * and where every other dismissal in the app already lives.
 *
 * The target is a box rather than a word with `hitSlop`: Android clips touches outside a
 * parent's box, so slop on a text node measures generously on iOS and taps at the glyph
 * on Android. It is `minTapTarget` square with the gutter's padding, not a full-width
 * row — a right-aligned control whose target spans the sheet would swallow taps meant for
 * the content beside it.
 */
export function SheetDone({
  onPress,
  label = 'Done',
}: {
  onPress: () => void;
  /** Overridable for a sheet whose way out is worded differently. */
  label?: string;
}) {
  return (
    <View style={styles.foot} testID="sheet-done">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({ pressed }) => [styles.press, pressed && styles.pressed]}
      >
        <Text variant="callout" tone="action">
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * It follows the content rather than being held apart from it: no `marginTop: 'auto'`,
   * no spacer, and no bottom padding — the sheet's own gutter is already below this. A
   * short sheet ends where its content ends, with the word under it.
   */
  foot: {
    paddingTop: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    alignItems: 'flex-end',
  },
  press: {
    minHeight: theme.layout.minTapTarget,
    minWidth: theme.layout.minTapTarget,
    paddingHorizontal: theme.space[2],
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
});
