import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import { resetStepViewedForTests } from '@/features/onboarding/step-viewed';
import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import CreateProfileScreen from '../../../app/(auth)/create-profile';

/**
 * **The profile step reports its arrival and its completion** (Onboarding 2.0, OB-1,
 * 2026-11-14).
 *
 * `onboarding_step_completed {step: 'profile'}` was never sent before this build: the
 * flow's first step was the one without a completion. It is sent at the moment
 * `signup_completed` is, under the same rule — `created` only, because `already_exists`
 * is a replay of an account that was already there.
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

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({ track: (event: unknown) => mockTrack(event) }));

/** The date-of-birth confirmation, answered the way a person answers it. */
const confirmDateOfBirth = () =>
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons) => {
    const yes = (buttons as AlertButton[] | undefined)?.find((b) => b.style !== 'cancel');
    yes?.onPress?.();
  });

beforeEach(() => {
  mockTrack.mockReset();
  resetStepViewedForTests();
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

const named = (name: string) =>
  mockTrack.mock.calls.map(([event]) => event).filter((event) => event.name === name);

describe('the profile step in the onboarding funnel', () => {
  it('reports the step as viewed once, across a remount', async () => {
    const first = await open();
    await first.unmount();
    await open();

    expect(named('onboarding_step_viewed')).toEqual([
      { name: 'onboarding_step_viewed', props: { step: 'profile' } },
    ]);
  });

  it('reports the step as completed when the server says created, beside the signup', async () => {
    const view = await open();
    await fillIn(view);

    await fireEvent.press(view.getByRole('button', { name: 'Create my account' }));

    await waitFor(() => expect(named('signup_completed')).toHaveLength(1));
    expect(named('onboarding_step_completed')).toEqual([
      { name: 'onboarding_step_completed', props: { step: 'profile', outcome: 'continued' } },
    ]);
  });

  it('reports no completion for a profile that was already there', async () => {
    mockCreateProfile.mockResolvedValue({ outcome: 'already_exists' });
    const view = await open();
    await fillIn(view);

    await fireEvent.press(view.getByRole('button', { name: 'Create my account' }));

    await waitFor(() => expect(mockCreateProfile).toHaveBeenCalled());
    // Let the answer's own work run out before saying nothing was sent.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(named('signup_completed')).toHaveLength(0);
    expect(named('onboarding_step_completed')).toHaveLength(0);
  });
});
