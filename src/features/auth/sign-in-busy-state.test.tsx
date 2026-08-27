import { act, fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

/**
 * **The screen half of the founder's stuck sign-in: a button that never comes back.**
 *
 *     sign in → "Signing in…" indefinitely → force-close → reopen → signed in
 *
 * Every one of these screens held its busy flag the same way:
 *
 *     setBusy(x);
 *     const result = await run();
 *     setBusy(null);          // ← not reached when `run()` rejects
 *
 * A rejection there does three things at once, and all three match the report. The label
 * stays "Signing in…". Every control on the screen stays `disabled`, because they all key
 * off the same flag — so there is nothing left to press, not even "Use a different email".
 * And no message appears, because the error branch is below the line that was skipped, so
 * the screen looks like it is still working. Meanwhile the session may be perfectly real,
 * which is exactly why reopening the app showed the founder signed in.
 *
 * `methods.ts` has separately been made non-rejecting on every lane
 * (`methods.provider.test.ts`), and both halves are kept: that file is where the next
 * provider gets added, and this is where the screen refuses to be trapped by one.
 *
 * The success cases are here too, and they assert an absence: **no navigation.** Routing is
 * `useAuthRouting`'s job on all four paths, and a push from a screen would race it.
 */

const mockNav = { pushed: [] as unknown[], replaced: [] as unknown[] };

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: (href: unknown) => mockNav.pushed.push(href),
    replace: (href: unknown) => mockNav.replaced.push(href),
    back: () => {},
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({ email: 'watcher@example.com' }),
  Stack: { Screen: () => null },
}));

const mockAuth = {
  sendCode: jest.fn(),
  verifyCode: jest.fn(),
  apple: jest.fn(),
  google: jest.fn(),
  password: jest.fn(),
};

jest.mock('@/features/auth', () => ({
  sendEmailCode: (...a: unknown[]) => mockAuth.sendCode(...a),
  verifyEmailCode: (...a: unknown[]) => mockAuth.verifyCode(...a),
  signInWithApple: (...a: unknown[]) => mockAuth.apple(...a),
  signInWithGoogle: (...a: unknown[]) => mockAuth.google(...a),
  signInWithEmailPassword: (...a: unknown[]) => mockAuth.password(...a),
  isAppleSignInAvailable: () => Promise.resolve(true),
  COMMIT_TIMEOUT_MESSAGE: 'That is taking longer than it should. Reopen the app.',
}));

const mockReportHandled = jest.fn();
jest.mock('@/lib/monitoring', () => ({ reportHandled: (...a: unknown[]) => mockReportHandled(...a) }));

import PasswordSignInScreen from '../../../app/(auth)/password-sign-in';
import SignInScreen from '../../../app/(auth)/sign-in';
import VerifyScreen from '../../../app/(auth)/verify';

beforeEach(() => {
  mockNav.pushed = [];
  mockNav.replaced = [];
  mockAuth.sendCode.mockReset().mockResolvedValue({ ok: true });
  mockAuth.verifyCode.mockReset().mockResolvedValue({ ok: true });
  mockAuth.apple.mockReset().mockResolvedValue({ ok: true });
  mockAuth.google.mockReset().mockResolvedValue({ ok: true });
  mockAuth.password.mockReset().mockResolvedValue({ ok: true });
  mockReportHandled.mockReset();
});

type View = Awaited<ReturnType<typeof renderWithProviders>>;

const press = async (view: View, label: string) => {
  await act(async () => {
    fireEvent.press(view.getByText(label));
  });
};

const typeInto = async (view: View, label: string, value: string) => {
  await act(async () => {
    fireEvent.changeText(view.getByLabelText(label), value);
  });
};

// ---------------------------------------------------------------------------

describe('a provider that throws', () => {
  it('gives the Apple button back, with something to read', async () => {
    mockAuth.apple.mockRejectedValue(new Error('the sheet exploded'));
    const view = await renderWithProviders(<SignInScreen />);
    await waitFor(() => expect(view.getByText('Continue with Apple')).toBeTruthy());

    await press(view, 'Continue with Apple');

    // The label is the whole symptom. It was "Signing in…" for the life of the screen.
    expect(view.getByText('Continue with Apple')).toBeTruthy();
    expect(view.queryByText('Signing in…')).toBeNull();
    expect(view.getByText('That did not work. Try again.')).toBeTruthy();
    expect(mockReportHandled).toHaveBeenCalled();
  });

  it('gives the Google button back too', async () => {
    mockAuth.google.mockRejectedValue(new Error('another browser is already open'));
    const view = await renderWithProviders(<SignInScreen />);

    await press(view, 'Continue with Google');

    expect(view.getByText('Continue with Google')).toBeTruthy();
    expect(view.queryByText('Signing in…')).toBeNull();
    expect(view.getByText('That did not work. Try again.')).toBeTruthy();
  });

  it('lets a second attempt happen after the first one threw', async () => {
    mockAuth.google
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ ok: true });
    const view = await renderWithProviders(<SignInScreen />);

    await press(view, 'Continue with Google');
    await press(view, 'Continue with Google');

    // A stuck busy flag disables the button, so the retry never even reached the method.
    expect(mockAuth.google).toHaveBeenCalledTimes(2);
  });

  it('gives the email button back when sending throws', async () => {
    mockAuth.sendCode.mockRejectedValue(new Error('offline'));
    const view = await renderWithProviders(<SignInScreen />);
    await typeInto(view, 'Email', 'watcher@example.com');

    await press(view, 'Continue with email');

    expect(view.getByText('Continue with email')).toBeTruthy();
    expect(view.queryByText('Sending…')).toBeNull();
    expect(mockNav.pushed).toEqual([]);
  });
});

describe('the code screen', () => {
  it('gives the Continue button back when verifying throws', async () => {
    mockAuth.verifyCode.mockRejectedValue(new Error('keychain did not answer'));
    const view = await renderWithProviders(<VerifyScreen />);
    await typeInto(view, 'Six-digit code', '123456');

    await press(view, 'Continue');

    expect(view.getByText('Continue')).toBeTruthy();
    expect(view.queryByText('Checking…')).toBeNull();
    // "Send a new code" and "Use a different email" share the same flag, so a stuck one
    // left somebody on a screen with no working control at all.
    expect(view.getByText('Send a new code')).toBeTruthy();
    expect(view.getByText('Use a different email')).toBeTruthy();
  });

  it('gives the buttons back when resending throws', async () => {
    mockAuth.sendCode.mockRejectedValue(new Error('offline'));
    const view = await renderWithProviders(<VerifyScreen />);

    await press(view, 'Send a new code');

    expect(view.getByText('Could not send another code.')).toBeTruthy();
    expect(view.getByText('Continue')).toBeTruthy();
  });

  /**
   * A commit that stopped being waited on is not a wrong code, and saying so would send
   * somebody to re-enter six digits that were already accepted.
   */
  it('passes a commit timeout through instead of blaming the code', async () => {
    mockAuth.verifyCode.mockResolvedValue({
      ok: false,
      cancelled: false,
      message: 'That is taking longer than it should. Reopen the app.',
    });
    const view = await renderWithProviders(<VerifyScreen />);
    await typeInto(view, 'Six-digit code', '123456');

    await press(view, 'Continue');

    expect(view.getByText('That is taking longer than it should. Reopen the app.')).toBeTruthy();
    expect(view.queryByText('That code did not work. Check it, or send a new one.')).toBeNull();
  });
});

describe('the password back door', () => {
  it('gives its button back when the call throws', async () => {
    mockAuth.password.mockRejectedValue(new Error('offline'));
    const view = await renderWithProviders(<PasswordSignInScreen />);
    await typeInto(view, 'Email', 'reviewer@example.com');
    await typeInto(view, 'Password', 'hunter2');

    await press(view, 'Sign in');

    expect(view.getByText('Sign in')).toBeTruthy();
    expect(view.queryByText('Signing in…')).toBeNull();
    expect(view.getByText('That did not work. Try again.')).toBeTruthy();
  });
});

describe('a sign-in that works', () => {
  it('clears the busy state and navigates nowhere', async () => {
    const view = await renderWithProviders(<SignInScreen />);
    await waitFor(() => expect(view.getByText('Continue with Apple')).toBeTruthy());

    await press(view, 'Continue with Apple');

    expect(view.getByText('Continue with Apple')).toBeTruthy();
    // Routing belongs to `useAuthRouting`, which decides between the feed and
    // create-profile from the session and the profile read. A push here would race it.
    expect(mockNav.pushed).toEqual([]);
    expect(mockNav.replaced).toEqual([]);
  });

  it('says nothing at all when somebody dismisses the provider sheet', async () => {
    mockAuth.google.mockResolvedValue({ ok: false, cancelled: true });
    const view = await renderWithProviders(<SignInScreen />);

    await press(view, 'Continue with Google');

    expect(view.getByText('Continue with Google')).toBeTruthy();
    expect(view.queryByText('That did not work. Try again.')).toBeNull();
  });
});
