import { render } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';

import { Sheet } from './Sheet';

const mockInsets = { top: 47, bottom: 34, left: 0, right: 0 };

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
  initialWindowMetrics: undefined,
}));

beforeEach(() => {
  mockInsets.bottom = 34;
});

/**
 * The padding on the sheet body, reached through a child rather than through a testID
 * added to the source for this test's benefit — the same route `Screen.test` takes.
 *
 * The child's parent is the drag handle's sibling container, which *is* the sheet: the
 * handle and the children are both direct children of it.
 */
const bottomPaddingOf = async () => {
  const view = await render(
    <Sheet visible onClose={() => {}} label="A sheet">
      <View testID="marker" />
    </Sheet>,
  );
  const sheet = view.getByTestId('marker').parent;
  return StyleSheet.flatten(sheet?.props.style).paddingBottom;
};

/**
 * The foot of every sheet in the app.
 *
 * ---------------------------------------------------------------------------
 * **A sum, not a `Math.max`** (founder, physical-device QA, 2026-09-25).
 *
 * This was `Math.max(insets.bottom, theme.space[4])` — the device's inset and the app's
 * own spacing treated as alternatives. On a phone reporting a 48pt navigation bar the
 * larger value wins, so the sheet's last row got 48pt of *system* clearance and **zero**
 * of bingd's spacing: the Recommend / Share off bingd pair finished exactly on the edge
 * of the safe area, hard against the navigation bar. That is what the founder
 * photographed, and every sheet in the app had it.
 *
 * The inset says how much room the hardware takes. The gutter says how much room the
 * design wants. They answer different questions, so they add.
 *
 * This is also the only place a sheet's bottom clearance is decided — `SheetDone` used to
 * add its own on top of this one, and the doubling is what made bingd Awards look like it
 * was holding a region open for one word.
 */
describe('the bottom edge', () => {
  it('clears an iPhone home indicator and still keeps the gutter', async () => {
    expect(await bottomPaddingOf()).toBe(34 + 16);
  });

  it('keeps a gutter where the system reports no inset at all', async () => {
    // An older phone, a simulator, a display with nothing at the bottom.
    mockInsets.bottom = 0;
    expect(await bottomPaddingOf()).toBe(16);
  });

  it('clears Android three-button navigation with the gutter on top', async () => {
    // The regression itself. 48dp is the system bar's own height, which is what a device
    // reports under edge-to-edge; `Math.max` returned exactly that and left the buttons
    // touching it.
    mockInsets.bottom = 48;
    expect(await bottomPaddingOf()).toBe(48 + 16);
  });

  it('clears a gesture-navigation inset, which is real but small', async () => {
    // The case the old rule got closest to right and still got wrong: 12pt of inset is
    // room for the gesture bar and none for the design.
    mockInsets.bottom = 12;
    expect(await bottomPaddingOf()).toBe(12 + 16);
  });

  it('never returns less than the inset the device reported', async () => {
    // The property behind all four: whatever the hardware asks for, the sheet gives it
    // that much and more. A single assertion that cannot be satisfied by a `Math.max`.
    for (const inset of [0, 12, 34, 48, 64]) {
      mockInsets.bottom = inset;
      expect(await bottomPaddingOf()).toBeGreaterThan(inset === 0 ? -1 : inset);
    }
  });
});

