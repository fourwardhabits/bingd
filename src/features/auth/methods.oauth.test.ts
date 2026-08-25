import { Platform } from 'react-native';

/**
 * **The Apple system dialog the founder photographed on a physical iPhone.**
 *
 *     "bingd" Wants to Use "abheeqyjzekiowkztfxv.supabase.co" to Sign In
 *
 * That is iOS asking permission before an `ASWebAuthenticationSession` may read the
 * Safari cookie jar for a domain, and it names the domain. The domain is the Supabase
 * project host, because that is where the OAuth handshake starts — so the first thing a
 * new user sees is a permission request about a hostname they have never heard of, and
 * none of it is about Google.
 *
 * **Exactly one path in this app can raise it**, and the first test says so. Apple
 * sign-in goes through `AppleAuthentication.signInAsync`, which is native and opens no
 * browser; the email code and password methods are direct API calls. `signInWithGoogle`
 * is the only caller of `openAuthSessionAsync`, so the fix is scoped to it.
 *
 * `preferEphemeralSession` sets `prefersEphemeralWebBrowserSession`: the browser runs on
 * its own empty cookie store rather than Safari's, and with no shared state to ask about
 * iOS does not ask. The prompt is not suppressed — it becomes inapplicable.
 *
 * **The trade is real and is stated in `methods.ts`:** the user signs in to Google every
 * time, because the shared session that made a second sign-in one tap is exactly what is
 * given up. It is worth it here because sign-in happens about once per install — the
 * Supabase session persists in `SecureStore` and is refreshed, so the browser is not part
 * of coming back to the app.
 *
 * What the rest of these assert is that nothing else moved: still PKCE, still the same
 * registered redirect, still a cancellation that reads as a cancellation, and Android
 * untouched.
 */

const mockAuth = {
  signInWithOAuth: jest.fn(),
  exchangeCodeForSession: jest.fn(),
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithOAuth: (...args: unknown[]) => mockAuth.signInWithOAuth(...args),
      exchangeCodeForSession: (...args: unknown[]) => mockAuth.exchangeCodeForSession(...args),
    },
  },
  startSessionRefresh: () => () => {},
}));

// `createURL` reads the native scheme registry, which jest does not have.
jest.mock('expo-linking', () => ({ createURL: (path: string) => `bingd://${path}` }));

const mockOpenAuthSession = jest.fn();
jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: (...args: unknown[]) => mockOpenAuthSession(...args),
}));

const mockAppleSignIn = jest.fn();
jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: () => Promise.resolve(true),
  signInAsync: (...args: unknown[]) => mockAppleSignIn(...args),
  AppleAuthenticationScope: { FULL_NAME: 'name', EMAIL: 'email' },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
  deleteItemAsync: () => Promise.resolve(),
}));

jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));
jest.mock('@/features/notifications/push', () => ({ releaseDeviceOnSignOut: jest.fn() }));

/**
 * The module reads `Platform.OS` when it loads, because the option is a constant rather
 * than a per-call branch — so each platform needs its own fresh import.
 */
const loadOn = (os: 'ios' | 'android'): typeof import('./methods') => {
  jest.resetModules();
  Platform.OS = os;
  // `require` rather than `import()`: the dynamic form needs
  // --experimental-vm-modules, and this is the one place in the suite that has to
  // re-evaluate a module under a different platform.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./methods');
};

beforeEach(() => {
  mockAuth.signInWithOAuth.mockReset().mockResolvedValue({
    data: { url: 'https://project.supabase.co/auth/v1/authorize?provider=google' },
    error: null,
  });
  mockAuth.exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
  mockOpenAuthSession
    .mockReset()
    .mockResolvedValue({ type: 'success', url: 'bingd://auth/callback?code=abc123' });
  mockAppleSignIn.mockReset();
});

const optionsPassed = () => mockOpenAuthSession.mock.calls[0]?.[2];

describe('which path shows the Supabase domain', () => {
  it('is Google, and only Google', async () => {
    const methods = loadOn('ios');

    await methods.signInWithGoogle();

    // The one call into `ASWebAuthenticationSession` in the whole app.
    expect(mockOpenAuthSession).toHaveBeenCalledTimes(1);
  });

  it('is not Apple, which never opens a browser at all', async () => {
    const methods = loadOn('ios');
    mockAppleSignIn.mockResolvedValue({ identityToken: 't', fullName: null });

    await methods.signInWithApple();

    // `AppleAuthentication.signInAsync` is the native sheet. Nothing about the fix
    // below touches it, and nothing about it produced the founder's dialog.
    expect(mockAppleSignIn).toHaveBeenCalled();
    expect(mockOpenAuthSession).not.toHaveBeenCalled();
  });
});

describe('the browser session on iOS', () => {
  it('asks for a private session, so there is no cookie jar to consent to', async () => {
    const methods = loadOn('ios');

    await methods.signInWithGoogle();

    expect(optionsPassed()).toEqual({ preferEphemeralSession: true });
  });

  it('still uses the registered redirect, and still skips the browser redirect', async () => {
    const methods = loadOn('ios');

    await methods.signInWithGoogle();

    // The redirect has to match what is registered in Supabase under URL Configuration
    // or the provider refuses the request. Ephemeral changes the cookie store, not this.
    expect(mockAuth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: 'bingd://auth/callback', skipBrowserRedirect: true },
    });
    expect(mockOpenAuthSession.mock.calls[0]?.[1]).toBe('bingd://auth/callback');
  });

  it('still completes the PKCE exchange from the callback', async () => {
    const methods = loadOn('ios');

    const result = await methods.signInWithGoogle();

    // The callback carries a short-lived code bound to a verifier only this client
    // holds. A private cookie store does not change any of that — which is the whole
    // reason this fix is safe to make.
    expect(mockAuth.exchangeCodeForSession).toHaveBeenCalledWith('abc123');
    expect(result).toEqual({ ok: true });
  });

  it('still reads a dismissed sheet as a cancellation rather than a failure', async () => {
    const methods = loadOn('ios');
    mockOpenAuthSession.mockResolvedValue({ type: 'dismiss' });

    const result = await methods.signInWithGoogle();

    expect(result).toEqual({ ok: false, cancelled: true });
    expect(mockAuth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('can be run again after a cancellation', async () => {
    const methods = loadOn('ios');
    mockOpenAuthSession.mockResolvedValueOnce({ type: 'dismiss' });

    await methods.signInWithGoogle();
    const second = await methods.signInWithGoogle();

    // An ephemeral session leaves nothing behind, which is the point — so a second
    // attempt has to be a clean start rather than a resumed one.
    expect(second).toEqual({ ok: true });
    expect(mockOpenAuthSession).toHaveBeenCalledTimes(2);
    expect(optionsPassed()).toEqual({ preferEphemeralSession: true });
  });
});

describe('android is left alone', () => {
  it('passes no session options at all', async () => {
    const methods = loadOn('android');

    await methods.signInWithGoogle();

    // The option is iOS-only in `expo-web-browser` and Android would ignore it — but
    // "ignored today" is a fact about a library version. Android's Custom Tabs flow
    // works and is not what the founder reported, so the scope is stated rather than
    // assumed.
    expect(optionsPassed()).toBeUndefined();
  });

  it('signs in exactly as it did before', async () => {
    const methods = loadOn('android');

    const result = await methods.signInWithGoogle();

    expect(result).toEqual({ ok: true });
    expect(mockAuth.exchangeCodeForSession).toHaveBeenCalledWith('abc123');
  });
});
