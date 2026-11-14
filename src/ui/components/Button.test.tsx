import { render, screen } from '@testing-library/react-native';

import { Button } from './Button';

/**
 * **A caller's accessibility props never drop the button's own** (design-system v3 A.2 #10).
 *
 * `{...rest}` used to be spread after `accessibilityState`/`accessibilityHint`, so a caller
 * that passed either (the ranking reveal's exits, Keep Show) silently replaced the disabled
 * state and its reason.
 */
describe('Button accessibility', () => {
  it('keeps the caller’s hint while enabled', async () => {
    await render(
      <Button
        label="Keep"
        accessibilityHint="Keeps your show's ranking as it is"
        onPress={() => {}}
      />,
    );
    const button = screen.getByRole('button', { name: 'Keep' });

    expect(button.props.accessibilityHint).toBe("Keeps your show's ranking as it is");
    expect(button.props.accessibilityState).toEqual({ disabled: false });
  });

  it('announces the disabled reason over the caller’s hint when disabled', async () => {
    await render(
      <Button
        label="Keep"
        disabled
        disabledReason="Keeping your show score"
        accessibilityHint="Keeps your show's ranking as it is"
        onPress={() => {}}
      />,
    );
    const button = screen.getByRole('button', { name: 'Keep' });

    expect(button.props.accessibilityHint).toBe('Keeping your show score');
    expect(button.props.accessibilityState).toEqual({ disabled: true });
  });

  it('falls back to the caller’s hint when disabled without a reason', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await render(
      <Button label="Keep" disabled accessibilityHint="Caller hint" onPress={() => {}} />,
    );

    expect(screen.getByRole('button', { name: 'Keep' }).props.accessibilityHint).toBe(
      'Caller hint',
    );
    warn.mockRestore();
  });

  it('merges the caller’s state with its own disabled flag', async () => {
    await render(
      <Button
        label="Save"
        disabled
        disabledReason="Saving your changes"
        accessibilityState={{ busy: true, selected: false }}
        onPress={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Save' }).props.accessibilityState).toEqual({
      busy: true,
      selected: false,
      disabled: true,
    });
  });

  it('does not let a caller’s state re-enable a disabled button', async () => {
    await render(
      <Button
        label="Save"
        disabled
        disabledReason="Saving your changes"
        accessibilityState={{ disabled: false }}
        onPress={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Save' }).props.accessibilityState).toEqual({
      disabled: true,
    });
  });
});
