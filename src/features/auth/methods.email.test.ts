import {
  EMAIL_OTP_TYPES,
  sendEmailCode,
  signInWithEmailPassword,
  signInWithGoogle,
  verifyEmailCode,
} from './methods';

const mockAuth = {
  signUp: jest.fn(),
  signInWithPassword: jest.fn(),
  signInWithOtp: jest.fn(),
  verifyOtp: jest.fn(),
  resend: jest.fn(),
  signInWithOAuth: jest.fn(),
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signUp: (...args: unknown[]) => mockAuth.signUp(...args),
      signInWithPassword: (...args: unknown[]) => mockAuth.signInWithPassword(...args),
      signInWithOtp: (...args: unknown[]) => mockAuth.signInWithOtp(...args),
      verifyOtp: (...args: unknown[]) => mockAuth.verifyOtp(...args),
      resend: (...args: unknown[]) => mockAuth.resend(...args),
      signInWithOAuth: (...args: unknown[]) => mockAuth.signInWithOAuth(...args),
    },
  },
  startSessionRefresh: () => () => {},
}));

// `createURL` reads the native scheme registry, which the jest environment does
// not have. What URL comes back is irrelevant to these tests — only that the
// OAuth request is still an OAuth request.
jest.mock('expo-linking', () => ({
  createURL: (path: string) => `bingd://${path}`,
}));

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({
  track: (...args: unknown[]) => mockTrack(...args),
}));

beforeEach(() => {
  Object.values(mockAuth).forEach((fn) => fn.mockReset());
  mockTrack.mockReset();
});

/**
 * Email auth under the founder's final 2026-08-26 decision: **one OTP flow, no passwords
 * for ordinary users, and password sign-in retained for store review only.**
 *
 * Three things are pinned here because each of them fails *silently* if it drifts, and
 * each has already cost this project something:
 *
 *   1. **`shouldCreateUser: true`.** It is what makes one flow serve a new address and a
 *      returning one, and what makes the two indistinguishable from outside.
 *   2. **One `EmailOtpType`, `'email'`.** `signup` and `magiclink` are deprecated in the
 *      installed `@supabase/auth-js`, and a client that picks between them has to know
 *      which kind of address it is holding — the question this flow exists not to ask.
 *   3. **No account creation from a password.** `signUp` is not called from anywhere in
 *      this module any more, and that absence is asserted rather than assumed.
 */
describe('the one email code flow', () => {
  it('sends a code to any address, and lets an unknown one create an account', async () => {
    mockAuth.signInWithOtp.mockResolvedValue({ error: null });

    expect(await sendEmailCode('  new@user.example  ')).toEqual({ ok: true });
    expect(mockAuth.signInWithOtp).toHaveBeenCalledWith({
      email: 'new@user.example',
      options: { shouldCreateUser: true },
    });
    // Creating the account is GoTrue's job on this path. Nothing in this module calls
    // signUp any more, and a password is never part of creating a Bingd account.
    expect(mockAuth.signUp).not.toHaveBeenCalled();
  });

  /**
   * The anti-enumeration property, asserted as the thing it actually is: **the same
   * answer twice.**
   *
   * With `shouldCreateUser: false` — which is what the password-first amendment used —
   * GoTrue answered a known address with a send and an unknown one with `otp_disabled`,
   * and independent review 44 recorded that as an accepted risk. There is nothing left to
   * accept: both cases are a send, so repeated attempts reveal nothing about an address.
   */
  it('answers a known address and an unknown one identically', async () => {
    mockAuth.signInWithOtp.mockResolvedValue({ error: null });

    const unknown = await sendEmailCode('nobody@user.example');
    const known = await sendEmailCode('ada@user.example');

    expect(unknown).toEqual(known);
    expect(mockAuth.signInWithOtp.mock.calls[0][0].options).toEqual(
      mockAuth.signInWithOtp.mock.calls[1][0].options,
    );
  });

  it('says something usable about a rate limit and about closed signups', async () => {
    mockAuth.signInWithOtp.mockResolvedValue({
      error: { code: 'over_email_send_rate_limit', message: 'rate limited' },
    });
    expect(await sendEmailCode('ada@user.example')).toEqual({
      ok: false,
      cancelled: false,
      message: 'Too many emails just now. Wait a minute and try again.',
    });

    mockAuth.signInWithOtp.mockResolvedValue({
      error: { code: 'signup_disabled', message: 'Signups not allowed' },
    });
    expect(await sendEmailCode('ada@user.example')).toEqual({
      ok: false,
      cancelled: false,
      message: 'New accounts are not being accepted right now.',
    });
  });

  /**
   * **The pin.** `'email'`, read off the `EmailOtpType` union in the installed
   * `@supabase/auth-js@2.112.3` and off its own documentation — *"`signup` and `magiclink`
   * types are deprecated … `email` – Used when verifying an OTP sent to the user's email
   * during sign-up or sign-in"* — rather than guessed, and asserted as a literal so that
   * changing it is a test failure rather than a support ticket.
   */
  it('verifies every code as type "email", new account or returning one', async () => {
    mockAuth.verifyOtp.mockResolvedValue({ error: null });

    expect(await verifyEmailCode('  ada@user.example ', ' 123456 ')).toEqual({ ok: true });
    expect(mockAuth.verifyOtp).toHaveBeenCalledWith({
      email: 'ada@user.example',
      token: '123456',
      type: 'email',
    });
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'sign_in_completed',
      props: { method: 'email_code' },
    });
  });

  it('names one type and only one', () => {
    // One value, because one flow. Two constants here would mean the client was choosing
    // between them, which would mean it knew whether the address already had an account.
    expect(EMAIL_OTP_TYPES).toEqual({ code: 'email' });
  });

  it('reports a bad code without saying which kind of bad', async () => {
    mockAuth.verifyOtp.mockResolvedValue({
      error: { code: 'otp_expired', message: 'Token has expired or is invalid' },
    });

    const result = await verifyEmailCode('ada@user.example', '000000');
    expect(result.ok).toBe(false);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('never reaches the password or OAuth endpoints', async () => {
    mockAuth.signInWithOtp.mockResolvedValue({ error: null });
    await sendEmailCode('ada@user.example');

    expect(mockAuth.signInWithPassword).not.toHaveBeenCalled();
    expect(mockAuth.signInWithOAuth).not.toHaveBeenCalled();
  });
});

/**
 * The store-review back door.
 *
 * Supabase's password capability is retained; the product affordance for creating a
 * password is not. Everything here is about a single account a founder provisions in the
 * dashboard so that App Review and Play review can get past the sign-in screen without a
 * mailbox — `docs/release/store-review-access.md`.
 */
describe('signing in with a password', () => {
  it('signs in with the trimmed email and reports success', async () => {
    mockAuth.signInWithPassword.mockResolvedValue({ data: {}, error: null });

    const result = await signInWithEmailPassword('  review@bingd.app  ', 'hunter2');

    expect(mockAuth.signInWithPassword).toHaveBeenCalledWith({
      email: 'review@bingd.app',
      password: 'hunter2',
    });
    expect(result).toEqual({ ok: true });
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'sign_in_completed',
      props: { method: 'password' },
    });
  });

  /**
   * **It cannot create an account, and this is the assertion that says so.**
   *
   * A password screen whose failure path fell back to `signUp` would be a second
   * registration route offering ordinary people a password to invent, on a product with
   * no way to reset one. There is no such path, and no `signUp` call anywhere in this
   * module.
   */
  it('creates nothing when the credentials do not match', async () => {
    mockAuth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
    });

    expect(await signInWithEmailPassword('review@bingd.app', 'wrong')).toEqual({
      ok: false,
      cancelled: false,
      message: 'We could not sign you in with that email and password.',
    });
    expect(mockAuth.signUp).not.toHaveBeenCalled();
    expect(mockAuth.signInWithOtp).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  /**
   * One sentence for every refusal, which is what "generic safe error copy" has to mean
   * on this screen specifically.
   *
   * An ordinary Bingd account has no password at all, so a message that distinguished
   * "no account", "no password on this account" and "wrong password" would be answering
   * questions about addresses for anyone who asked — from the one screen in the app that
   * a stranger has no legitimate reason to be on.
   */
  it('says the same thing for a wrong password, an unknown address and an unconfirmed one', async () => {
    const outcomes = [];
    for (const code of ['invalid_credentials', 'user_not_found', 'email_not_confirmed']) {
      mockAuth.signInWithPassword.mockResolvedValue({ data: {}, error: { code, message: code } });
      outcomes.push(await signInWithEmailPassword('someone@user.example', 'pw'));
    }

    expect(new Set(outcomes.map((o) => JSON.stringify(o))).size).toBe(1);
    expect(outcomes[0]).toEqual({
      ok: false,
      cancelled: false,
      message: 'We could not sign you in with that email and password.',
    });
  });

  it('separates a rate limit, which is not about the credentials', async () => {
    mockAuth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { code: 'over_request_rate_limit', message: 'Request rate limit reached' },
    });

    expect(await signInWithEmailPassword('review@bingd.app', 'pw')).toEqual({
      ok: false,
      cancelled: false,
      message: 'Too many attempts just now. Wait a minute and try again.',
    });
  });
});

describe('the flows this decision did not touch', () => {
  it('signInWithGoogle still starts a PKCE OAuth request', async () => {
    // Failing the request at the first step keeps the test on the supabase
    // surface — the in-app browser half is Expo's, not this module's.
    mockAuth.signInWithOAuth.mockResolvedValue({ data: null, error: { message: 'offline' } });

    expect(await signInWithGoogle()).toEqual({ ok: false, cancelled: false, message: 'offline' });
    expect(mockAuth.signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google' }),
    );
    expect(mockAuth.signInWithPassword).not.toHaveBeenCalled();
    expect(mockAuth.signUp).not.toHaveBeenCalled();
  });
});

/**
 * Nothing here may ever be written down.
 *
 * A password and a one-time code are the two secrets this module handles, and the two
 * places they leak are an analytics property and an error message echoed into a report.
 * `track` is called on success with a method name and nothing else, and every failure
 * path returns a string this file chose or Supabase's own — never the input.
 */
describe('secrets', () => {
  it('sends no password or code to analytics', async () => {
    mockAuth.signInWithPassword.mockResolvedValue({ data: {}, error: null });
    await signInWithEmailPassword('review@bingd.app', 'hunter2');

    mockAuth.verifyOtp.mockResolvedValue({ error: null });
    await verifyEmailCode('review@bingd.app', '123456');

    const everything = JSON.stringify(mockTrack.mock.calls);
    expect(everything).not.toContain('hunter2');
    expect(everything).not.toContain('123456');
    // Nor the address, which `analytics.ts` already forbids.
    expect(everything).not.toContain('review@bingd.app');
  });

  it('returns no password or code in a failure message', async () => {
    mockAuth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
    });
    const signIn = await signInWithEmailPassword('review@bingd.app', 'hunter2');
    expect(JSON.stringify(signIn)).not.toContain('hunter2');

    mockAuth.verifyOtp.mockResolvedValue({
      error: { code: 'otp_expired', message: 'Token has expired or is invalid' },
    });
    const verify = await verifyEmailCode('review@bingd.app', '123456');
    expect(JSON.stringify(verify)).not.toContain('123456');
  });
});
