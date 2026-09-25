import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { MiniButton } from './MiniButton';

/**
 * **The way out of a utility sheet** (founder, device QA, 2026-09-25).
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT A PRIMARY BUTTON
 *
 * These sheets — Where to watch, bingd Awards, a sitting's ranked titles — are
 * *statements*. Nothing in them is a decision, and the only thing to do with one is stop
 * reading it. A filled Maroon `Button` is the app's strongest call to action, and spending
 * it on "I have finished looking at this" made the least consequential control on the
 * screen the loudest thing on it.
 *
 * ---------------------------------------------------------------------------
 * AND WHY IT IS NOT BARE WORDS EITHER
 *
 * That was the previous version, and the founder's verdict on a device was that it looked
 * **detached**: maroon text with no container floats at the foot of a sheet instead of
 * sitting there, and nothing says how much of it you may press. So it is `MiniButton` now
 * — the quietest container the design system has, shrunk to its label, centred — and the
 * same primitive `+ New list` uses, which is the founder's one visual language for a small
 * optional act beside content that is the real subject.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT SITS, AND WHY IT ADDS NO INSET
 *
 * Its first version paid the device's bottom inset here, on top of the inset `Sheet`
 * already pays on the sheet body — so on a phone reporting a 48pt navigation bar the band
 * under one word measured about 108pt, an empty region held open for a single control.
 * **`Sheet` owns a sheet's bottom clearance and this owns none.** It follows its content:
 * no spacer, no `marginTop: 'auto'`, no reserved footer, so a short sheet ends where its
 * content ends with the button under it.
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
      <MiniButton label={label} onPress={onPress} />
    </View>
  );
}

const styles = StyleSheet.create({
  foot: {
    paddingTop: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
  },
});
