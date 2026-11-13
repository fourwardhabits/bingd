import { FunctionsHttpError } from '@supabase/supabase-js';

/**
 * The client half of username sign-in, against a stubbed Supabase client. The contract:
 * two calls to one Edge Function, `setSession` on success, and nothing from GoTrue's
 * email or password endpoints — those stay the email path's.
 */

const mockInvoke = jest.fn();
const mockSetSession = jest.fn();
const mockForbidden = {
  signInWithOtp: jest.fn(),
  verifyOtp: jest.fn(),
  signInWithPassword: jest.fn(),
  signUp: jest.fn(),
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: (...a: unknown[]) => mockInvoke(...a) },
    auth: {
      setSession: (...a: unknown[]) => mockSetSession(...a),
      signInWithOtp: (...a: unknown[]) => mockForbidden.signInWithOtp(...a),
      verifyOtp: (...a: unknown[]) => mockForbidden.verifyOtp(...a),
      signInWithPassword: (...a: unknown[]) => mockForbidden.signInWithPassword(...a),
      signUp: (...a: unknown[]) => mockForbidden.signUp(...a),
    },
  },
}));

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => mockTrack(...a) }));

import {
  classifyIdentifier,
  clearPendingUsernameChallenge,
  pendingUsernameChallenge,
  sendUsernameCode,
  verifyUsernameCode,
} from './username-sign-in';

const CHALLENGE = 'A'.repeat(43);
const SESSION = {
  access_token: 'at',
  refresh_token: 'rt',
  expires_in: 3600,
  token_type: 'bearer',
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockSetSession.mockReset();
  mockTrack.mockReset();
  Object.values(mockForbidden).forEach((m) => m.mockReset());
  clearPendingUsernameChallenge();
});

afterEach(() => {
  Object.values(mockForbidden).forEach((m) => expect(m).not.toHaveBeenCalled());
});

describe('classifyIdentifier', () => {
  it.each([
    ['ada@bingd.app', { kind: 'email', email: 'ada@bingd.app' }],
    ['  ada@bingd.app ', { kind: 'email', email: 'ada@bingd.app' }],
    [
      'abc123xyz@privaterelay.appleid.com',
      { kind: 'email', email: 'abc123xyz@privaterelay.appleid.com' },
    ],
    ['ada', { kind: 'username', username: 'ada' }],
    ['  Ada_Lovelace ', { kind: 'username', username: 'ada_lovelace' }],
    ['a'.repeat(24), { kind: 'username', username: 'a'.repeat(24) }],
    ['ab', { kind: 'incomplete' }],
    ['a'.repeat(25), { kind: 'incomplete' }],
    ['ada@', { kind: 'incomplete' }],
    ['@ada', { kind: 'incomplete' }],
    ['ada lovelace', { kind: 'incomplete' }],
    ['ada-lovelace', { kind: 'incomplete' }],
    ['', { kind: 'incomplete' }],
  ])('%j → %j', (raw, expected) => {
    expect(classifyIdentifier(raw)).toEqual(expected);
  });
});

describe('sendUsernameCode', () => {
  it('asks the function, and holds the challenge in memory', async () => {
    mockInvoke.mockResolvedValue({
      data: { challengeId: CHALLENGE, message: 'x' },
      error: null,
    });
    expect(await sendUsernameCode('ada')).toEqual({ ok: true });
    expect(mockInvoke).toHaveBeenCalledWith('username-sign-in', {
      body: { action: 'send', identifier: 'ada' },
    });
    expect(pendingUsernameChallenge()).toEqual({ challengeId: CHALLENGE, username: 'ada' });
  });

  it('reports a failed request without holding anything', async () => {
    mockInvoke.mockResolvedValue({ data: null, error: new Error('network') });
    expect(await sendUsernameCode('ada')).toEqual({
      ok: false,
      message: 'That did not work. Try again.',
    });
    expect(pendingUsernameChallenge()).toBeNull();
    mockInvoke.mockRejectedValue(new Error('offline'));
    expect((await sendUsernameCode('ada')).ok).toBe(false);
  });
});

describe('verifyUsernameCode', () => {
  const hold = async () => {
    mockInvoke.mockResolvedValueOnce({ data: { challengeId: CHALLENGE }, error: null });
    await sendUsernameCode('ada');
    mockInvoke.mockReset();
  };

  it('installs the session it is given, and forgets the challenge', async () => {
    await hold();
    mockInvoke.mockResolvedValue({ data: { session: SESSION }, error: null });
    mockSetSession.mockResolvedValue({ error: null });

    expect(await verifyUsernameCode(' 123456 ')).toEqual({ ok: true });
    expect(mockInvoke).toHaveBeenCalledWith('username-sign-in', {
      body: { action: 'verify', challengeId: CHALLENGE, code: '123456' },
    });
    expect(mockSetSession).toHaveBeenCalledWith({ access_token: 'at', refresh_token: 'rt' });
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'sign_in_completed',
      props: { method: 'username_code' },
    });
    expect(pendingUsernameChallenge()).toBeNull();
  });

  it('says one sentence for every refusal about the code', async () => {
    await hold();
    for (const result of [
      { data: null, error: new FunctionsHttpError({ status: 400 }) },
      { data: null, error: new Error('network') },
      { data: { session: { access_token: 'at' } }, error: null },
      { data: {}, error: null },
    ]) {
      mockInvoke.mockResolvedValueOnce(result);
      expect(await verifyUsernameCode('000000')).toEqual({
        ok: false,
        cancelled: false,
        message: 'That code did not work. Check it, or send a new one.',
      });
    }
    expect(mockSetSession).not.toHaveBeenCalled();
    expect(pendingUsernameChallenge()).not.toBeNull();
  });

  it('says try later for the per-IP limit', async () => {
    await hold();
    mockInvoke.mockResolvedValue({
      data: null,
      error: new FunctionsHttpError({ status: 429 }),
    });
    expect(await verifyUsernameCode('000000')).toEqual({
      ok: false,
      cancelled: false,
      message: 'Too many attempts. Try again later, or sign in with your email.',
    });
  });

  it('is not signed in if the session cannot be installed', async () => {
    await hold();
    mockInvoke.mockResolvedValue({ data: { session: SESSION }, error: null });
    mockSetSession.mockResolvedValue({ error: new Error('bad') });
    expect((await verifyUsernameCode('123456')).ok).toBe(false);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('asks nothing without a challenge in hand', async () => {
    expect((await verifyUsernameCode('123456')).ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
