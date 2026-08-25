import {
  EMAIL_OTP_TYPES,
  resendSignUpCode,
  sendEmailCode,
  signInWithEmailPassword,
  signInWithGoogle,
  signUpWithEmailPassword,
  verifyEmailCode,
  verifySignUpCode,
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
 * Email auth, after the founder's 2026-08-26 reversal.
 *
 * Password is the default method and passwordless is an explicit secondary sign-in. The
 * three things these tests exist to pin are the three that fail *silently* if they drift:
 *
 *   1. **The OTP type per flow.** A signup token and a magic-link token look identical
 *      and are stored in different columns. Verifying one as the other answers
 *      `otp_expired`, which every screen reports as "that code did not work" — a correct
 *      code being called wrong, with nothing anywhere saying why.
 *   2. **`shouldCreateUser: false`.** With it true, "Sign in without a password" is a
 *      second registration route that mints a permanent account for every typo.
 *   3. **`resend` and not a second `signUp`.** The latter carries a password and would
 *      overwrite the pending one.
 */
describe('creating an account with a password', () => {
  it('signs up with the trimmed email and reports that verification is needed', async () => {
    // What Supabase returns with "Confirm email" on: a user, and no session.
    mockAuth.signUp.mockResolvedValue({
      data: { user: { id: 'u1', identities: [{ id: 'i1' }] }, session: null },
      error: null,
    });

    const result = await signUpWithEmailPassword('  new@user.example  ', 'hunter22');

    expect(mockAuth.signUp).toHaveBeenCalledWith({
      email: 'new@user.example',
      password: 'hunter22',
    });
    expect(result).toEqual({ ok: true, needsVerification: true });
    // Nothing is completed yet — the account cannot be used until the code is typed.
    expect(mockTrack).not.toHaveBeenCalled();
  });

  /**
   * `needsVerification` is read from the session rather than assumed, so the screen
   * behaves correctly whether or not the project requires confirmation. Turning
   * confirmation off is not the intended configuration — §3 forbids solving the
   * template problem that way — but a client that stranded somebody on a code screen
   * for a code that will never arrive would be wrong regardless of the setting.
   */
  it('reports no verification needed when a session comes straight back', async () => {
    mockAuth.signUp.mockResolvedValue({
      data: { user: { id: 'u1' }, session: { access_token: 't' } },
      error: null,
    });

    expect(await signUpWithEmailPassword('new@user.example', 'hunter22')).toEqual({
      ok: true,
      needsVerification: false,
    });
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'sign_in_completed',
      props: { method: 'password' },
    });
  });

  /**
   * The anti-enumeration case, and the one worth being explicit about.
   *
   * Supabase answers an already-registered address with a plausible user whose
   * `identities` array is empty, and sends nothing. Reading that array and saying "you
   * already have an account" would turn this form into an address-checker. The same
   * answer goes back either way; `verify.tsx` carries "Already have an account? Sign in"
   * so the person is not stranded.
   */
  it('says exactly the same thing for an address that already has an account', async () => {
    mockAuth.signUp.mockResolvedValue({
      data: { user: { id: 'obfuscated', identities: [] }, session: null },
      error: null,
    });

    expect(await signUpWithEmailPassword('taken@user.example', 'hunter22')).toEqual({
      ok: true,
      needsVerification: true,
    });
  });

  it('says something usable about a weak password and a rate limit', async () => {
    mockAuth.signUp.mockResolvedValue({
      data: {},
      error: { code: 'weak_password', message: 'Password should be at least 6 characters' },
    });
    expect(await signUpWithEmailPassword('a@b.co', 'x')).toEqual({
      ok: false,
      message: 'Choose a longer password.',
    });

    mockAuth.signUp.mockResolvedValue({
      data: {},
      error: { code: 'over_email_send_rate_limit', message: 'rate limited' },
    });
    expect(await signUpWithEmailPassword('a@b.co', 'hunter22')).toEqual({
      ok: false,
      message: 'Too many emails just now. Wait a minute and try again.',
    });
  });

  it('keeps an unrecognised error as Supabase said it', async () => {
    mockAuth.signUp.mockResolvedValue({
      data: {},
      error: { code: 'unexpected_failure', message: 'Database error saving new user' },
    });
    expect(await signUpWithEmailPassword('a@b.co', 'hunter22')).toEqual({
      ok: false,
      message: 'Database error saving new user',
    });
  });

  it('never reaches the passwordless or OAuth endpoints', async () => {
    mockAuth.signUp.mockResolvedValue({ data: { user: {}, session: null }, error: null });
    await signUpWithEmailPassword('a@b.co', 'hunter22');

    expect(mockAuth.signInWithOtp).not.toHaveBeenCalled();
    expect(mockAuth.signInWithOAuth).not.toHaveBeenCalled();
  });
});

describe('verifying a new account in the app', () => {
  /**
   * **The pin.** `'signup'`, read off `EmailOtpType` in the installed
   * `@supabase/auth-js@2.112.3` rather than guessed, and asserted as a literal here so
   * that changing it is a test failure rather than a support ticket.
   */
  it('verifies a Confirm-signup token as type "signup"', async () => {
    mockAuth.verifyOtp.mockResolvedValue({ error: null });

    expect(await verifySignUpCode('  new@user.example ', ' 123456 ')).toEqual({ ok: true });
    expect(mockAuth.verifyOtp).toHaveBeenCalledWith({
      email: 'new@user.example',
      token: '123456',
      type: 'signup',
    });
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'sign_in_completed',
      props: { method: 'password' },
    });
  });

  it('names the two types it uses and no others', () => {
    // A signup token and a passwordless token are verified against different columns.
    // One constant, two values, and both asserted — so a rename cannot quietly make
    // them the same.
    expect(EMAIL_OTP_TYPES).toEqual({ signup: 'signup', passwordless: 'email' });
  });

  it('reports a bad code without saying which kind of bad', async () => {
    mockAuth.verifyOtp.mockResolvedValue({
      error: { code: 'otp_expired', message: 'Token has expired or is invalid' },
    });

    const result = await verifySignUpCode('new@user.example', '000000');
    expect(result.ok).toBe(false);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('resends through resend(), which carries no password', async () => {
    mockAuth.resend.mockResolvedValue({ error: null });

    expect(await resendSignUpCode(' new@user.example ')).toEqual({ ok: true });
    expect(mockAuth.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'new@user.example',
    });
    // A second `signUp` would overwrite the pending password with whatever was in the
    // form, which is not what "send it again" means.
    expect(mockAuth.signUp).not.toHaveBeenCalled();
  });

  it('says something usable when the resend is rate limited', async () => {
    mockAuth.resend.mockResolvedValue({
      error: { code: 'over_email_send_rate_limit', message: 'rate limited' },
    });

    expect(await resendSignUpCode('new@user.example')).toEqual({
      ok: false,
      cancelled: false,
      message: 'Too many emails just now. Wait a minute and try again.',
    });
  });
});

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

  it('turns a wrong password into a human sentence', async () => {
    mockAuth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
    });

    expect(await signInWithEmailPassword('review@bingd.app', 'wrong')).toEqual({
      ok: false,
      unverified: false,
      message: 'That email and password do not match.',
    });
    expect(mockTrack).not.toHaveBeenCalled();
  });

  /**
   * The recovery case, and the reason this is a third outcome rather than a message.
   *
   * Somebody created an account and closed Bingd before typing the code. The password is
   * right and the account cannot be used, and folding that into "that email and password
   * do not match" tells them something false about the password — for ever, since
   * nothing else in the app would ever correct it.
   */
  it('reports an unconfirmed account as its own outcome, not as a wrong password', async () => {
    mockAuth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { code: 'email_not_confirmed', message: 'Email not confirmed' },
    });

    expect(await signInWithEmailPassword('pending@user.example', 'hunter22')).toEqual({
      ok: false,
      unverified: true,
    });
  });

  it('keeps every other error message as Supabase said it', async () => {
    mockAuth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { code: 'over_request_rate_limit', message: 'Request rate limit reached' },
    });

    expect(await signInWithEmailPassword('review@bingd.app', 'pw')).toEqual({
      ok: false,
      unverified: false,
      message: 'Request rate limit reached',
    });
  });

  it('never calls the OTP or OAuth endpoints', async () => {
    mockAuth.signInWithPassword.mockResolvedValue({ data: {}, error: null });
    await signInWithEmailPassword('review@bingd.app', 'pw');

    expect(mockAuth.signInWithOtp).not.toHaveBeenCalled();
    expect(mockAuth.signInWithOAuth).not.toHaveBeenCalled();
  });
});

describe('signing in without a password', () => {
  /**
   * **The pin that stops a second signup route existing.**
   *
   * This was `shouldCreateUser: true` while the code flow was the door, and correctly
   * so. As a secondary sign-in it would mint a permanent `auth.users` row for every
   * mistyped address, and hand back an account with no password from a screen whose
   * sibling is the one that sets one.
   */
  it('refuses to create an account for an unknown address', async () => {
    mockAuth.signInWithOtp.mockResolvedValue({ error: null });

    expect(await sendEmailCode('known@user.example')).toEqual({ ok: true });
    expect(mockAuth.signInWithOtp).toHaveBeenCalledWith({
      email: 'known@user.example',
      options: { shouldCreateUser: false },
    });
    expect(mockAuth.signUp).not.toHaveBeenCalled();
  });

  /**
   * GoTrue reports the refusal as `otp_disabled` — "Signups not allowed for otp" —
   * which describes the setting rather than the situation. The replacement says what to
   * do, and says the *same* thing a send failure would, so this does not become an
   * address-checker either.
   */
  it('says something usable when the address has no account', async () => {
    mockAuth.signInWithOtp.mockResolvedValue({
      error: { code: 'otp_disabled', message: 'Signups not allowed for otp' },
    });

    expect(await sendEmailCode('nobody@user.example')).toEqual({
      ok: false,
      cancelled: false,
      message: 'We could not send a code to that address. Check it, or create an account.',
    });
  });

  it('verifies a passwordless token as type "email"', async () => {
    mockAuth.verifyOtp.mockResolvedValue({ error: null });

    expect(await verifyEmailCode('new@user.example', ' 123456 ')).toEqual({ ok: true });
    expect(mockAuth.verifyOtp).toHaveBeenCalledWith({
      email: 'new@user.example',
      token: '123456',
      type: 'email',
    });
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'sign_in_completed',
      props: { method: 'email_code' },
    });
  });
});

describe('the flows this amendment did not touch', () => {
  it('signInWithGoogle still starts a PKCE OAuth request, not a password one', async () => {
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
    await verifySignUpCode('review@bingd.app', '123456');

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
    const verify = await verifySignUpCode('review@bingd.app', '123456');
    expect(JSON.stringify(verify)).not.toContain('123456');
  });
});
