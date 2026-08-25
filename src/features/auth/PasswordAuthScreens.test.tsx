import { act, fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

/**
 * The three email-auth screens, after the founder's 2026-08-26 password-first amendment.
 *
 * What these assert is the *hierarchy and the routing*, which is where a password-first
 * product goes wrong in ways nothing else catches:
 *
 *   · Sign in leads with a password and offers passwordless as one secondary action.
 *   · Create account is a separate screen and carries a code back into the app, never a
 *     browser.
 *   · An account that exists but was never verified is not told its password is wrong
 *     for ever — it is routed back to the code screen.
 *   · The code screen verifies with the type its flow actually needs.
 *
 * The API-level contract — which Supabase call, which `EmailOtpType`, `shouldCreateUser`
 * — is pinned in `methods.password.test.ts`. These are the screens on top of it.
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
  signUp: jest.fn(),
  signInPassword: jest.fn(),
  sendCode: jest.fn(),
  verifySignUp: jest.fn(),
  verifyCode: jest.fn(),
  resendSignUp: jest.fn(),
  apple: jest.fn(),
  google: jest.fn(),
  appleAvailable: true,
};

jest.mock('@/features/auth', () => ({
  signUpWithEmailPassword: (...a: unknown[]) => mockAuth.signUp(...a),
  signInWithEmailPassword: (...a: unknown[]) => mockAuth.signInPassword(...a),
  sendEmailCode: (...a: unknown[]) => mockAuth.sendCode(...a),
  verifySignUpCode: (...a: unknown[]) => mockAuth.verifySignUp(...a),
  verifyEmailCode: (...a: unknown[]) => mockAuth.verifyCode(...a),
  resendSignUpCode: (...a: unknown[]) => mockAuth.resendSignUp(...a),
  signInWithApple: (...a: unknown[]) => mockAuth.apple(...a),
  signInWithGoogle: (...a: unknown[]) => mockAuth.google(...a),
  isAppleSignInAvailable: () => Promise.resolve(mockAuth.appleAvailable),
}));

import CreateAccountScreen from '../../../app/(auth)/create-account';
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

const typeInto = async (view: ReturnType<typeof renderWithProviders> extends Promise<infer T> ? T : never, label: string, value: string) => {
  await act(async () => {
    fireEvent.changeText(view.getByLabelText(label), value);
  });
};

// ---------------------------------------------------------------------------

describe('Sign in', () => {
  it('leads with email and password, and offers passwordless as a secondary action', async () => {
    const view = await renderWithProviders(<SignInScreen />);

    expect(view.getByLabelText('Email')).toBeTruthy();
    expect(view.getByLabelText('Password')).toBeTruthy();
    expect(view.getByText('Sign in')).toBeTruthy();
    expect(view.getByText('Sign in without a password')).toBeTruthy();
    await waitFor(() => expect(view.getByText('Continue with Apple')).toBeTruthy());
    expect(view.getByText('Continue with Google')).toBeTruthy();
    expect(view.getByText('Create account')).toBeTruthy();
  });

  it('signs in with the password and lets routing move the user', async () => {
    mockAuth.signInPassword.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<SignInScreen />);

    await typeInto(view, 'Email', 'ada@bingd.app');
    await typeInto(view, 'Password', 'hunter22');
    await act(async () => {
      fireEvent.press(view.getByText('Sign in'));
    });

    expect(mockAuth.signInPassword).toHaveBeenCalledWith('ada@bingd.app', 'hunter22');
    // No navigation on success: `useAuthRouting` owns where a session belongs, as it
    // does for OAuth. A screen that pushed here would race it.
    expect(mockNav.pushed).toEqual([]);
    expect(mockNav.replaced).toEqual([]);
  });

  it('shows a wrong password against the field', async () => {
    mockAuth.signInPassword.mockResolvedValue({
      ok: false,
      unverified: false,
      message: 'That email and password do not match.',
    });
    const view = await renderWithProviders(<SignInScreen />);

    await typeInto(view, 'Email', 'ada@bingd.app');
    await typeInto(view, 'Password', 'nope');
    await act(async () => {
      fireEvent.press(view.getByText('Sign in'));
    });

    await waitFor(() =>
      expect(view.getByText('That email and password do not match.')).toBeTruthy(),
    );
    expect(mockNav.pushed).toEqual([]);
  });

  /**
   * The founder's §7, and the reason `unverified` is an outcome rather than a message.
   *
   * Somebody created an account and closed Bingd before typing the code. Their password
   * is correct. Telling them it is not — for ever, with nothing in the app able to
   * correct it — is the thing this routing exists to prevent.
   */
  it('routes an unverified account back to its verification code', async () => {
    mockAuth.signInPassword.mockResolvedValue({ ok: false, unverified: true });
    const view = await renderWithProviders(<SignInScreen />);

    await typeInto(view, 'Email', ' pending@bingd.app ');
    await typeInto(view, 'Password', 'hunter22');
    await act(async () => {
      fireEvent.press(view.getByText('Sign in'));
    });

    expect(mockNav.pushed).toEqual([
      { pathname: '/(auth)/verify', params: { email: 'pending@bingd.app', mode: 'signup' } },
    ]);
    // And it does not also say the password was wrong.
    expect(view.queryByText('That email and password do not match.')).toBeNull();
  });

  it('sends a code and goes to the code screen in passwordless mode', async () => {
    mockAuth.sendCode.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<SignInScreen />);

    await typeInto(view, 'Email', 'ada@bingd.app');
    await act(async () => {
      fireEvent.press(view.getByText('Sign in without a password'));
    });

    expect(mockAuth.sendCode).toHaveBeenCalledWith('ada@bingd.app');
    expect(mockNav.pushed).toEqual([
      { pathname: '/(auth)/verify', params: { email: 'ada@bingd.app', mode: 'passwordless' } },
    ]);
  });

  /**
   * The send happens before the navigation, so an unknown address is reported beside the
   * field somebody would fix rather than on a code screen for a code nobody sent.
   */
  it('stays put when the code could not be sent', async () => {
    mockAuth.sendCode.mockResolvedValue({
      ok: false,
      cancelled: false,
      message: 'We could not send a code to that address. Check it, or create an account.',
    });
    const view = await renderWithProviders(<SignInScreen />);

    await typeInto(view, 'Email', 'nobody@bingd.app');
    await act(async () => {
      fireEvent.press(view.getByText('Sign in without a password'));
    });

    await waitFor(() => expect(view.getByText(/could not send a code/)).toBeTruthy());
    expect(mockNav.pushed).toEqual([]);
  });

  it('goes to Create account rather than signing anybody up from here', async () => {
    const view = await renderWithProviders(<SignInScreen />);

    await act(async () => {
      fireEvent.press(view.getByText('Create account'));
    });

    expect(mockNav.pushed).toEqual(['/(auth)/create-account']);
    expect(mockAuth.signUp).not.toHaveBeenCalled();
  });

  it('hides Apple where the entitlement is not there', async () => {
    mockAuth.appleAvailable = false;
    const view = await renderWithProviders(<SignInScreen />);

    await waitFor(() => expect(view.getByText('Continue with Google')).toBeTruthy());
    expect(view.queryByText('Continue with Apple')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('Create account', () => {
  it('creates the account and goes to the code screen in signup mode', async () => {
    mockAuth.signUp.mockResolvedValue({ ok: true, needsVerification: true });
    const view = await renderWithProviders(<CreateAccountScreen />);

    await typeInto(view, 'Email', ' new@bingd.app ');
    await typeInto(view, 'Password', 'hunter22');
    await act(async () => {
      fireEvent.press(view.getByText('Create account'));
    });

    expect(mockAuth.signUp).toHaveBeenCalledWith(' new@bingd.app ', 'hunter22');
    expect(mockNav.pushed).toEqual([
      { pathname: '/(auth)/verify', params: { email: 'new@bingd.app', mode: 'signup' } },
    ]);
  });

  /**
   * Read from the answer rather than assumed, so the screen is correct whether or not
   * the project requires confirmation — and never strands somebody on a code screen for
   * a code that will not arrive.
   */
  it('goes nowhere when a session came straight back', async () => {
    mockAuth.signUp.mockResolvedValue({ ok: true, needsVerification: false });
    const view = await renderWithProviders(<CreateAccountScreen />);

    await typeInto(view, 'Email', 'new@bingd.app');
    await typeInto(view, 'Password', 'hunter22');
    await act(async () => {
      fireEvent.press(view.getByText('Create account'));
    });

    expect(mockNav.pushed).toEqual([]);
  });

  it('reports a refusal against the password field', async () => {
    mockAuth.signUp.mockResolvedValue({ ok: false, message: 'Choose a longer password.' });
    const view = await renderWithProviders(<CreateAccountScreen />);

    await typeInto(view, 'Email', 'new@bingd.app');
    await typeInto(view, 'Password', 'hunter22');
    await act(async () => {
      fireEvent.press(view.getByText('Create account'));
    });

    await waitFor(() => expect(view.getByText('Choose a longer password.')).toBeTruthy());
    expect(mockNav.pushed).toEqual([]);
  });

  it('will not submit a password shorter than six characters', async () => {
    const view = await renderWithProviders(<CreateAccountScreen />);

    await typeInto(view, 'Email', 'new@bingd.app');
    await typeInto(view, 'Password', 'short');
    await act(async () => {
      fireEvent.press(view.getByText('Create account'));
    });

    // Disabled rather than spending a round trip to be told `weak_password`. The server
    // stays the authority; this is only what lets the button explain itself.
    expect(mockAuth.signUp).not.toHaveBeenCalled();
  });

  it('offers a way back to sign in', async () => {
    const view = await renderWithProviders(<CreateAccountScreen />);

    await act(async () => {
      fireEvent.press(view.getByText('Sign in'));
    });

    expect(mockNav.back).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('The code screen', () => {
  const enter = async (view: Awaited<ReturnType<typeof renderWithProviders>>, code: string) => {
    await act(async () => {
      fireEvent.changeText(view.getByLabelText('Six-digit code'), code);
    });
  };

  /**
   * The mode decides the `EmailOtpType`, and a signup token verified as `'email'` fails
   * with `otp_expired` — reported to the person as "that code did not work" while they
   * are looking at the correct code.
   */
  it('verifies a signup code as a signup code', async () => {
    mockParams = { email: 'new@bingd.app', mode: 'signup' };
    mockAuth.verifySignUp.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<VerifyScreen />);

    expect(view.getByText('Verify your email')).toBeTruthy();
    await enter(view, '123456');
    await act(async () => {
      fireEvent.press(view.getByText('Verify email'));
    });

    expect(mockAuth.verifySignUp).toHaveBeenCalledWith('new@bingd.app', '123456');
    expect(mockAuth.verifyCode).not.toHaveBeenCalled();
  });

  it('verifies a passwordless code as a passwordless code', async () => {
    mockParams = { email: 'ada@bingd.app', mode: 'passwordless' };
    mockAuth.verifyCode.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<VerifyScreen />);

    expect(view.getByText('Check your email')).toBeTruthy();
    await enter(view, '123456');
    await act(async () => {
      fireEvent.press(view.getByText('Sign in'));
    });

    expect(mockAuth.verifyCode).toHaveBeenCalledWith('ada@bingd.app', '123456');
    expect(mockAuth.verifySignUp).not.toHaveBeenCalled();
  });

  /**
   * A route that has lost its parameter falls to the flow that cannot leave somebody
   * holding an unusable account: passwordless verifies an existing account and does not
   * pretend to finish a signup.
   */
  it('falls back to passwordless when the mode is missing', async () => {
    mockParams = { email: 'ada@bingd.app' };
    mockAuth.verifyCode.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<VerifyScreen />);

    await enter(view, '123456');
    await act(async () => {
      fireEvent.press(view.getByText('Sign in'));
    });

    expect(mockAuth.verifyCode).toHaveBeenCalled();
    expect(mockAuth.verifySignUp).not.toHaveBeenCalled();
  });

  it('resends through the endpoint its own flow uses', async () => {
    mockParams = { email: 'new@bingd.app', mode: 'signup' };
    mockAuth.resendSignUp.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<VerifyScreen />);

    await act(async () => {
      fireEvent.press(view.getByText('Send a new code'));
    });

    expect(mockAuth.resendSignUp).toHaveBeenCalledWith('new@bingd.app');
    // `sendEmailCode` is the other flow's endpoint and would fail here anyway:
    // `shouldCreateUser: false` against an unconfirmed account is not a resend.
    expect(mockAuth.sendCode).not.toHaveBeenCalled();
  });

  it('resends a passwordless code with the passwordless endpoint', async () => {
    mockParams = { email: 'ada@bingd.app', mode: 'passwordless' };
    mockAuth.sendCode.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<VerifyScreen />);

    await act(async () => {
      fireEvent.press(view.getByText('Send a new code'));
    });

    expect(mockAuth.sendCode).toHaveBeenCalledWith('ada@bingd.app');
    expect(mockAuth.resendSignUp).not.toHaveBeenCalled();
  });

  it('says a bad code is bad without saying which kind of bad', async () => {
    mockParams = { email: 'new@bingd.app', mode: 'signup' };
    mockAuth.verifySignUp.mockResolvedValue({ ok: false, cancelled: false, message: 'x' });
    const view = await renderWithProviders(<VerifyScreen />);

    await enter(view, '000000');
    await act(async () => {
      fireEvent.press(view.getByText('Verify email'));
    });

    await waitFor(() => expect(view.getByText(/That code did not work/)).toBeTruthy());
  });

  /**
   * The escape hatch that lets sign-up stay silent about whether an address is taken.
   *
   * Only on the signup flow — somebody in the passwordless flow is already signing in.
   */
  it('offers a way to sign in instead, on the signup flow only', async () => {
    mockParams = { email: 'new@bingd.app', mode: 'signup' };
    const signup = await renderWithProviders(<VerifyScreen />);
    expect(signup.getByText('Already have an account? Sign in')).toBeTruthy();

    mockParams = { email: 'ada@bingd.app', mode: 'passwordless' };
    const passwordless = await renderWithProviders(<VerifyScreen />);
    expect(passwordless.queryByText('Already have an account? Sign in')).toBeNull();
  });

  it('offers a way back when the address was mistyped', async () => {
    mockParams = { email: 'typo@bingd.app', mode: 'signup' };
    const view = await renderWithProviders(<VerifyScreen />);

    await act(async () => {
      fireEvent.press(view.getByText('Use a different email'));
    });

    expect(mockNav.back).toBe(1);
  });
});
