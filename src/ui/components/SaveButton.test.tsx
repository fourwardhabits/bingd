import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { theme } from '../tokens';
import { SaveButton } from './SaveButton';

/**
 * The standard Save (founder spec §2A): compact filled Maroon, Parchment label, the slimmer
 * Rank button's height and radius, a 44pt target, and one save per double tap.
 */

const fill = () => StyleSheet.flatten(screen.getByTestId('save-button-fill').props.style);
const target = () => StyleSheet.flatten(screen.getByTestId('save-button').props.style);

describe('SaveButton', () => {
  it('is a filled Maroon control at the Rank button’s visible height and radius', async () => {
    await render(<SaveButton onPress={() => {}} />);

    expect(fill().backgroundColor).toBe(theme.semantic.action);
    expect(fill().minHeight).toBe(theme.layout.control.compactAction.visibleHeight);
    expect(fill().borderRadius).toBe(theme.radius.control);
    expect(fill().paddingHorizontal).toBe(theme.layout.control.compactAction.paddingHorizontal);
    // White-on-Maroon: the label is the inverse ink.
    expect(StyleSheet.flatten(screen.getByText('Save').props.style).color).toBe(
      theme.text.inverse,
    );
  });

  it('keeps the 44pt target on its own box rather than in slop', async () => {
    await render(<SaveButton onPress={() => {}} />);

    expect(target().minHeight).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    expect(target().minWidth).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    expect(screen.getByTestId('save-button').props.hitSlop).toBeUndefined();
  });

  it('is a button with a spoken label, overridable', async () => {
    await render(<SaveButton onPress={() => {}} accessibilityLabel="Save changes" />);

    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('saves on a press', async () => {
    const onPress = jest.fn();
    await render(<SaveButton onPress={onPress} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('treats a double tap as one save, even before the caller re-renders', async () => {
    const onPress = jest.fn();
    await render(<SaveButton onPress={onPress} />);

    const button = screen.getByRole('button', { name: 'Save' });
    await fireEvent.press(button);
    await fireEvent.press(button);

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('accepts a second save once the guard has passed', async () => {
    const now = jest.spyOn(Date, 'now');
    const onPress = jest.fn();
    await render(<SaveButton onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Save' });

    now.mockReturnValue(10_000);
    await fireEvent.press(button);
    now.mockReturnValue(11_000);
    await fireEvent.press(button);

    expect(onPress).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('while saving: says so, is busy and disabled, and ignores presses', async () => {
    const onPress = jest.fn();
    await render(<SaveButton onPress={onPress} saving />);

    const button = screen.getByTestId('save-button');
    expect(screen.getByText('Saving…')).toBeTruthy();
    expect(button.props.accessibilityState).toEqual({ disabled: true, busy: true });

    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('while disabled: dims, explains why, and ignores presses', async () => {
    const onPress = jest.fn();
    await render(
      <SaveButton onPress={onPress} disabled disabledReason="Nothing has changed yet" />,
    );

    const button = screen.getByTestId('save-button');
    expect(button.props.accessibilityState).toEqual({ disabled: true, busy: false });
    expect(button.props.accessibilityHint).toBe('Nothing has changed yet');
    expect(fill().opacity).toBe(0.4);

    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('takes another word where the surface needs one', async () => {
    await render(<SaveButton onPress={() => {}} label="Update" />);
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
  });
});
