import { fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

/**
 * **"Use a different account" — the door out of the account-trap.** Build 4, physical
 * device: sign in with the wrong email, land on "Pick your name", and there is no
 * sign-out anywhere — Settings is behind the profile gate, and on iOS the Keychain
 * session survives a reinstall. These pin the whole escape: the confirmation stands
 * between a mistap and a sign-out, the sign-out is the canonical helper (device-token
 * release and the settle-don't-throw contract come with it), and the navigation to the
 * auth entry happens even when the sign-out could not finish — the button's one promise
 * is a way out.
 */

const mockSignOut = jest.fn();
const mockReplace = jest.fn();

jest.mock('./methods', () => ({
  signOut: (...args: unknown[]) => mockSignOut(...args),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}));

import { UseDifferentAccountButton } from './UseDifferentAccount';

/** The confirm dialog's buttons, from the most recent `Alert.alert` call. */
const alertButtons = () => {
  const call = (Alert.alert as jest.Mock).mock.calls.at(-1);
  if (!call) throw new Error('no alert was presented');
  return call[2] as { text: string; style?: string; onPress?: () => void }[];
};

beforeEach(() => {
  mockSignOut.mockReset().mockResolvedValue(undefined);
  mockReplace.mockReset();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  (Alert.alert as jest.Mock).mockRestore();
});

describe('Use a different account', () => {
  it('asks before it acts, in the agreed words', async () => {
    const view = await renderWithProviders(<UseDifferentAccountButton />);

    await fireEvent.press(view.getByRole('button', { name: 'Use a different account' }));

    expect(Alert.alert).toHaveBeenCalledWith(
      'Sign out and use another account?',
      undefined,
      expect.any(Array),
    );
    // Nothing has been signed out by the question alone.
    expect(mockSignOut).not.toHaveBeenCalled();
    // Cancel is the cancel-styled button, so the safe answer is the easy one.
    expect(alertButtons().map((b) => ({ text: b.text, style: b.style }))).toEqual([
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: undefined },
    ]);
  });

  it('signs out the local session and returns to the auth entry on confirmation', async () => {
    const view = await renderWithProviders(<UseDifferentAccountButton />);

    await fireEvent.press(view.getByRole('button', { name: 'Use a different account' }));
    alertButtons()
      .find((b) => b.text === 'Sign out')!
      .onPress!();

    await waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(1));
    // Explicit, because routing leaves a signed-out person inside `(auth)` alone: from
    // "Pick your name" nothing else would move them.
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(auth)/sign-in'));
  });

  it('does nothing on Cancel', async () => {
    const view = await renderWithProviders(<UseDifferentAccountButton />);

    await fireEvent.press(view.getByRole('button', { name: 'Use a different account' }));
    // Cancel carries no onPress at all: there is nothing to do.
    expect(alertButtons().find((b) => b.text === 'Cancel')!.onPress).toBeUndefined();

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  /**
   * `signOut` settles by contract (review 45), so this lane should be unreachable —
   * but the navigation is in a `finally` precisely so the contract is not load-bearing
   * here. A person escaping a stuck account must not be stranded by the escape.
   */
  it('still reaches the auth entry if the sign-out throws', async () => {
    mockSignOut.mockRejectedValue(new Error('storage unavailable'));
    const view = await renderWithProviders(<UseDifferentAccountButton />);

    await fireEvent.press(view.getByRole('button', { name: 'Use a different account' }));
    alertButtons()
      .find((b) => b.text === 'Sign out')!
      .onPress!();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(auth)/sign-in'));
  });

  it('starts one sign-out however many times the confirmation fires', async () => {
    let resolveSignOut: () => void = () => {};
    mockSignOut.mockImplementation(() => new Promise<void>((r) => (resolveSignOut = r)));
    const view = await renderWithProviders(<UseDifferentAccountButton />);

    await fireEvent.press(view.getByRole('button', { name: 'Use a different account' }));
    const confirm = alertButtons().find((b) => b.text === 'Sign out')!.onPress!;
    confirm();
    confirm();

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    resolveSignOut();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(auth)/sign-in'));
  });
});
