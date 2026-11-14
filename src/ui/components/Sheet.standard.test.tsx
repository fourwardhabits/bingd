import { act, render } from '@testing-library/react-native';
import { Dimensions, Keyboard, ScrollView, StyleSheet, Text as RNText, TextInput, View } from 'react-native';

import { DismissFooter } from './DismissFooter';
import { STANDARD_SHEET_FRACTION, Sheet, useStandardSheetHeight } from './Sheet';

/**
 * **The standard browsing sheet** (FU1113-B, B7): a fixed 80% of the usable window height
 * whatever the content, a stable header, a scrolling body, and Close pinned below it.
 */
const mockInsets = { top: 47, bottom: 34, left: 0, right: 0 };

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
  initialWindowMetrics: undefined,
}));

// Every listener per event: more than one hook in a sheet listens to the keyboard.
const listeners = new Map<string, ((payload: unknown) => void)[]>();
beforeEach(() => {
  mockInsets.top = 47;
  mockInsets.bottom = 34;
  listeners.clear();
  jest
    .spyOn(Keyboard, 'addListener')
    .mockImplementation(((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return {
        remove: () => listeners.set(event, (listeners.get(event) ?? []).filter((one) => one !== listener)),
      } as unknown as ReturnType<typeof Keyboard.addListener>;
    }) as unknown as typeof Keyboard.addListener);
});
afterEach(() => jest.restoreAllMocks());

const keyboard = (height: number) =>
  act(async () => {
    const name = ['keyboardWillShow', 'keyboardDidShow'].find((one) => listeners.has(one));
    for (const listener of listeners.get(name!) ?? []) listener({ endCoordinates: { height } });
  });

const usable = () => Dimensions.get('window').height - mockInsets.top;

const rows = (count: number) => Array.from({ length: count }, (_, n) => `Row ${n + 1}`);

const draw = (count: number, extra?: React.ReactNode) =>
  render(
    <Sheet
      visible
      onClose={() => {}}
      label="A list"
      size="standard"
      footer={<DismissFooter onPress={() => {}} />}
    >
      <View testID="header">
        <RNText>Heading</RNText>
      </View>
      <ScrollView testID="list" style={{ flex: 1 }}>
        {rows(count).map((row) => (
          <RNText key={row}>{row}</RNText>
        ))}
      </ScrollView>
      {extra}
    </Sheet>,
  );

const bodyStyle = (view: Awaited<ReturnType<typeof draw>>) =>
  StyleSheet.flatten(view.getByTestId('sheet-body').props.style);

describe('the standard sheet height', () => {
  it('is 80% of the window below the top safe-area inset', async () => {
    expect(STANDARD_SHEET_FRACTION).toBe(0.8);
    let height = 0;
    function Probe() {
      height = useStandardSheetHeight();
      return null;
    }
    await render(<Probe />);
    expect(height).toBe(Math.round(0.8 * usable()));
  });

  it.each([
    ['a short list', 3],
    ['a long list', 300],
  ])('is the same fixed height for %s', async (_, count) => {
    const view = await draw(count);
    expect(bodyStyle(view).height).toBe(Math.round(0.8 * usable()));
    // The content flexes to whatever the header and footer leave.
    expect(StyleSheet.flatten(view.getByTestId('sheet-content').props.style)).toMatchObject({
      flex: 1,
      minHeight: 0,
    });
  });

  it('follows the inset: a taller status area leaves a shorter sheet', async () => {
    mockInsets.top = 0;
    const flat = bodyStyle(await draw(3)).height;
    mockInsets.top = 59;
    const notched = bodyStyle(await draw(3)).height;
    expect(flat).toBeGreaterThan(notched as number);
  });

  it('leaves a content-sized sheet exactly as it was', async () => {
    const view = await render(
      <Sheet visible onClose={() => {}} label="Small">
        <View testID="marker" />
      </Sheet>,
    );
    const body = bodyStyle(view);
    expect(body.height).toBeUndefined();
    expect(body.maxHeight).toBe('90%');
    expect(view.queryByTestId('sheet-content')).toBeNull();
  });
});

describe('the standard sheet layout', () => {
  it('keeps the header above the scroll region and every row, the last included, inside it', async () => {
    const view = await draw(300);
    const list = view.getByTestId('list');
    let node = view.getByText('Row 300').parent;
    while (node && node !== list) node = node.parent;
    expect(node).toBe(list);
    // The header is the content's first child, not inside the list.
    let header = view.getByTestId('header').parent;
    while (header && header !== list) header = header.parent;
    expect(header).toBeNull();
  });

  it('pins Close after the content and outside the scroll', async () => {
    const view = await draw(300);
    const body = view.getByTestId('sheet-body');
    const order = (body.children as { props?: { testID?: string } }[]).map((c) => c.props?.testID);
    expect(order.indexOf('sheet-footer')).toBeGreaterThan(order.indexOf('sheet-content'));
    const close = view.getByRole('button', { name: 'Close' });
    let node = close.parent;
    while (node) {
      expect(node).not.toBe(view.getByTestId('list'));
      node = node.parent;
    }
    // The sheet pays the bottom inset under the footer, once.
    expect(bodyStyle(view).paddingBottom).toBe(34);
  });

  it('with the keyboard open, lifts the sheet and lets it shrink so the footer stays visible', async () => {
    const view = await draw(300, <TextInput testID="field" />);
    await keyboard(336);
    // The root under the modal: the backdrop's and the body's shared parent.
    const root = view.getByTestId('sheet-body').parent;
    expect(StyleSheet.flatten(root?.props.style).paddingBottom).toBe(336);
    // Fixed height, but never more than 90% of the room the keyboard leaves: `maxHeight`
    // wins over `height`, so the footer and the field are above the keyboard.
    expect(bodyStyle(view).maxHeight).toBe('90%');
    expect(view.getByTestId('sheet-footer')).toBeTruthy();
  });
});

describe('density="dense"', () => {
  it('is an alias of size="standard"', async () => {
    const dense = await render(
      <Sheet visible onClose={() => {}} label="Dense" density="dense">
        <View />
      </Sheet>,
    );
    expect(bodyStyle(dense as never).height).toBe(Math.round(0.8 * usable()));
  });
});
