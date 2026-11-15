import { fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { theme } from '../tokens';
import { Disclosure } from './Disclosure';
import { Text } from './Text';

/**
 * The inline disclosure (IMP1113-UI, H2 row 2): closed until asked, a button with an
 * expanded state, its content after it in reading order, and a label that wraps.
 */
const draw = (props: Partial<Parameters<typeof Disclosure>[0]> = {}) =>
  renderWithProviders(
    <Disclosure label="Need help getting the file?" testID="help" {...props}>
      <Text>Step one</Text>
    </Disclosure>,
  );

describe('Disclosure', () => {
  it('is collapsed by default, with nothing of its content drawn', async () => {
    const view = await draw();
    expect(
      view.getByRole('button', { name: 'Need help getting the file?', expanded: false }),
    ).toBeTruthy();
    expect(view.queryByText('Step one')).toBeNull();
  });

  it('opens and closes on press, saying so in its state', async () => {
    const onToggle = jest.fn();
    const view = await draw({ onToggle });
    await fireEvent.press(view.getByRole('button', { name: 'Need help getting the file?' }));
    expect(
      view.getByRole('button', { name: 'Need help getting the file?', expanded: true }),
    ).toBeTruthy();
    expect(view.getByText('Step one')).toBeTruthy();
    await fireEvent.press(view.getByRole('button', { name: 'Need help getting the file?' }));
    expect(view.queryByText('Step one')).toBeNull();
    expect(onToggle.mock.calls).toEqual([[true], [false]]);
  });

  it('puts its content after the control, in the same tree, not in a modal', async () => {
    const view = await draw();
    await fireEvent.press(view.getByTestId('help-toggle'));
    const root = view.getByTestId('help');
    const children = root.children as unknown[];
    expect(children.indexOf(view.getByTestId('help-toggle'))).toBe(0);
    expect(children.indexOf(view.getByTestId('help-content'))).toBe(1);
  });

  it('speaks a trailing value after the label', async () => {
    const view = await draw({ label: 'Unmatched', trailing: '8', trailingLabel: '8 titles' });
    expect(view.getByRole('button', { name: 'Unmatched, 8 titles' })).toBeTruthy();
    expect(view.getByText('8')).toBeTruthy();
  });

  it('wraps its label at large text and keeps a 44pt target by its own box', async () => {
    const view = await draw({ label: 'A very long question that has to wrap at 200% text' });
    const label = view.getByText('A very long question that has to wrap at 200% text');
    expect(label.props.numberOfLines).toBeUndefined();
    expect(label.props.adjustsFontSizeToFit).toBeUndefined();
    expect(StyleSheet.flatten(label.props.style)).toMatchObject({ flexShrink: 1 });
    const toggle = view.getByTestId('help-toggle');
    expect(StyleSheet.flatten(toggle.props.style)).toMatchObject({
      minHeight: theme.layout.minTapTarget,
    });
    expect(toggle.props.hitSlop).toBeUndefined();
  });
});
