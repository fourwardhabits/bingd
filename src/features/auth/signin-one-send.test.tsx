import { act, fireEvent } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

/**
 * One gesture on the sign-in screen sends one email, and nothing about the screen may
 * quietly make that two.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE
 *
 * A double `fireEvent.press` in one test makes every later render in the same file
 * unreliable, so the double-activation cases live here rather than beside the rest of
 * the auth screen assertions in `EmailAuthScreens.test.tsx`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS DEFENDING, AND WHAT IT COST
 *
 * `sendEmailCode` costs a real email at GoTrue whether or not the client meant to send
 * two. The second of two sends inside the same second is refused with
 * `over_email_send_rate_limit`, which is the per-address 60-second cooldown doing its
 * job — so the visible symptom is a rate limit on what the person experienced as their
 * **first and only** attempt, while the code they were told did not send sits in their
 * inbox. That is a signup that converts to nothing, and it reads as a server fault.
 *
 * The screen has two ways to fire the same send: the Continue button and the keyboard's
 * Go key on the email field. `disabled` and `editable` cannot refuse either of them,
 * because two activations in one frame both read the same render's `busy`. Only the
 * synchronous ref in `sign-in.tsx` can, which is what these two tests pin.
 */

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, canGoBack: () => true }),
  useLocalSearchParams: () => ({}),
  Stack: { Screen: () => null },
}));

const mockSendCode = jest.fn();

jest.mock('@/features/auth', () => ({
  signInWithEmailPassword: jest.fn(),
  sendEmailCode: (...a: unknown[]) => mockSendCode(...a),
  verifyEmailCode: jest.fn(),
  signInWithApple: jest.fn(),
  signInWithGoogle: jest.fn(),
  isAppleSignInAvailable: () => Promise.resolve(false),
}));

import SignInScreen from '../../../app/(auth)/sign-in';

/** A send that never settles, which is the whole window a second activation lands in. */
const inFlight = () => new Promise(() => {});

beforeEach(() => {
  mockSendCode.mockReset();
  mockSendCode.mockImplementation(inFlight);
});

const withEmail = async () => {
  const view = await renderWithProviders(<SignInScreen />);
  await act(async () => {
    fireEvent.changeText(view.getByLabelText('Email'), 'ada@user.example');
  });
  return view;
};

it('sends once when Continue is activated twice before the first send settles', async () => {
  const view = await withEmail();
  const button = view.getByText('Continue with email');

  await act(async () => {
    fireEvent.press(button);
    fireEvent.press(button);
  });

  expect(mockSendCode).toHaveBeenCalledTimes(1);
});

it('sends once when the keyboard Go key fires twice', async () => {
  const view = await withEmail();
  const field = view.getByLabelText('Email');

  await act(async () => {
    fireEvent(field, 'submitEditing');
    fireEvent(field, 'submitEditing');
  });

  expect(mockSendCode).toHaveBeenCalledTimes(1);
});
