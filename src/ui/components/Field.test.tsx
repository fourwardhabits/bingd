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
