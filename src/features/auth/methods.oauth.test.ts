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

/**
 * `createURL` reads the native scheme registry, which jest does not have — so this used
 * to be `(path) => \`bingd://${path}\``, a constant, and the assertion that the redirect
 * was `bingd://auth/callback` was an assertion about *this line*. That is how the
 * 2026-09-10 defect shipped: whatever `createURL` answered on a device, the suite passed.
 *
 * Both halves are variables now, and every test that cares sets them. `createURL` is what
 * the environment produced; `expoConfig.scheme` is what `app.config.ts` declared and is
 * the source of truth the code builds the callback from.
 */
let mockCreateURLReturns: string = 'bingd://auth/callback';
jest.mock('expo-linking', () => ({ createURL: () => mockCreateURLReturns }));

/**
 * `extra` is carried through unchanged because `src/lib/env.ts` parses it at import time
 * and throws without it, and `methods.ts` reaches it through the flight recorder. Only
 * `scheme` is the subject here; the rest reproduces what the shared setup mock provides.
 */
let mockConfigScheme: unknown = 'bingd';
let mockExecEnv = 'standalone';
jest.mock('expo-constants', () => ({
  __esModule: true,
  get default() {
    return {
      executionEnvironment: mockExecEnv,
      expoConfig: {
        scheme: mockConfigScheme,
        extra: {
          variant: 'production',
          supabaseUrl: 'https://project.supabase.co',
          supabaseAnonKey: 'anon-key-for-tests',
        },
      },
    };
  },
}));

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
  mockCreateURLReturns = 'bingd://auth/callback';
  mockConfigScheme = 'bingd';
  mockExecEnv = 'standalone';
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

/**
 * The 2026-09-10 defect: Google sign-in from TestFlight ended on `https://bingd.app`
 * with no session and no error.
 *
 * The cause is not in this file's subject and cannot be: GoTrue answers a `redirect_to`
 * it cannot use by **substituting `site_url`** rather than by refusing. Probed against
 * production —
 *
 *   bingd://auth/callback    -> honoured
 *   https://evil.example.com -> https://bingd.app
 *   (omitted)                -> https://bingd.app
 *
 * — so a wrong redirect is a *successful* Google authentication that lands on the
 * marketing site. Nothing throws, nothing is logged, and the person is simply not signed
 * in. `docs/architecture/auth.md` asserted the opposite ("refused by Supabase before the
 * provider is ever contacted") and that sentence was the reason nobody looked here.
 *
 * Every test below fails against the old `oauthRedirectUrl = () => Linking.createURL(...)`,
 * because that returned whatever it was given and the caller sent it.
 */
describe('the callback the app sends is checked before Google is contacted', () => {
  it('builds the callback from the declared scheme rather than from createURL', async () => {
    const methods = loadOn('ios');
    // The environment answers with the https callback — which is *also* allow-listed in
    // Supabase, and is exactly as fatal, because the AASA does not claim /auth/callback
    // so it cannot re-enter the app and Cloudflare serves index.html at 200.
    mockCreateURLReturns = 'https://bingd.app/auth/callback';

    await methods.signInWithGoogle();

    expect(mockAuth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: 'bingd://auth/callback', skipBrowserRedirect: true },
    });
  });

  it('follows the scheme the config declares, so a variant is not hard-coded', async () => {
    const methods = loadOn('ios');
    mockConfigScheme = 'bingd-preview';
    // Deliberately disagreeing with the config, so this cannot pass by the environment
    // happening to be right — which is the failure mode that shipped the defect.
    mockCreateURLReturns = 'bingd://auth/callback';

    await methods.signInWithGoogle();

    expect(mockAuth.signInWithOAuth.mock.calls[0]?.[0]?.options?.redirectTo).toBe(
      'bingd-preview://auth/callback',
    );
  });

  it.each([
    ['an exp URL from a dev server', 'exp://127.0.0.1:8081/--/auth/callback'],
    ['the site itself', 'https://bingd.app'],
    ['nothing at all', ''],
  ])('never sends %s as the redirect', async (_label, produced) => {
    const methods = loadOn('ios');
    mockCreateURLReturns = produced;

    await methods.signInWithGoogle();

    const sent = mockAuth.signInWithOAuth.mock.calls[0]?.[0]?.options?.redirectTo;
    // The config declares `bingd`, so the app's own callback is the only correct answer
    // whatever the environment produced — including an `exp://` URL, which belongs to
    // Expo Go and never to a build that registered a scheme.
    expect(sent).toBe('bingd://auth/callback');
  });

  it('refuses before opening the browser when the config declares no scheme', async () => {
    const methods = loadOn('ios');
    mockConfigScheme = undefined;
    mockCreateURLReturns = 'https://bingd.app/auth/callback';

    const result = await methods.signInWithGoogle();

    // Before the provider, which is the whole ordering: an unusable redirect does not
    // fail at Google, it succeeds and strands the person afterwards.
    expect(mockAuth.signInWithOAuth).not.toHaveBeenCalled();
    expect(mockOpenAuthSession).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect((result as { cancelled: boolean }).cancelled).toBe(false);
    // Recoverable: it names another way in rather than just failing.
    expect((result as { message: string }).message).toMatch(/email or Apple/i);
  });

  /**
   * Expo Go serves the same resolved config a build does, **scheme included**, so the
   * scheme being present says nothing about whether the app can receive `bingd://`. The
   * first version of this fix keyed the Expo Go branch on a missing scheme, which made
   * it unreachable and would have sent Expo Go a callback it cannot answer — the same
   * dead end, one environment over. An independent review caught that; this pins it.
   */
  it('accepts an Expo Go URL even though the config still declares a scheme', async () => {
    const methods = loadOn('ios');
    mockExecEnv = 'storeClient';
    mockConfigScheme = 'bingd';
    mockCreateURLReturns = 'exp://192.168.1.5:8081/--/auth/callback';

    await methods.signInWithGoogle();

    // `exp://**/--/auth/callback` is registered in Supabase for exactly this.
    expect(mockAuth.signInWithOAuth.mock.calls[0]?.[0]?.options?.redirectTo).toBe(
      'exp://192.168.1.5:8081/--/auth/callback',
    );
  });

  it('refuses in Expo Go when createURL did not give an exp callback', async () => {
    const methods = loadOn('ios');
    mockExecEnv = 'storeClient';
    mockCreateURLReturns = 'https://bingd.app/auth/callback';

    const result = await methods.signInWithGoogle();

    // The scheme is declared, but Expo Go has not registered it — so falling back to
    // `bingd://` here would strand the sign-in exactly as the website did.
    expect(mockAuth.signInWithOAuth).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('refuses a callback that comes back on a URL it did not send', async () => {
    const methods = loadOn('ios');
    mockOpenAuthSession.mockResolvedValue({
      type: 'success',
      url: 'https://bingd.app/?code=abc123',
    });

    const result = await methods.signInWithGoogle();

    // A code parsed off a page we did not expect to be on is not a sign-in.
    expect(mockAuth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});

describe('what the guard is allowed to record', () => {
  it('puts no URL, query string or fragment into analytics', async () => {
    const methods = loadOn('ios');
    // After `loadOn`, never before: it calls `jest.resetModules()`, so the factory runs
    // again and the module under test is handed a *different* `jest.fn()` than one
    // required earlier. Grabbing it first watches a mock nobody calls.
    const { track } = jest.requireMock('@/lib/analytics') as { track: jest.Mock };
    track.mockClear();
    mockConfigScheme = undefined;
    mockCreateURLReturns = 'https://bingd.app/auth/callback?code=SECRET#token=SECRET';

    await methods.signInWithGoogle();

    const rejected = track.mock.calls
      .map(([event]) => event)
      .filter((e) => e?.name === 'sign_in_redirect_rejected');
    expect(rejected).toHaveLength(1);
    // A closed set, and nothing else. An OAuth code lives in the query and a token in
    // the fragment, so a property that could hold a URL could hold a credential.
    expect(Object.keys(rejected[0].props)).toEqual(['problem']);
    const serialised = JSON.stringify(rejected[0]);
    expect(serialised).not.toMatch(/SECRET/);
    expect(serialised).not.toMatch(/https:/);
  });

  it('sanitizes a callback down to scheme, host and path', () => {
    const methods = loadOn('ios');

    // The two places a credential can be are the two this cuts off.
    expect(methods.sanitizeRedirect('bingd://auth/callback?code=SECRET')).toBe(
      'bingd://auth/callback',
    );
    expect(methods.sanitizeRedirect('https://bingd.app/#access_token=SECRET')).toBe(
      'https://bingd.app/',
    );
    expect(methods.sanitizeRedirect('')).toBe('(empty)');
    expect(methods.sanitizeRedirect(undefined)).toBe('(empty)');
    expect(methods.sanitizeRedirect(`bingd://${'x'.repeat(400)}`)).toHaveLength(121);
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
