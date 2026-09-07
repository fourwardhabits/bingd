import { fireEvent, waitFor } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import { queryKeys } from '@/lib/query';
import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import CreateProfileScreen from '../../../app/(auth)/create-profile';

/**
 * **A profile the server has just created is answered into the taste flow from what
 * this process already knows** (pre-GTM audit, 2026-09-07).
 *
 * The first-run check is bounded at four seconds and a timeout answers "not needed",
 * which is the right answer for the population and the wrong one for the single account
 * that was created a moment ago: two hung counts, and a brand-new reader lands on an
 * empty Feed having never seen Build your taste. `create_profile` answering `created`
 * is the server's own word that the account has nothing in it, so the screen seeds the
 * check's cache with that answer before the gate opens. `already_exists` says nothing
 * about the account's contents and seeds nothing.
 */

const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: () => {},
}));

const mockCreateProfile = jest.fn();

jest.mock('@/features/auth', () => ({
  // The real status the gate holds while a session exists without a profile.
  useAuth: () => ({ status: 'onboarding', userId: 'user-1', email: null }),
  createProfile: (...args: unknown[]) => mockCreateProfile(...args),
  applyInitialVisibility: () => Promise.resolve({ ok: true }),
  signOut: jest.fn(),
  usernameAvailability: () => Promise.resolve(true),
  takePendingDisplayName: () => Promise.resolve(null),
  clearPendingDisplayName: jest.fn(),
  UseDifferentAccountButton: () => null,
}));

jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));

/** The date-of-birth confirmation, answered the way a person answers it. */
const confirmDateOfBirth = () =>
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons) => {
    const yes = (buttons as AlertButton[] | undefined)?.find((b) => b.style !== 'cancel');
    yes?.onPress?.();
  });

beforeEach(() => {
  confirmDateOfBirth();
  mockRpc.mockReset().mockResolvedValue({ data: null, error: null });
  mockCreateProfile.mockReset().mockResolvedValue({ outcome: 'created' });
});

const open = async () => {
  const view = await renderWithProviders(<CreateProfileScreen />);
  await waitFor(() => expect(view.getByText('Profile visibility')).toBeTruthy());
  return view;
};

const fillIn = async (view: Awaited<ReturnType<typeof open>>) => {
  await fireEvent.changeText(view.getByLabelText('Username'), 'rosalind');
  await fireEvent.changeText(view.getByLabelText('Month'), '04');
  await fireEvent.changeText(view.getByLabelText('Day'), '11');
  await fireEvent.changeText(view.getByLabelText('Year'), '1994');
  await waitFor(() =>
    expect(
      view.getByRole('button', { name: 'Create my account' }).props.accessibilityState.disabled,
    ).toBe(false),
  );
};

describe('what a fresh account is told about the taste flow', () => {
  /**
   * Observed at the cache write rather than read back afterwards. `renderWithProviders`
   * runs its client with `gcTime: 0`, so a query nothing is observing yet is collected
   * on the next tick — which is a property of the test client, not of the app, whose
   * client keeps the default five minutes and mounts `useTasteOnboarding` the moment
   * the gate opens.
   */
  const seeds = (view: Awaited<ReturnType<typeof open>>) =>
    jest
      .spyOn(view.client, 'setQueryData')
      .mock.calls.filter(([key]) => JSON.stringify(key) === JSON.stringify(queryKeys.tasteOnboarding('user-1')));

  it('seeds the first-run check with "needed" once the server says created', async () => {
    const view = await open();
    const seed = jest.spyOn(view.client, 'setQueryData');
    await fillIn(view);

    await fireEvent.press(view.getByRole('button', { name: 'Create my account' }));

    await waitFor(() => expect(mockCreateProfile).toHaveBeenCalled());
    await waitFor(() =>
      expect(seed).toHaveBeenCalledWith(queryKeys.tasteOnboarding('user-1'), {
        ranked: 0,
        needed: true,
      }),
    );
  });

  it('seeds nothing for a profile that was already there', async () => {
    // A replay of this signup's own lost reply, or an account created on another
    // device: `already_exists` says nothing about what the account holds, so the check
    // is left to ask the way it always has.
    mockCreateProfile.mockResolvedValue({ outcome: 'already_exists' });
    const view = await open();
    const seed = jest.spyOn(view.client, 'setQueryData');
    await fillIn(view);

    await fireEvent.press(view.getByRole('button', { name: 'Create my account' }));

    await waitFor(() => expect(mockCreateProfile).toHaveBeenCalled());
    expect(
      seed.mock.calls.filter(
        ([key]) => JSON.stringify(key) === JSON.stringify(queryKeys.tasteOnboarding('user-1')),
      ),
    ).toHaveLength(0);
    expect(seeds(view)).toHaveLength(0);
  });
});
