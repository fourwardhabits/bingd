import { fireEvent } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { Field } from './Field';

/**
 * The password reveal (founder, 2026-09-22). Everything here is about one field: the eye
 * exists only when the caller asked for a secure field, it starts hidden, and toggling it
 * changes nothing but `secureTextEntry` on the same input — the value is not re-entered,
 * re-mounted or copied into a second field.
 */

it('has no reveal on an ordinary field', async () => {
  const view = await renderWithProviders(<Field label="Email" value="sai@example.com" />);
  expect(view.queryByLabelText('Show email')).toBeNull();
  expect(view.getByLabelText('Email').props.secureTextEntry).toBeFalsy();
});

it('starts hidden and offers to show it', async () => {
  const view = await renderWithProviders(<Field label="Password" secureTextEntry value="hunter2" />);
  expect(view.getByLabelText('Password').props.secureTextEntry).toBe(true);
  expect(view.getByLabelText('Show password')).toBeTruthy();
});

it('reveals the same input, keeping its value', async () => {
  const view = await renderWithProviders(<Field label="Password" secureTextEntry value="hunter2" />);

  await fireEvent.press(view.getByLabelText('Show password'));

  const input = view.getByLabelText('Password');
  expect(input.props.secureTextEntry).toBe(false);
  expect(input.props.value).toBe('hunter2');
  expect(view.getByLabelText('Hide password')).toBeTruthy();
});

it('hides it again', async () => {
  const view = await renderWithProviders(<Field label="Password" secureTextEntry value="hunter2" />);
  await fireEvent.press(view.getByLabelText('Show password'));
  // A second press is a second element (the label changed), so this is not the RNTL
  // double-press trap.
  await fireEvent.press(view.getByLabelText('Hide password'));
  expect(view.getByLabelText('Password').props.secureTextEntry).toBe(true);
});

/**
 * **An error is spoken once** (design-system v3 A.2 #26). It was in the input's label, again
 * as its hint, and a third time from the caption under it. It stays in the label; the hint is
 * the hint only when there is no error; the caption is drawn and hidden from the a11y tree.
 */
describe('the error and hint, to a screen reader', () => {
  it('says the error in the label only, and hides the caption that draws it', async () => {
    const view = await renderWithProviders(
      <Field label="Username" hint="Letters and numbers" error="That username is taken" />,
    );

    const input = view.getByLabelText('Username');
    expect(input.props.accessibilityLabel).toBe('Username. That username is taken');
    expect(input.props.accessibilityHint).toBeUndefined();

    // Drawn for sighted readers, but not an element a screen reader stops on.
    expect(view.queryByText('That username is taken')).toBeNull();
    const caption = view.getByText('That username is taken', { includeHiddenElements: true });
    expect(caption.props.accessibilityElementsHidden).toBe(true);
    expect(caption.props.importantForAccessibility).toBe('no');
  });

  it('gives the hint as the input’s hint when there is no error, and hides its caption', async () => {
    const view = await renderWithProviders(
      <Field label="Username" hint="Letters and numbers" />,
    );

    expect(view.getByLabelText('Username').props.accessibilityHint).toBe('Letters and numbers');
    const caption = view.getByText('Letters and numbers', { includeHiddenElements: true });
    expect(caption.props.accessibilityElementsHidden).toBe(true);
  });
});
