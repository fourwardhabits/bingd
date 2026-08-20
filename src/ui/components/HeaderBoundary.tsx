import { StyleSheet, View } from 'react-native';

import { inkAlpha, theme } from '../tokens';

/**
 * Where a screen's controls stop and its content starts.
 *
 * The founder's device test called Feed and Log "abrupt" at this seam, and the
 * diagnosis is that there was no seam: a header sat directly on a scrolling list,
 * both on Paper, so the first row read as part of the chrome and the chrome read as
 * the first row.
 *
 * A hairline alone is the obvious answer and it is not quite enough — a single line
 * across Paper reads as a rule drawn on the page rather than as depth. So this is a
 * hairline plus three bands of Ink at two to four percent, spending six points in
 * total: enough to say the content passes *under* the controls, not enough to become
 * a bar. It is the same banded technique `TitleHero` uses for its scrim, and for the
 * same reason — a real gradient would mean `expo-linear-gradient`, which is a native
 * module and a new fingerprint for one soft edge.
 *
 * Deliberately not: a filled header, an elevation shadow on the header itself, or a
 * tonal band. All three are the Material app bar the brief rules out, and all three
 * put a horizontal stripe of colour across a design whose whole premise is that the
 * page is one continuous surface with artwork sitting on it.
 */
export function HeaderBoundary() {
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.hairline} />
      {SHADE.map((alpha, index) => (
        <View key={index} style={[styles.band, { backgroundColor: inkAlpha(alpha) }]} />
      ))}
    </View>
  );
}

/**
 * Three bands, halving as they fall away.
 *
 * Four percent is already at the edge of visible on Paper; the point is the
 * *gradient*, not any one band, and a reader should not be able to find the steps.
 */
const SHADE = [0.04, 0.02, 0.01];

const styles = StyleSheet.create({
  hairline: {
    height: StyleSheet.hairlineWidth * 2,
    backgroundColor: theme.border.hairline,
  },
  band: { height: 2 },
});
