import { act, fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

/**
 * Username-or-email sign-in, on the screens, with `USERNAME_SIGN_IN_ENABLED` forced on.
 * (The constant really is false; `UsernameSignInDark.test.tsx` pins what that means, and
 * every pre-existing auth suite runs against the real false value unchanged.)
 *
 * What is asserted is what the design doc's threat model needs from the client:
 *
 *   · a value with `@` takes today's email path, byte for byte;
 *   · a username takes the function path and nothing else;
 *   · the code screen never shows an address, and never claims a code *was* sent;
 *   · password sign-in, Apple, Google and sign-up are where they were.
 */

const mockNav = {
  pushed: [] as unknown[],
  replaced: [] as unknown[],
  back: 0,
  canGoBack: true,
};

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: (href: unknown) => mockNav.pushed.push(href),
    replace: (href: unknown) => mockNav.replaced.push(href),
    back: () => {
      mockNav.back += 1;
    },
    canGoBack: () => mockNav.canGoBack,
  }),
  useLocalSearchParams: () => ({}),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth/username-sign-in-flag', () => ({ USERNAME_SIGN_IN_ENABLED: true }));

// The real classifier, so the screen's routing decision is the shipped one. The module's
// network functions are replaced below; its supabase import is stubbed so loading it
// reaches nothing.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const mockAuth = {
  signInPassword: jest.fn(),
  sendCode: jest.fn(),
  verifyCode: jest.fn(),
  sendUsername: jest.fn(),
  verifyUsername: jest.fn(),
  apple: jest.fn(),
  google: jest.fn(),
  pending: null as null | { challengeId: string; username: string },
};

jest.mock('@/features/auth', () => {
  const actual = jest.requireActual('@/features/auth/username-sign-in');
  return {
    classifyIdentifier: actual.classifyIdentifier,
    signInWithEmailPassword: (...a: unknown[]) => mockAuth.signInPassword(...a),
    sendEmailCode: (...a: unknown[]) => mockAuth.sendCode(...a),
    verifyEmailCode: (...a: unknown[]) => mockAuth.verifyCode(...a),
    sendUsernameCode: (...a: unknown[]) => mockAuth.sendUsername(...a),
    verifyUsernameCode: (...a: unknown[]) => mockAuth.verifyUsername(...a),
    pendingUsernameChallenge: () => mockAuth.pending,
    clearPendingUsernameChallenge: () => {
      mockAuth.pending = null;
    },
    signInWithApple: (...a: unknown[]) => mockAuth.apple(...a),
    signInWithGoogle: (...a: unknown[]) => mockAuth.google(...a),
    isAppleSignInAvailable: () => Promise.resolve(true),
  };
});

import PasswordSignInScreen from '../../../app/(auth)/password-sign-in';
import SignInScreen from '../../../app/(auth)/sign-in';
import VerifyUsernameScreen from '../../../app/(auth)/verify-username';

beforeEach(() => {
  mockNav.pushed = [];
  mockNav.replaced = [];
  mockNav.back = 0;
  mockNav.canGoBack = true;
  Object.values(mockAuth).forEach((v) => {
    if (typeof v === 'function' && 'mockReset' in v) (v as jest.Mock).mockReset();
  });
  mockAuth.pending = null;
});

type View = Awaited<ReturnType<typeof renderWithProviders>>;

const typeInto = async (view: View, label: string, value: string) => {
  await act(async () => {
    fireEvent.changeText(view.getByLabelText(label), value);
  });
};

const pressContinue = async (view: View) => {
  await act(async () => {
    fireEvent.press(view.getByText('Continue'));
  });
};

describe('Sign in, with username sign-in on', () => {
  it('offers one field for either, and still Apple, Google and the password back door', async () => {
    const view = await renderWithProviders(<SignInScreen />);
    expect(view.getByLabelText('Email or username')).toBeTruthy();
    expect(view.getByText('Continue')).toBeTruthy();
    await waitFor(() => expect(view.getByText('Continue with Apple')).toBeTruthy());
    expect(view.getByText('Continue with Google')).toBeTruthy();
    expect(view.getByText('Sign in with password')).toBeTruthy();
    expect(view.queryByLabelText('Password')).toBeNull();
    expect(view.queryByText('Create account')).toBeNull();
  });

  it('sends a value with @ down the email path, unchanged', async () => {
    mockAuth.sendCode.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<SignInScreen />);
    await typeInto(view, 'Email or username', ' ada@bingd.app ');
    await pressContinue(view);

    expect(mockAuth.sendCode).toHaveBeenCalledWith(' ada@bingd.app ');
    expect(mockAuth.sendUsername).not.toHaveBeenCalled();
    expect(mockNav.pushed).toEqual([
      { pathname: '/(auth)/verify', params: { email: 'ada@bingd.app' } },
    ]);
  });

  it('keeps the email path’s cooldown hand-off too', async () => {
    mockAuth.sendCode.mockResolvedValue({
      ok: false,
      cancelled: false,
      message: 'x',
      retryAfterSeconds: 42,
    });
    const view = await renderWithProviders(<SignInScreen />);
    await typeInto(view, 'Email or username', 'ada@bingd.app');
    await pressContinue(view);
    expect(mockNav.pushed).toEqual([
      { pathname: '/(auth)/verify', params: { email: 'ada@bingd.app', cooldown: '42' } },
    ]);
  });

  it('sends a username to the function path, normalised, and moves on without an address', async () => {
    mockAuth.sendUsername.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<SignInScreen />);
    await typeInto(view, 'Email or username', '  Ada_Lovelace ');
    await pressContinue(view);

    expect(mockAuth.sendUsername).toHaveBeenCalledWith('ada_lovelace');
    expect(mockAuth.sendCode).not.toHaveBeenCalled();
    expect(mockNav.pushed).toEqual(['/(auth)/verify-username']);
  });

  it('moves on the same way whatever the name — the server does not say, so neither does this', async () => {
    mockAuth.sendUsername.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<SignInScreen />);
    for (const name of ['real_person', 'nobody_at_all']) {
      await typeInto(view, 'Email or username', name);
      await pressContinue(view);
    }
    expect(mockAuth.sendUsername.mock.calls).toEqual([['real_person'], ['nobody_at_all']]);
    expect(mockNav.pushed).toEqual(['/(auth)/verify-username', '/(auth)/verify-username']);
  });

  it('sends one request for a double tap', async () => {
    let resolve!: (v: { ok: true }) => void;
    mockAuth.sendUsername.mockImplementation(() => new Promise((r) => (resolve = r)));
    const view = await renderWithProviders(<SignInScreen />);
    await typeInto(view, 'Email or username', 'ada');
    await act(async () => {
      fireEvent.press(view.getByText('Continue'));
      fireEvent(view.getByLabelText('Email or username'), 'submitEditing');
    });
    await act(async () => resolve({ ok: true }));
    expect(mockAuth.sendUsername).toHaveBeenCalledTimes(1);
  });

  it('refuses what is neither an address nor a username, asking nothing', async () => {
    const view = await renderWithProviders(<SignInScreen />);
    for (const value of ['ab', 'ada@', 'has space', 'x'.repeat(25)]) {
      await typeInto(view, 'Email or username', value);
      await pressContinue(view);
    }
    expect(mockAuth.sendUsername).not.toHaveBeenCalled();
    expect(mockAuth.sendCode).not.toHaveBeenCalled();
  });

  // Field captions (error/hint) are queried with includeHiddenElements: on this base they
  // are visible, and after design-system v3 A.2 #26 (DS-FIX) they are drawn but hidden from
  // the a11y tree because the input speaks them. The same query holds on both.
  it('stays put and says so when the request itself failed', async () => {
    mockAuth.sendUsername.mockResolvedValue({
      ok: false,
      message: 'That did not work. Try again.',
    });
    const view = await renderWithProviders(<SignInScreen />);
    await typeInto(view, 'Email or username', 'ada');
    await pressContinue(view);
    await waitFor(() =>
      expect(
        view.getByText('That did not work. Try again.', { includeHiddenElements: true }),
      ).toBeTruthy(),
    );
    expect(mockNav.pushed).toEqual([]);
  });

  it('leaves Google and Apple exactly as they were', async () => {
    mockAuth.google.mockResolvedValue({ ok: true });
    mockAuth.apple.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<SignInScreen />);
    await waitFor(() => expect(view.getByText('Continue with Apple')).toBeTruthy());
    await act(async () => {
      fireEvent.press(view.getByText('Continue with Google'));
    });
    await act(async () => {
      fireEvent.press(view.getByText('Continue with Apple'));
    });
    expect(mockAuth.google).toHaveBeenCalledTimes(1);
    expect(mockAuth.apple).toHaveBeenCalledTimes(1);
    expect(mockAuth.sendUsername).not.toHaveBeenCalled();
  });
});

describe('Password sign-in, with username sign-in on', () => {
  it('is still email and password only', async () => {
    const view = await renderWithProviders(<PasswordSignInScreen />);
    expect(view.getByLabelText('Email')).toBeTruthy();
    expect(view.queryByLabelText(/username/i)).toBeNull();
    expect(view.queryByText(/username/i, { includeHiddenElements: true })).toBeNull();
  });
});

describe('Verify by username', () => {
  const held = { challengeId: 'c'.repeat(43), username: 'ada' };

  it('never names an address and never claims a code was sent', async () => {
    mockAuth.pending = held;
    const view = await renderWithProviders(<VerifyUsernameScreen />);
    expect(view.getByText(/the email on your account/)).toBeTruthy();
    expect(view.getByText(/If that account exists/)).toBeTruthy();
    expect(JSON.stringify(view.toJSON())).not.toMatch(/@/);
    expect(JSON.stringify(view.toJSON())).not.toContain(held.challengeId);
  });

  it('checks the code and leaves navigation to the router', async () => {
    mockAuth.pending = held;
    mockAuth.verifyUsername.mockResolvedValue({ ok: true });
    const view = await renderWithProviders(<VerifyUsernameScreen />);
    await typeInto(view, 'Six-digit code', '123456');
    await pressContinue(view);
    expect(mockAuth.verifyUsername).toHaveBeenCalledWith('123456');
    expect(mockAuth.verifyCode).not.toHaveBeenCalled();
    expect(mockNav.pushed).toEqual([]);
    expect(mockNav.replaced).toEqual([]);
  });

  it('says one thing for every refusal', async () => {
    mockAuth.pending = held;
    mockAuth.verifyUsername.mockResolvedValue({
      ok: false,
      cancelled: false,
      message: 'That code did not work. Check it, or send a new one.',
    });
    const view = await renderWithProviders(<VerifyUsernameScreen />);
    await typeInto(view, 'Six-digit code', '000000');
    await pressContinue(view);
    await waitFor(() =>
      expect(
        view.getByText('That code did not work. Check it, or send a new one.', {
          includeHiddenElements: true,
        }),
      ).toBeTruthy(),
    );
  });

  it('starts again when there is no challenge in hand', async () => {
    const view = await renderWithProviders(<VerifyUsernameScreen />);
    expect(view.getByText('Start again')).toBeTruthy();
    await act(async () => {
      fireEvent.press(view.getByText('Back to sign in'));
    });
    expect(mockNav.replaced).toEqual(['/(auth)/sign-in']);
  });

  it('resends to the same name after the cooldown, twice at most', async () => {
    jest.useFakeTimers();
    try {
      mockAuth.pending = held;
      mockAuth.sendUsername.mockResolvedValue({ ok: true });
      const view = await renderWithProviders(<VerifyUsernameScreen />);

      await act(async () => {
        fireEvent.press(view.getByText(/^Resend code in/));
      });
      expect(mockAuth.sendUsername).not.toHaveBeenCalled();

      for (let i = 0; i < 2; i++) {
        await act(async () => {
          jest.advanceTimersByTime(61_000);
        });
        await act(async () => {
          fireEvent.press(view.getByText('Resend code'));
        });
      }
      expect(mockAuth.sendUsername).toHaveBeenCalledTimes(2);
      expect(mockAuth.sendUsername).toHaveBeenCalledWith('ada');
      expect(
        view.getByText(/a new code is on its way/, { includeHiddenElements: true }),
      ).toBeTruthy();

      await act(async () => {
        jest.advanceTimersByTime(61_000);
      });
      expect(view.getByText('No more codes for now')).toBeTruthy();
      await act(async () => {
        fireEvent.press(view.getByText('No more codes for now'));
      });
      expect(mockAuth.sendUsername).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('offers the email path as the way out, and forgets the challenge', async () => {
    mockAuth.pending = held;
    const view = await renderWithProviders(<VerifyUsernameScreen />);
    await act(async () => {
      fireEvent.press(view.getByText('Use your email instead'));
    });
    expect(mockNav.back).toBe(1);
    expect(mockAuth.pending).toBeNull();
  });
});
