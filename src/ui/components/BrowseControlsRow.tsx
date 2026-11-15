import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';

export type BrowseControlsRowProps = {
  /** The heading or `MediumSelector`. It flexes, and it is what truncates. */
  leading?: ReactNode;
  /** `ViewModeToggle` and `FilterIconButton`. Never wraps, never shrinks. */
  trailing?: ReactNode;
  testID?: string;
};

/**
 * **A browse page's one control row** (FU1113-B): what you are looking at on the left, how
 * you are looking at it on the right.
 *
 *     Movies ▾                              ▦ ☰   ⚙
 *
 * **The trailing controls are fixed and the leading side gives way.** On a 320pt phone at
 * the largest text size the row does not wrap: the trailing group keeps its natural width
 * (every cell in it is a 44pt target, and `flexShrink: 0` keeps them so), and the leading
 * side takes whatever is left and truncates inside it — which is why it has `minWidth: 0`;
 * without it a flex item will not shrink below its content and the row overflows instead.
 *
 * The row sits on the gutters and is at least a tap target tall. It does not draw its
 * contents' spacing; `theme.layout.section` does that around it.
 */
export function BrowseControlsRow({ leading, trailing, testID }: BrowseControlsRowProps) {
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.leading} testID={testID ? `${testID}-leading` : undefined}>
        {leading}
      </View>
      {trailing ? (
        <View style={styles.trailing} testID={testID ? `${testID}-trailing` : undefined}>
          {trailing}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.layout.gutter,
  },
  leading: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  trailing: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    flexShrink: 0,
    flexGrow: 0,
    alignItems: 'center',
    gap: theme.space[1],
  },
});
