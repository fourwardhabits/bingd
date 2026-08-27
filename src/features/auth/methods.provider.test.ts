/**
 * **Which flow each button actually runs, and what happens after the session exists.**
 *
 * Two of the founder's physical blockers meet in this file.
 *
 * ---------------------------------------------------------------------------
 * PROVIDER ROUTING
 *
 *     "When I sign in with Apple, it just picks the last Google account rather than
 *      asking which one I want."
 *
 * The first question is whether the Apple button had come to invoke Google's flow. It has
 * not, and the backend agrees: on bingd-nonprod every account carries exactly one identity
 * — `apple` on the ones created by the Apple button, `google` on the ones created by the
 * Google button — and not one account carries both, so nothing is crossing over and nothing
 * is being linked by email either.
 *
 * What the observation describes is Apple's own sheet. `AppleAuthentication.signInAsync`
 * has no account picker, because an Apple ID is a property of the device rather than a
 * choice made per app — and the address it offers to share is whatever that Apple ID uses,
 * which for most people is the same Gmail address they would have picked from Google's
 * chooser. "It picked one instead of asking" is a correct description of the platform.
 *
 * That is not a reason to leave it unpinned. These tests assert the separation from the
 * outside, in both directions, so a future edit cannot quietly make the report true.
 *
 * ---------------------------------------------------------------------------
 * THE BUTTON THAT NEVER CAME BACK
 *
 *     sign in → "Signing in…" indefinitely → force-close → reopen → signed in
 *
 * Everything after the credential is the second half of this file. A session exists on the
 * server the moment the exchange succeeds; between that and the button clearing there were
 * three ways to lose the caller, and each has a test:
 *
 *   · **an analytics throw after the session was saved** — `track` sat on the last line of
 *     every method here, so a throw in a third-party SDK rejected a sign-in that had
 *     already happened;
 *   · **anything else `signInWithGoogle` could throw** — it had no `catch` at all, unlike
 *     Apple, so `openAuthSessionAsync` refusing or a callback that is not a URL rejected
 *     out of the function and into a `void` press handler;
 *   · **a commit that never answers** — the network half is bounded by the request
 *     deadline, the Keychain write that follows it was not.
 */

import { Platform } from 'react-native';

const mockAuth = {
  signInWithOAuth: jest.fn(),
  exchangeCodeForSession: jest.fn(),
  signInWithIdToken: jest.fn(),
  verifyOtp: jest.fn(),
  signInWithPassword: jest.fn(),
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithOAuth: (...args: unknown[]) => mockAuth.signInWithOAuth(...args),
      exchangeCodeForSession: (...args: unknown[]) => mockAuth.exchangeCodeForSession(...args),
      signInWithIdToken: (...args: unknown[]) => mockAuth.signInWithIdToken(...args),
      verifyOtp: (...args: unknown[]) => mockAuth.verifyOtp(...args),
      signInWithPassword: (...args: unknown[]) => mockAuth.signInWithPassword(...args),
    },
  },
  startSessionRefresh: () => () => {},
  announceLocalSignOut: () => {},
  authStorageKey: 'sb-test-auth-token',
}));

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

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => mockTrack(...a) }));
jest.mock('@/lib/monitoring', () => ({ reportHandled: jest.fn() }));
jest.mock('@/features/notifications/push', () => ({ releaseDeviceOnSignOut: jest.fn() }));

/** The module reads `Platform.OS` at load, so each platform needs its own fresh import. */
const loadOn = (os: 'ios' | 'android'): typeof import('./methods') => {
  jest.resetModules();
  Platform.OS = os;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./methods');
};

beforeEach(() => {
  jest.useRealTimers();
  mockAuth.signInWithOAuth.mockReset().mockResolvedValue({
    data: { url: 'https://project.supabase.co/auth/v1/authorize?provider=google' },
    error: null,
  });
  mockAuth.exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
  mockAuth.signInWithIdToken.mockReset().mockResolvedValue({ error: null });
  mockAuth.verifyOtp.mockReset().mockResolvedValue({ error: null });
  mockAuth.signInWithPassword.mockReset().mockResolvedValue({ error: null });
  mockOpenAuthSession
    .mockReset()
    .mockResolvedValue({ type: 'success', url: 'bingd://auth/callback?code=abc123' });
  mockAppleSignIn.mockReset().mockResolvedValue({ identityToken: 'apple-token', fullName: null });
  mockTrack.mockReset();
});

// ---------------------------------------------------------------------------

describe('the Apple button runs Apple, and nothing else', () => {
  it('goes native, with an identity token, to the apple provider', async () => {
    const methods = loadOn('ios');

    const result = await methods.signInWithApple();

    expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
    expect(mockAuth.signInWithIdToken).toHaveBeenCalledWith({
      provider: 'apple',
      token: 'apple-token',
    });
    expect(result).toEqual({ ok: true });
  });

  it('never reaches Google: no OAuth authorize, no browser, no code exchange', async () => {
    const methods = loadOn('ios');

    await methods.signInWithApple();

    // The three calls that together *are* the Google flow. Any one of them appearing here
    // would be the founder's report literally true rather than a description of Apple's
    // sheet.
    expect(mockAuth.signInWithOAuth).not.toHaveBeenCalled();
    expect(mockOpenAuthSession).not.toHaveBeenCalled();
    expect(mockAuth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('reports the provider it used as apple, in the analytics event', async () => {
    const methods = loadOn('ios');

    await methods.signInWithApple();

    expect(mockTrack).toHaveBeenCalledWith({
      name: 'sign_in_completed',
      props: { method: 'apple' },
    });
  });
});

describe('the Google button runs Google, and nothing else', () => {
  it('goes through PKCE: authorize, browser, exchange', async () => {
    const methods = loadOn('ios');

    const result = await methods.signInWithGoogle();

    expect(mockAuth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: 'bingd://auth/callback', skipBrowserRedirect: true },
    });
    expect(mockOpenAuthSession).toHaveBeenCalledTimes(1);
    expect(mockAuth.exchangeCodeForSession).toHaveBeenCalledWith('abc123');
    expect(result).toEqual({ ok: true });
  });

  it('never reaches Apple: the native sheet is not opened and no id token is exchanged', async () => {
    const methods = loadOn('ios');

    await methods.signInWithGoogle();

    expect(mockAppleSignIn).not.toHaveBeenCalled();
    expect(mockAuth.signInWithIdToken).not.toHaveBeenCalled();
  });

  it('reports the provider it used as google, in the analytics event', async () => {
    const methods = loadOn('ios');

    await methods.signInWithGoogle();

    expect(mockTrack).toHaveBeenCalledWith({
      name: 'sign_in_completed',
      props: { method: 'google' },
    });
  });

  it('is the only method that opens a browser at all', async () => {
    const methods = loadOn('ios');

    await methods.verifyEmailCode('a@b.co', '123456');
    await methods.signInWithEmailPassword('a@b.co', 'pw');
    await methods.signInWithApple();

    expect(mockOpenAuthSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('an analytics failure cannot undo a sign-in', () => {
  /**
   * The session is already created and already saved by the time `track` is called. A throw
   * there used to be the difference between an account and a spinner.
   */
  it('still succeeds for Apple when track throws', async () => {
    const methods = loadOn('ios');
    mockTrack.mockImplementation(() => {
      throw new Error('posthog exploded');
    });

    await expect(methods.signInWithApple()).resolves.toEqual({ ok: true });
  });

  it('still succeeds for Google when track throws', async () => {
    const methods = loadOn('ios');
    mockTrack.mockImplementation(() => {
      throw new Error('posthog exploded');
    });

    // Previously this rejected — out of a function with no catch, into a floating promise
    // in a press handler, leaving the button disabled and labelled "Signing in…" for the
    // life of the screen.
    await expect(methods.signInWithGoogle()).resolves.toEqual({ ok: true });
  });

  it('still succeeds for the email code when track throws', async () => {
    const methods = loadOn('ios');
    mockTrack.mockImplementation(() => {
      throw new Error('posthog exploded');
    });

    await expect(methods.verifyEmailCode('a@b.co', '123456')).resolves.toEqual({ ok: true });
  });
});

describe('nothing on the Google path may reject', () => {
  it('turns a browser that refuses to open into an outcome', async () => {
    const methods = loadOn('ios');
    mockOpenAuthSession.mockRejectedValue(new Error('Another WebBrowser is already open'));

    const result = await methods.signInWithGoogle();

    expect(result.ok).toBe(false);
    expect(mockAuth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('turns a callback that is not a URL into an outcome', async () => {
    const methods = loadOn('ios');
    mockOpenAuthSession.mockResolvedValue({ type: 'success', url: 'not a url at all' });

    const result = await methods.signInWithGoogle();

    expect(result.ok).toBe(false);
  });

  it('turns an authorize step that throws into an outcome', async () => {
    const methods = loadOn('ios');
    mockAuth.signInWithOAuth.mockRejectedValue(new Error('offline'));

    const result = await methods.signInWithGoogle();

    expect(result.ok).toBe(false);
    expect(mockOpenAuthSession).not.toHaveBeenCalled();
  });

  it('still reads a dismissed sheet as a cancellation rather than a failure', async () => {
    const methods = loadOn('ios');
    mockOpenAuthSession.mockResolvedValue({ type: 'dismiss' });

    expect(await methods.signInWithGoogle()).toEqual({ ok: false, cancelled: true });
  });
});

// ---------------------------------------------------------------------------

describe('a commit that never answers', () => {
  /**
   * The exact founder shape, one layer down. The network half of these calls is bounded by
   * `REQUEST_DEADLINE_MS`; the Keychain write that follows is a promise iOS does not promise
   * to settle, and nothing bounded it. A caller that never gets an answer is a button that
   * never comes back.
   */
  const never = () => new Promise<never>(() => {});

  /**
   * Fake timers installed **before** the call, and a flush before advancing them.
   *
   * Both halves matter. Install them afterwards and `withGrace`'s `setTimeout` is already a
   * real one, so the test waits twelve real seconds; advance without flushing and the
   * Google path has not yet reached the bounded step, because two awaited mocks sit in
   * front of it.
   */
  const settleAfterGrace = async (start: () => Promise<unknown>) => {
    jest.useFakeTimers();
    const pending = start();
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    jest.advanceTimersByTime(13_000);
    const outcome = await pending;
    jest.useRealTimers();
    return outcome;
  };

  it('lets Apple go, with a message that does not claim the account failed', async () => {
    const methods = loadOn('ios');
    mockAuth.signInWithIdToken.mockImplementation(never);

    const result = await settleAfterGrace(() => methods.signInWithApple());

    expect(result).toMatchObject({ ok: false, cancelled: false });
    // Not "we could not sign you in". The session may well land a second later, and
    // `onAuthStateChange` will deliver it — so the copy points at reopening rather than at
    // a failure that may not have happened.
    expect((result as { message: string }).message).toMatch(/reopen the app/i);
  });

  it('lets Google go the same way', async () => {
    const methods = loadOn('ios');
    mockAuth.exchangeCodeForSession.mockImplementation(never);

    const result = await settleAfterGrace(() => methods.signInWithGoogle());

    expect(result).toMatchObject({ ok: false, cancelled: false });
    expect((result as { message: string }).message).toMatch(/reopen the app/i);
  });

  it('lets the store-review password lane go the same way', async () => {
    const methods = loadOn('ios');
    mockAuth.signInWithPassword.mockImplementation(never);

    // Review 52's MAJOR: this lane was left unbounded while the other three were fixed,
    // which would have reproduced the founder's stuck button in front of App Review.
    const result = await settleAfterGrace(() =>
      methods.signInWithEmailPassword('reviewer@example.com', 'pw'),
    );

    expect(result).toMatchObject({ ok: false, cancelled: false });
    expect((result as { message: string }).message).toMatch(/reopen the app/i);
  });

  it('lets the email code go the same way', async () => {
    const methods = loadOn('ios');
    mockAuth.verifyOtp.mockImplementation(never);

    const result = await settleAfterGrace(() => methods.verifyEmailCode('a@b.co', '123456'));

    expect(result).toMatchObject({ ok: false, cancelled: false });
    expect((result as { message: string }).message).toMatch(/reopen the app/i);
  });

  it('does not fire on an ordinary sign-in that answers promptly', async () => {
    const methods = loadOn('ios');

    // The bound exists for silence, not for slowness, and a healthy call must not touch it.
    expect(await methods.signInWithApple()).toEqual({ ok: true });
    expect(await methods.signInWithGoogle()).toEqual({ ok: true });
  });
});
