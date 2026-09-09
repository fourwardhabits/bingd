import { act, render } from '@testing-library/react-native';
import { Text } from 'react-native';

import { useTabReset } from './use-tab-reset';

/**
 * The tab-press subscription every tab shares.
 *
 * What is asserted here is the part that is the same on all five and the part that is
 * easy to get wrong in a copy: **only when this tab is already focused**, and **nothing
 * is prevented**. The five screens' own answers — what their root is — belong to their
 * own suites, because each is a different sentence.
 */

const listeners = new Map<string, () => void>();
let focused = true;

const navigation = {
  addListener: (event: string, listener: () => void) => {
    listeners.set(event, listener);
    return () => listeners.delete(event);
  },
  isFocused: () => focused,
};

jest.mock('expo-router', () => ({ useNavigation: () => navigation }));

const press = () =>
  act(() => {
    listeners.get('tabPress')?.();
  });

function Screen({ reset }: { reset: () => void }) {
  useTabReset(reset);
  return <Text>screen</Text>;
}

beforeEach(() => {
  listeners.clear();
  focused = true;
});

it('runs the screen’s reset when its own tab is pressed again', async () => {
  const reset = jest.fn();
  await render(<Screen reset={reset} />);

  await press();

  expect(reset).toHaveBeenCalledTimes(1);
});

it('does nothing when the press is an arrival from another tab', async () => {
  /**
   * `tabPress` fires for a tab whether the reader was on it or somewhere else, and
   * resetting in the second case would be a different change nobody asked for: arriving
   * from another tab would stop returning you to what you were doing.
   */
  const reset = jest.fn();
  await render(<Screen reset={reset} />);

  focused = false;
  await press();

  expect(reset).not.toHaveBeenCalled();
});

it('subscribes to tabPress and nothing else', async () => {
  await render(<Screen reset={jest.fn()} />);

  // Nothing is prevented: the listener does not call `preventDefault`, so the
  // navigator's own pop-to-top still happens on the tabs that have somewhere to pop.
  expect([...listeners.keys()]).toEqual(['tabPress']);
});

it('lets go of the listener when the screen unmounts', async () => {
  const view = await render(<Screen reset={jest.fn()} />);
  expect(listeners.size).toBe(1);

  await act(async () => view.unmount());

  expect(listeners.size).toBe(0);
});

it('survives a navigator that cannot report focus', async () => {
  /**
   * Under the unit runner `useNavigation` is whatever a test supplies, and a good many
   * of them supply an object with neither method. That is a screen with no navigator to
   * listen to, not a crash.
   */
  const bare = jest.spyOn(navigation, 'addListener').mockReturnValue(undefined as never);
  try {
    const view = await render(<Screen reset={jest.fn()} />);
    expect(() => view.unmount()).not.toThrow();
  } finally {
    bare.mockRestore();
  }
});
