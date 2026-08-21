import { render } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';

import { Sheet } from './Sheet';

const mockInsets = { top: 47, bottom: 34, left: 0, right: 0 };

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
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
 * This is one primitive and eleven consumers, and the founder found the same defect on
 * two of them — Collection Filters and Bingd Awards, which are the two whose last
 * element is a button rather than a list. A bottom safe area alone pads by the inset and
 * by nothing else, so on any display reporting no bottom inset the buttons finish flush
 * against the edge of the sheet.
 */
describe('the bottom edge', () => {
  it('clears an iPhone home indicator', async () => {
    expect(await bottomPaddingOf()).toBe(34);
  });

  it('keeps a gutter where the system reports no inset at all', async () => {
    // Android with three-button navigation, an older phone, a simulator. This is the
    // case the founder photographed: real device, real zero, buttons on the edge.
    mockInsets.bottom = 0;
    expect(await bottomPaddingOf()).toBe(16);
  });

  it('does not add the gutter on top of a large inset', async () => {
    // `Math.max`, not a sum. The indicator's inset is already breathing room, and
    // adding a gutter to it would lift the footer off a modern iPhone for no reason.
    mockInsets.bottom = 48;
    expect(await bottomPaddingOf()).toBe(48);
  });

  it('takes the gutter when an Android inset is smaller than one', async () => {
    // Gesture navigation reports a real but small inset. Neither value is wrong; the
    // larger one is the one the design asks for.
    mockInsets.bottom = 12;
    expect(await bottomPaddingOf()).toBe(16);
  });
});
