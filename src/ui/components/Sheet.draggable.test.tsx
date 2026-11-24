import { fireEvent, render } from '@testing-library/react-native';
import { Pressable, Text, View } from 'react-native';

import { dragOutcome, Sheet, useSheetExpanded } from './Sheet';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
  initialWindowMetrics: undefined,
}));

/**
 * **Swipe to expand and to dismiss** (founder iPhone QA, 2026-11-24), opt-in per sheet.
 *
 * The gesture itself is React Native's own `PanResponder` and needs a device; what is
 * asserted here is the decision a released drag makes, and that every other sheet is the
 * sheet it was.
 */
describe('what a released drag means', () => {
  it('closes a sheet at its content height when pulled down, or flicked down', () => {
    expect(dragOutcome(120, 0, false)).toBe('close');
    expect(dragOutcome(20, 1.2, false)).toBe('close');
  });

  it('collapses an expanded sheet when pulled down, rather than closing it', () => {
    expect(dragOutcome(120, 0, true)).toBe('collapse');
  });

  it('expands when pulled up, and stays put when already expanded', () => {
    expect(dragOutcome(-120, 0, false)).toBe('expand');
    expect(dragOutcome(-10, -1.5, false)).toBe('expand');
    expect(dragOutcome(-120, 0, true)).toBe('stay');
  });

  it('does nothing for a short, slow drag — a tap in the header is still a tap', () => {
    expect(dragOutcome(30, 0.2, false)).toBe('stay');
    expect(dragOutcome(-30, -0.2, true)).toBe('stay');
  });
});

const Probe = () => <Text testID="expanded">{String(useSheetExpanded())}</Text>;

describe('a draggable sheet', () => {
  it('draws its header in the grab area, and its Close works', async () => {
    const onClose = jest.fn();
    const view = await render(
      <Sheet
        visible
        onClose={onClose}
        label="Comments"
        draggable
        header={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close comments"
            onPress={onClose}
          >
            <Text>Comments</Text>
          </Pressable>
        }
      >
        <Probe />
      </Sheet>,
    );

    expect(view.getByTestId('sheet-grab')).toBeTruthy();
    // The content sits in its wrapper from the start, so expanding restyles it and never
    // remounts it — a composer keeps its words through a resize.
    expect(view.getByTestId('expanded').parent?.props.testID).toBe('sheet-content');
    expect(view.getByTestId('expanded').props.children).toBe('false');
    await fireEvent.press(view.getByLabelText('Close comments'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves every other sheet as it was: no grab area, never expanded', async () => {
    const view = await render(
      <Sheet visible onClose={() => {}} label="A sheet">
        <View>
          <Probe />
        </View>
      </Sheet>,
    );
    expect(view.queryByTestId('sheet-grab')).toBeNull();
    expect(view.getByTestId('expanded').props.children).toBe('false');
  });
});
