import { act, fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

/**
 * The shipped state: `USERNAME_SIGN_IN_ENABLED` is **false**, read from the real module
 * (nothing here mocks it). The sign-in screen must be today's screen, and the new route
 * must lead nowhere. The exhaustive assertions about today's screen are the pre-existing
 * suites (`EmailAuthScreens`, `signin-one-send`, …), which also run against the real
 * constant and are unchanged; these add the negative half — a username typed into the
 * dark build goes nowhere.
 */

const mockNav = { pushed: [] as unknown[], replaced: [] as unknown[] };

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: (href: unknown) => mockNav.pushed.push(href),
    replace: (href: unknown) => mockNav.replaced.push(href),
    back: () => {},
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({}),
  Stack: { Screen: () => null },
}));

const mockAuth = { sendCode: jest.fn(), sendUsername: jest.fn(), classify: jest.fn() };

jest.mock('@/features/auth', () => ({
  classifyIdentifier: (...a: unknown[]) => mockAuth.classify(...a),
  sendEmailCode: (...a: unknown[]) => mockAuth.sendCode(...a),
  sendUsernameCode: (...a: unknown[]) => mockAuth.sendUsername(...a),
  verifyUsernameCode: jest.fn(),
  // A challenge in memory must not open the screen while the constant is off.
  pendingUsernameChallenge: () => ({ challengeId: 'c'.repeat(43), username: 'ada' }),
  clearPendingUsernameChallenge: () => {},
  signInWithApple: jest.fn(),
  signInWithGoogle: jest.fn(),
  isAppleSignInAvailable: () => Promise.resolve(true),
}));

import SignInScreen from '../../../app/(auth)/sign-in';
import VerifyUsernameScreen from '../../../app/(auth)/verify-username';
import { USERNAME_SIGN_IN_ENABLED } from './username-sign-in-flag';

beforeEach(() => {
  mockNav.pushed = [];
  mockNav.replaced = [];
  Object.values(mockAuth).forEach((m) => m.mockReset());
});

it('ships off', () => {
  expect(USERNAME_SIGN_IN_ENABLED).toBe(false);
});

it('shows today’s sign-in screen: Email, Continue with email, and today’s hint', async () => {
  const view = await renderWithProviders(<SignInScreen />);
  expect(view.getByLabelText('Email')).toBeTruthy();
  expect(view.queryByLabelText('Email or username')).toBeNull();
  expect(view.getByText('Continue with email')).toBeTruthy();
  expect(
    view.getByText('We will send a six-digit code. No password to remember.', {
      includeHiddenElements: true,
    }),
  ).toBeTruthy();
  await waitFor(() => expect(view.getByText('Continue with Apple')).toBeTruthy());
  expect(JSON.stringify(view.toJSON())).not.toMatch(/username/i);
});

it('does not even classify the field, and a username goes nowhere', async () => {
  const view = await renderWithProviders(<SignInScreen />);
  await act(async () => {
    fireEvent.changeText(view.getByLabelText('Email'), 'ada_lovelace');
  });
  await act(async () => {
    fireEvent.press(view.getByText('Continue with email'));
  });
  expect(mockAuth.classify).not.toHaveBeenCalled();
  expect(mockAuth.sendUsername).not.toHaveBeenCalled();
  expect(mockAuth.sendCode).not.toHaveBeenCalled();
  expect(mockNav.pushed).toEqual([]);
});

it('still sends an email exactly as today', async () => {
  mockAuth.sendCode.mockResolvedValue({ ok: true });
  const view = await renderWithProviders(<SignInScreen />);
  await act(async () => {
    fireEvent.changeText(view.getByLabelText('Email'), ' ada@bingd.app ');
  });
  await act(async () => {
    fireEvent.press(view.getByText('Continue with email'));
  });
  expect(mockAuth.sendCode).toHaveBeenCalledWith(' ada@bingd.app ');
  expect(mockNav.pushed).toEqual([
    { pathname: '/(auth)/verify', params: { email: 'ada@bingd.app' } },
  ]);
});

it('closes the username code screen to anybody who reaches it', async () => {
  const view = await renderWithProviders(<VerifyUsernameScreen />);
  expect(view.getByText('Start again')).toBeTruthy();
  expect(view.queryByLabelText('Six-digit code')).toBeNull();
});
