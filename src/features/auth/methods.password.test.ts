import {
  sendEmailCode,
  signInWithEmailPassword,
  signInWithGoogle,
  verifyEmailCode,
} from './methods';

const mockAuth = {
  signInWithPassword: jest.fn(),
  signInWithOtp: jest.fn(),
  verifyOtp: jest.fn(),
  signInWithOAuth: jest.fn(),
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: unknown[]) => mockAuth.signInWithPassword(...args),
      signInWithOtp: (...args: unknown[]) => mockAuth.signInWithOtp(...args),
      verifyOtp: (...args: unknown[]) => mockAuth.verifyOtp(...args),
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
 * The password path exists for store reviewers — the one class of user who cannot
 * receive a one-time code — and it must be sign-in only. These tests pin the three
 * things that make it safe to ship: it calls `signInWithPassword` (which cannot
 * create an account), a wrong password reads as a human sentence rather than an
 * API code, and adding it changed nothing about the code and OAuth flows.
 */
describe('signInWithEmailPassword', () => {
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
      cancelled: false,
      message: 'That email and password do not match.',
    });
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('keeps every other error message as Supabase said it', async () => {
    mockAuth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { code: 'over_request_rate_limit', message: 'Request rate limit reached' },
    });

    expect(await signInWithEmailPassword('review@bingd.app', 'pw')).toEqual({
      ok: false,
      cancelled: false,
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

describe('the existing flows, unchanged by the password path', () => {
  it('sendEmailCode still sends a code and may create the account', async () => {
    mockAuth.signInWithOtp.mockResolvedValue({ error: null });

    expect(await sendEmailCode('new@user.example')).toEqual({ ok: true });
    expect(mockAuth.signInWithOtp).toHaveBeenCalledWith({
      email: 'new@user.example',
      options: { shouldCreateUser: true },
    });
    expect(mockAuth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('verifyEmailCode still verifies as an email OTP', async () => {
    mockAuth.verifyOtp.mockResolvedValue({ error: null });

    expect(await verifyEmailCode('new@user.example', ' 123456 ')).toEqual({ ok: true });
    expect(mockAuth.verifyOtp).toHaveBeenCalledWith({
      email: 'new@user.example',
      token: '123456',
      type: 'email',
    });
  });

  it('signInWithGoogle still starts a PKCE OAuth request, not a password one', async () => {
    // Failing the request at the first step keeps the test on the supabase
    // surface — the in-app browser half is Expo's, not this module's.
    mockAuth.signInWithOAuth.mockResolvedValue({ data: null, error: { message: 'offline' } });

    expect(await signInWithGoogle()).toEqual({ ok: false, cancelled: false, message: 'offline' });
    expect(mockAuth.signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google' }),
    );
    expect(mockAuth.signInWithPassword).not.toHaveBeenCalled();
  });
});
