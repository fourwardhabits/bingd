import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { Keyboard } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

/**
 * The three auth screens, under the founder's final 2026-08-26 decision.
 *
 * What these assert is the *hierarchy and the routing*, which is where an OTP-first
 * product with a retained password capability goes wrong in ways nothing else catches:
 *
 *   · The primary screen offers email, Apple and Google — and no password field.
 *   · There is no create-account-with-a-password path anywhere.
 *   · One code screen serves a new address and a returning one, with copy that does not
 *     say which it is talking to.
 *   · Password sign-in exists, is secondary, and cannot create an account.
 *
 * The API-level contract — which Supabase call, which `EmailOtpType`, `shouldCreateUser`
 * — is pinned in `methods.email.test.ts`. These are the screens on top of it.
 */

const mockNav = { pushed: [] as unknown[], replaced: [] as unknown[], back: 0, canGoBack: true };

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: (href: unknown) => mockNav.pushed.push(href),
    replace: (href: unknown) => mockNav.replaced.push(href),
    back: () => {
      mockNav.back += 1;
    },
    canGoBack: () => mockNav.canGoBack,
  }),
  useLocalSearchParams: () => mockParams,
  Stack: { Screen: () => null },
}));

let mockParams: Record<string, string> = {};

const mockAuth = {
  signInPassword: jest.fn(),
  sendCode: jest.fn(),
  verifyCode: jest.fn(),
  apple: jest.fn(),
  google: jest.fn(),
  appleAvailable: true,
};

jest.mock('@/features/auth', () => ({
  signInWithEmailPassword: (...a: unknown[]) => mockAuth.signInPassword(...a),
  sendEmailCode: (...a: unknown[]) => mockAuth.sendCode(...a),
  verifyEmailCode: (...a: unknown[]) => mockAuth.verifyCode(...a),
  signInWithApple: (...a: unknown[]) => mockAuth.apple(...a),
  signInWithGoogle: (...a: unknown[]) => mockAuth.google(...a),
  isAppleSignInAvailable: () => Promise.resolve(mockAuth.appleAvailable),
}));

import PasswordSignInScreen from '../../../app/(auth)/password-sign-in';
import SignInScreen from '../../../app/(auth)/sign-in';
import VerifyScreen from '../../../app/(auth)/verify';

beforeEach(() => {
  mockNav.pushed = [];
  mockNav.replaced = [];
  mockNav.back = 0;
  mockNav.canGoBack = true;
  mockParams = {};
  Object.values(mockAuth).forEach((v) => {
    if (typeof v === 'function' && 'mockReset' in v) (v as jest.Mock).mockReset();
  });
  mockAuth.appleAvailable = true;
});

type View = Awaited<ReturnType<typeof renderWithProviders>>;

const typeInto = async (view: View, label: string, value: string) => {
  await act(async () => {
    fireEvent.changeText(view.getByLabelText(label), value);
  });
};

// ---------------------------------------------------------------------------

describe('Sign in', () => {
  /**
   * The hierarchy, as a list. Three ways in, and the fourth thing on the screen is not a
   * fourth way in — it is a labelled back door.
   */
  it('offers email, Apple and Google, and no password field', async () => {
    const view = await renderWithProviders(<SignInScreen />);

    expect(view.getByLabelText('Email')).toBeTruthy();
    expect(view.getByText('Continue with email')).toBeTruthy();
    await waitFor(() => expect(view.getByText('Continue with Apple')).toBeTruthy());
    expect(view.getByText('Continue with Google')).toBeTruthy();

    // The revert, asserted from the other direction: no password on the primary screen,
    // and nothing anywhere offering to create an account with one.
    expect(view.queryByLabelText('Password')).toBeNull();
    expect(view.queryByText('Create account')).toBeNull();
    expect(view.queryByText('Sign in without a password')).toBeNull();
  });

  it('keeps password sign-in as a secondary option, under a heading that says so', async () => {
    const view = await renderWithProviders(<SignInScreen />);

    expect(view.getByText('More sign-in options')).toBeTruthy();
    expect(view.getByText('Sign in with password')).toBeTruthy();

    await act(async () => {
      fireEvent.press(view.getByText('Sign in with password'));
    });
    expect(mockNav.pushed).toEqual(['/(auth)/password-sign-in']);
    // Navigating there signs nobody in and creates nothing.
    expect(mockAuth.signInPassword).not.toHaveBeenCalled();
  });

  it('sends a code and goes to the code screen', async () => {
    mockAuth.sendCode.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<SignInScreen />);

    await typeInto(view, 'Email', ' ada@bingd.app ');
    await act(async () => {
      fireEvent.press(view.getByText('Continue with email'));
    });

    expect(mockAuth.sendCode).toHaveBeenCalledWith(' ada@bingd.app ');
    // No `mode`: there is one flow, and the screen it lands on does not branch.
    expect(mockNav.pushed).toEqual([
      { pathname: '/(auth)/verify', params: { email: 'ada@bingd.app' } },
    ]);
  });

  /**
   * A new address and a returning one are the same tap with the same outcome, which is
   * both the product decision — nobody declares whether they are new — and the
   * anti-enumeration property.
   */
  it('does the same thing for an address that has never been seen', async () => {
    mockAuth.sendCode.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<SignInScreen />);

    await typeInto(view, 'Email', 'brand-new@bingd.app');
    await act(async () => {
      fireEvent.press(view.getByText('Continue with email'));
    });

    expect(mockNav.pushed).toEqual([
      { pathname: '/(auth)/verify', params: { email: 'brand-new@bingd.app' } },
    ]);
    expect(view.queryByText(/create an account/i)).toBeNull();
  });

  /**
   * The send happens before the navigation, so a refusal is shown beside the field
   * somebody would fix rather than on a code screen for a code nobody sent.
   */
  it('stays put when the code could not be sent', async () => {
    mockAuth.sendCode.mockResolvedValue({
      ok: false,
      cancelled: false,
      message: 'Too many emails just now. Wait a minute and try again.',
    });
    const view = await renderWithProviders(<SignInScreen />);

    await typeInto(view, 'Email', 'ada@bingd.app');
    await act(async () => {
      fireEvent.press(view.getByText('Continue with email'));
    });

    await waitFor(() => expect(view.getByText(/Too many emails/)).toBeTruthy());
    expect(mockNav.pushed).toEqual([]);
  });

  it('signs in with Apple and lets routing move the user', async () => {
    mockAuth.apple.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<SignInScreen />);

    await waitFor(() => expect(view.getByText('Continue with Apple')).toBeTruthy());
    await act(async () => {
      fireEvent.press(view.getByText('Continue with Apple'));
    });

    expect(mockAuth.apple).toHaveBeenCalled();
    expect(mockNav.pushed).toEqual([]);
    expect(mockNav.replaced).toEqual([]);
  });

  it('says nothing when a provider sheet is dismissed', async () => {
    mockAuth.google.mockResolvedValue({ ok: false, cancelled: true });
    const view = await renderWithProviders(<SignInScreen />);

    await act(async () => {
      fireEvent.press(view.getByText('Continue with Google'));
    });

    expect(view.queryByText(/did not work/)).toBeNull();
  });

  it('hides Apple where the entitlement is not there', async () => {
    mockAuth.appleAvailable = false;
    const view = await renderWithProviders(<SignInScreen />);

    await waitFor(() => expect(view.getByText('Continue with Google')).toBeTruthy());
    expect(view.queryByText('Continue with Apple')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('Password sign-in', () => {
  it('takes an email and a password, and offers no way to create an account', async () => {
    const view = await renderWithProviders(<PasswordSignInScreen />);

    expect(view.getByLabelText('Email')).toBeTruthy();
    expect(view.getByLabelText('Password')).toBeTruthy();
    expect(view.getByText('Sign in')).toBeTruthy();

    // The three things this screen must never grow.
    expect(view.queryByText(/create/i)).toBeNull();
    expect(view.queryByText(/sign up/i)).toBeNull();
    expect(view.queryByText(/forgot/i)).toBeNull();
  });

  it('signs in and lets routing move the user', async () => {
    mockAuth.signInPassword.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<PasswordSignInScreen />);

    await typeInto(view, 'Email', 'review@bingd.app');
    await typeInto(view, 'Password', 'hunter22');
    await act(async () => {
      fireEvent.press(view.getByText('Sign in'));
    });

    expect(mockAuth.signInPassword).toHaveBeenCalledWith('review@bingd.app', 'hunter22');
    expect(mockNav.pushed).toEqual([]);
    expect(mockNav.replaced).toEqual([]);
  });

  /**
   * A passwordless account reaching this screen gets the same sentence as a wrong
   * password. The method under it returns one message for every refusal; what the screen
   * must not do is decorate it with a second, more specific one.
   */
  it('shows the one generic refusal and nothing more', async () => {
    mockAuth.signInPassword.mockResolvedValue({
      ok: false,
      cancelled: false,
      message: 'We could not sign you in with that email and password.',
    });
    const view = await renderWithProviders(<PasswordSignInScreen />);

    await typeInto(view, 'Email', 'ordinary@bingd.app');
    await typeInto(view, 'Password', 'guess');
    await act(async () => {
      fireEvent.press(view.getByText('Sign in'));
    });

    await waitFor(() =>
      expect(view.getByText('We could not sign you in with that email and password.')).toBeTruthy(),
    );
    expect(mockNav.pushed).toEqual([]);
    // Not routed anywhere to "finish" or "verify" an account: there is no such state on
    // this path, and inventing one would tell the person their address exists.
    expect(mockNav.replaced).toEqual([]);
  });

  it('will not submit without both fields', async () => {
    const view = await renderWithProviders(<PasswordSignInScreen />);

    await typeInto(view, 'Email', 'review@bingd.app');
    await act(async () => {
      fireEvent.press(view.getByText('Sign in'));
    });

    expect(mockAuth.signInPassword).not.toHaveBeenCalled();
  });

  it('offers a way back to the primary screen', async () => {
    const view = await renderWithProviders(<PasswordSignInScreen />);

    await act(async () => {
      fireEvent.press(view.getByText('Back to sign in'));
    });

    expect(mockNav.back).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('The code screen', () => {
  const enter = async (view: View, code: string) => {
    await act(async () => {
      fireEvent.changeText(view.getByLabelText('Six-digit code'), code);
    });
  };

  /**
   * One mode, and the copy is the assertion.
   *
   * A screen that said "finish creating your account" to one person and "sign in" to
   * another would be telling whoever typed the address which of the two they are — from
   * the one flow whose property is that it does not know and does not say.
   */
  it('verifies a code without knowing whether the account is new', async () => {
    mockParams = { email: 'ada@bingd.app' };
    mockAuth.verifyCode.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<VerifyScreen />);

    expect(view.getByText('Check your email')).toBeTruthy();
    expect(view.queryByText(/creating your account/i)).toBeNull();

    await enter(view, '123456');
    await act(async () => {
      fireEvent.press(view.getByText('Continue'));
    });

    expect(mockAuth.verifyCode).toHaveBeenCalledWith('ada@bingd.app', '123456');
    // Nothing to navigate to: `useAuthRouting` sends a session with no profile to
    // create-profile and one with a profile to the feed.
    expect(mockNav.pushed).toEqual([]);
  });

  /**
   * **Resending, and the cooldown that keeps it usable** (founder, 2026-08-29).
   *
   * The control existed and had no bound at all, so an impatient double-tap earned
   * `over_email_send_rate_limit` — a dead end the reader cannot act on. Arriving on this
   * screen *is* the moment a code was sent, so the cooldown is armed on mount and the
   * button says how long is left rather than sitting greyed and unexplained.
   *
   * The clock is faked here and nowhere else in this file: real time cannot be waited
   * out in a unit test, and the countdown is arithmetic on `Date.now()` rather than an
   * effect that could be nudged.
   */
  it('holds the resend for a cooldown and says how long is left', async () => {
    mockParams = { email: 'ada@bingd.app' };
    const view = await renderWithProviders(<VerifyScreen />);

    // Named with the wait in it: a disabled button with no explanation is
    // indistinguishable from a broken one.
    expect(view.getByText(/^Resend code in 0:\d\d$/)).toBeTruthy();

    await act(async () => {
      fireEvent.press(view.getByText(/^Resend code in/));
    });
    expect(mockAuth.sendCode).not.toHaveBeenCalled();
  });

  it('resends through the one endpoint there is, once the cooldown is out', async () => {
    jest.useFakeTimers();
    try {
      mockParams = { email: 'ada@bingd.app' };
      mockAuth.sendCode.mockResolvedValue({ ok: true });
      const view = await renderWithProviders(<VerifyScreen />);

      await act(async () => {
        jest.advanceTimersByTime(31_000);
      });

      await act(async () => {
        fireEvent.press(view.getByText('Resend code'));
      });

      expect(mockAuth.sendCode).toHaveBeenCalledWith('ada@bingd.app');
      expect(mockAuth.sendCode).toHaveBeenCalledTimes(1);
      expect(view.getByText(/New code sent/)).toBeTruthy();
      // And straight back into a cooldown, so the next tap cannot be immediate.
      expect(view.getByText(/^Resend code in/)).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends exactly one code however fast the button is pressed twice', async () => {
    jest.useFakeTimers();
    try {
      mockParams = { email: 'ada@bingd.app' };
      mockAuth.sendCode.mockResolvedValue({ ok: true });
      const view = await renderWithProviders(<VerifyScreen />);

      await act(async () => {
        jest.advanceTimersByTime(31_000);
      });

      // Two presses inside one frame. Both read the same render's state, which is why
      // the guard is a ref rather than the `busy` flag the buttons are drawn from.
      const button = view.getByText('Resend code');
      await act(async () => {
        fireEvent.press(button);
        fireEvent.press(button);
      });

      expect(mockAuth.sendCode).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the stale rejection and the stale digits when a new code goes out', async () => {
    jest.useFakeTimers();
    try {
      mockParams = { email: 'ada@bingd.app' };
      mockAuth.verifyCode.mockResolvedValue({ ok: false, cancelled: false, message: 'x' });
      mockAuth.sendCode.mockResolvedValue({ ok: true });
      const view = await renderWithProviders(<VerifyScreen />);

      await act(async () => {
        fireEvent.changeText(view.getByLabelText('Six-digit code'), '000000');
      });
      await act(async () => {
        fireEvent.press(view.getByText('Continue'));
      });
      expect(view.getByText(/That code did not work/)).toBeTruthy();

      await act(async () => {
        jest.advanceTimersByTime(31_000);
      });
      await act(async () => {
        fireEvent.press(view.getByText('Resend code'));
      });

      // The rejection was about a code that has just been superseded, so it goes with
      // it — and the digits go too, because they belong to that code.
      expect(view.queryByText(/That code did not work/)).toBeNull();
      expect(view.getByLabelText('Six-digit code').props.value).toBe('');
      expect(view.getByText(/New code sent/)).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('says what went wrong on a refused resend, and comes back', async () => {
    jest.useFakeTimers();
    try {
      mockParams = { email: 'ada@bingd.app' };
      mockAuth.sendCode.mockResolvedValue({
        ok: false,
        cancelled: false,
        message: 'Too many emails just now. Wait a minute and try again.',
      });
      const view = await renderWithProviders(<VerifyScreen />);

      await act(async () => {
        jest.advanceTimersByTime(31_000);
      });
      await act(async () => {
        fireEvent.press(view.getByText('Resend code'));
      });

      // Whatever GoTrue said, as `sendEmailCode` maps it — and nothing about whether
      // this address has an account.
      expect(view.getByText(/Too many emails/)).toBeTruthy();
      expect(view.queryByText(/no account/i)).toBeNull();

      // The screen is not permanently disabled by one failure: the same countdown runs
      // and the control comes back.
      expect(view.getByText(/^Resend code in/)).toBeTruthy();
      await act(async () => {
        jest.advanceTimersByTime(31_000);
      });
      expect(view.getByText('Resend code')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * **The keyboard can be put away** (founder, iOS device pass, 2026-08-29).
   *
   * `number-pad` has no return key, so on iOS this screen had no gesture that dismissed
   * it at all. Two answers, and the test is the same for both: the native dismissal is
   * what is called, not a blur on a ref, which is the ornamental version that leaves the
   * pad on screen.
   */
  it('dismisses the keyboard when the screen outside the field is tapped', async () => {
    mockParams = { email: 'ada@bingd.app' };
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    try {
      const view = await renderWithProviders(<VerifyScreen />);
      await act(async () => {
        fireEvent.press(view.getByText('Check your email').parent as never);
      });
      expect(dismiss).toHaveBeenCalled();
    } finally {
      dismiss.mockRestore();
    }
  });

  it('offers a Done accessory the number pad does not come with', async () => {
    mockParams = { email: 'ada@bingd.app' };
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    try {
      const view = await renderWithProviders(<VerifyScreen />);
      await act(async () => {
        fireEvent.press(view.getByLabelText('Done. Hides the keyboard'));
      });
      expect(dismiss).toHaveBeenCalled();
    } finally {
      dismiss.mockRestore();
    }
  });

  it('says a bad code is bad without saying which kind of bad', async () => {
    mockParams = { email: 'ada@bingd.app' };
    mockAuth.verifyCode.mockResolvedValue({ ok: false, cancelled: false, message: 'x' });
    const view = await renderWithProviders(<VerifyScreen />);

    await enter(view, '000000');
    await act(async () => {
      fireEvent.press(view.getByText('Continue'));
    });

    await waitFor(() => expect(view.getByText(/That code did not work/)).toBeTruthy());
  });

  it('will not submit a code that is not six digits', async () => {
    mockParams = { email: 'ada@bingd.app' };
    const view = await renderWithProviders(<VerifyScreen />);

    await enter(view, '123');
    await act(async () => {
      fireEvent.press(view.getByText('Continue'));
    });

    expect(mockAuth.verifyCode).not.toHaveBeenCalled();
  });

  it('offers a way back when the address was mistyped', async () => {
    mockParams = { email: 'typo@bingd.app' };
    const view = await renderWithProviders(<VerifyScreen />);

    await act(async () => {
      fireEvent.press(view.getByText('Use a different email'));
    });

    expect(mockNav.back).toBe(1);
  });

  it('recovers rather than waiting for a code it cannot verify', async () => {
    mockParams = {};
    const view = await renderWithProviders(<VerifyScreen />);

    expect(view.getByText('Start again')).toBeTruthy();
    await act(async () => {
      fireEvent.press(view.getByText('Back to sign in'));
    });
    expect(mockNav.replaced).toEqual(['/(auth)/sign-in']);
  });
});
