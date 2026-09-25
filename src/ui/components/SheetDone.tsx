import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';
import { useStableBottomInset } from './use-stable-bottom-inset';

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
 * THE PART THAT IS NOT DECORATION
 *
 * **It sits above the Android navigation bar**, which is the bug it was built for: two of
 * these sheets put their Done within a thumb's width of the system Back control, and one
 * had no Done at all. The padding is the stable inset plus the app's ordinary spacing —
 * *plus*, not *instead of*, because an inset alone leaves the words touching the system
 * bar on a gesture-navigation device where the inset is small.
 *
 * `useStableBottomInset` rather than the live one, for the reason `Screen` uses it: the
 * live inset moves when a keyboard opens, and a sheet that resizes under a reader is the
 * defect that fix exists to prevent. On iOS the inset already covers the home indicator,
 * so the extra spacing is the only difference and there is no wasted band.
 *
 * The row is a full-width tap target rather than a word with `hitSlop`: Android clips
 * touches outside a parent's box, so slop on a text node is a target that measures
 * generously on iOS and taps at the glyph on Android.
 */
export function SheetDone({
  onPress,
  label = 'Done',
}: {
  onPress: () => void;
  /** Overridable for a sheet whose way out is worded differently. */
  label?: string;
}) {
  const bottomInset = useStableBottomInset();

  return (
    <View style={[styles.foot, { paddingBottom: bottomInset + theme.space[3] }]}>
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
  foot: {
    paddingTop: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    alignItems: 'center',
  },
  press: {
    minHeight: theme.layout.minTapTarget,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
});
