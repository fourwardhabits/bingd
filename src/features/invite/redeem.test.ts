/**
 * Redemption, from the client's side.
 *
 * The server owns every rule and `supabase/tests/invite.test.mjs` is where those are
 * asserted. What is testable only here is the pair of decisions this layer makes about
 * the server's answers: **what gets emitted**, and **whether the held token survives**.
 *
 * Both have a failure mode that no server test would catch. An event on the wrong
 * answer inflates the one growth number the founder is watching; a token cleared on the
 * wrong answer silently loses somebody's invitation, and a token kept on the wrong
 * answer replays a spent redemption at every cold start.
 */

import { claimForRedemption } from './pending';
import { acceptInvite, previewInvite, resumePendingInvite } from './redeem';

const mockTrack = jest.fn();
const mockSetAcquisition = jest.fn();
const mockRpc = jest.fn();

// Evaluated when the module under test is first required, which hoisting puts before
// the consts above are initialised — so each closes over the call rather than the
// function, the same shape `invite-link.test.ts` uses.
jest.mock('@/lib/analytics', () => ({
  __esModule: true,
  track: (...args: unknown[]) => mockTrack(...args),
  setAcquisition: (...args: unknown[]) => mockSetAcquisition(...args),
}));
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => mockRpc(...args) } }));

let mockStored: Record<string, string> = {};
// The key is the un-prefixed name, because this stands in for `readPref`/`writePref`
// themselves rather than for the storage under them — the real `pref.` prefix is
// applied inside the module being replaced.
jest.mock('@/lib/prefs', () => ({
  __esModule: true,
  readPref: (name: string) => Promise.resolve(mockStored[name] ? JSON.parse(mockStored[name]) : null),
  writePref: (name: string, value: unknown) => {
    mockStored[name] = JSON.stringify(value);
    return Promise.resolve();
  },
}));

// A fresh id per mint, so a module-level constant cannot pass for a generator — which
// is exactly what hid review 26b's Major: with one constant, an id released and one
// held are indistinguishable.
let mockIssued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `operation-${(mockIssued += 1)}` }));

const TOKEN = 'a3f19c2b4d5e6f708192a3b4c5d6e7f8';
const ME = 'user-me';

const answers = (body: unknown, error: unknown = null) =>
  mockRpc.mockResolvedValue({ data: body, error });

beforeEach(() => {
  jest.clearAllMocks();
  mockStored = {};
  mockIssued = 0;
});

describe('acceptInvite', () => {
  it('sends the call that means somebody pressed Accept, and only that one', async () => {
    answers({ status: 'ok', inviter_username: 'ada' });

    await acceptInvite(TOKEN, 'op-1', ME);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('accept_invite', {
      p_operation_id: 'op-1',
      p_token: TOKEN,
      p_accepting_user: ME,
    });
  });

  it('reports the inviter, the follow state, and records the redemption', async () => {
    answers({
      status: 'ok',
      inviter_id: 'user-2',
      inviter_username: 'ada',
      follow_state: 'approved',
    });

    expect(await acceptInvite(TOKEN, 'op-1', ME)).toEqual({
      outcome: 'redeemed',
      inviterUsername: 'ada',
      followState: 'approved',
      connected: false,
    });
    expect(mockTrack).toHaveBeenCalledWith({ name: 'invite_redeemed' });
    // The first honest writer this field has ever had.
    expect(mockSetAcquisition).toHaveBeenCalledWith({ source: 'invite' });
  });

  it('carries the follow state the server reports, not the one it would have created', async () => {
    /**
     * PRD §17 clause 3: a private inviter receives a request rather than a follow. And
     * an invitee who already followed their inviter keeps the state they had — telling
     * somebody approved months ago that they have "asked to follow" would be wrong.
     */
    answers({ status: 'ok', inviter_username: 'ada', follow_state: 'pending' });
    expect(await acceptInvite(TOKEN, 'op-1', ME)).toMatchObject({ followState: 'pending' });

    // A backend that predates the acceptance semantics answers without the key. Null,
    // not a guess: the screen then says the invitation was recorded and nothing about
    // following, which is the only honest thing it can say.
    answers({ status: 'ok', inviter_username: 'ada' });
    expect(await acceptInvite(TOKEN, 'op-1', ME)).toMatchObject({ followState: null });

    answers({ status: 'ok', inviter_username: 'ada', follow_state: 'something_else' });
    expect(await acceptInvite(TOKEN, 'op-1', ME)).toMatchObject({ followState: null });
  });

  it('sends the token to nobody', async () => {
    // Not to PostHog and not as an event property. `ALLOWED_PROPERTY_KEYS` would strip
    // it, and `FORBIDDEN_PROPERTY_KEYS` names it — this asserts it is not offered.
    answers({ status: 'ok', inviter_username: 'ada' });

    await acceptInvite(TOKEN, 'op-1', ME);

    for (const call of [...mockTrack.mock.calls, ...mockSetAcquisition.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
      expect(JSON.stringify(call)).not.toContain('ada');
    }
  });

  it('records nothing on a replay, which wrote no row', async () => {
    // The designed path: a redemption commits, the reply is lost, the retry carries the
    // same operation id. Counting it again would report two arrivals from one person.
    answers({ status: 'already_applied', attributed: true });

    expect(await acceptInvite(TOKEN, 'op-1', ME)).toEqual({
      outcome: 'already_applied',
      attributed: true,
    });
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockSetAcquisition).not.toHaveBeenCalled();
  });

  it('records nothing for any refusal', async () => {
    for (const reason of ['invalid', 'self', 'blocked', 'unavailable', 'already_attributed']) {
      mockTrack.mockClear();
      answers({ status: 'refused', reason });

      const result = await acceptInvite(TOKEN, 'op-1', ME);

      expect(result.outcome).not.toBe('redeemed');
      expect(mockTrack).not.toHaveBeenCalled();
    }
  });

  it('collapses blocked and unavailable into one outcome', async () => {
    /**
     * The server tells them apart because the caller is party to a block. The screen
     * must not: a message that read "they have blocked you" where the other read "that
     * account is unavailable" would let anybody detect a block, or a suspension, by
     * redeeming a link they were forwarded.
     */
    answers({ status: 'refused', reason: 'blocked' });
    expect(await acceptInvite(TOKEN, 'op-1', ME)).toEqual({ outcome: 'unavailable' });

    answers({ status: 'refused', reason: 'unavailable' });
    expect(await acceptInvite(TOKEN, 'op-1', ME)).toEqual({ outcome: 'unavailable' });
  });

  it('treats a refusal it does not recognise as invalid rather than as success', async () => {
    // A reason added to the server and not here. The safe reading is "this did not
    // work", not "assume it did".
    answers({ status: 'refused', reason: 'something_new' });

    expect(await acceptInvite(TOKEN, 'op-1', ME)).toEqual({ outcome: 'invalid' });
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('reads an unanswered call as possibly committed', async () => {
    answers(null, { code: '', message: 'Network request failed' });

    expect(await acceptInvite(TOKEN, 'op-1', ME)).toEqual({
      outcome: 'failed',
      message: 'Network request failed',
      changed: true,
    });
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('reads a raised refusal as a refusal, so the retry may mint a fresh id', async () => {
    answers(null, { code: '53400', message: 'too many' });

    expect(await acceptInvite(TOKEN, 'op-1', ME)).toMatchObject({
      outcome: 'failed',
      changed: false,
    });
  });

  it('treats a 200 with no body as a change, because the request was answered', async () => {
    answers(null);

    expect(await acceptInvite(TOKEN, 'op-1', ME)).toMatchObject({ outcome: 'failed', changed: true });
  });
});

describe('previewInvite', () => {
  it('names the inviter', async () => {
    answers({ status: 'ok', kind: 'personal', inviter_username: 'ada', inviter_display_name: 'Ada' });

    expect(await previewInvite(TOKEN)).toEqual({
      outcome: 'ready',
      kind: 'personal',
      inviterUsername: 'ada',
      inviterDisplayName: 'Ada',
    });
    expect(mockRpc).toHaveBeenCalledWith('invite_preview', { p_token: TOKEN });
  });

  it('carries each refusal, and reads an unknown one as invalid', async () => {
    for (const reason of ['self', 'unavailable', 'already_attributed'] as const) {
      answers({ status: 'refused', reason });
      expect(await previewInvite(TOKEN)).toEqual({ outcome: reason });
    }
    answers({ status: 'refused', reason: 'something_new' });
    expect(await previewInvite(TOKEN)).toEqual({ outcome: 'invalid' });
  });

  it('does not read an answer with no name as ready, because Accept would follow it', async () => {
    answers({ status: 'ok' });
    expect(await previewInvite(TOKEN)).toEqual({ outcome: 'invalid' });
  });

  it('throws when it went unanswered, so the screen cannot offer Accept', async () => {
    answers(null, { code: '', message: 'Network request failed' });
    await expect(previewInvite(TOKEN)).rejects.toMatchObject({ message: 'Network request failed' });
  });
});

describe('resumePendingInvite', () => {
  /** What the module actually persisted, or undefined if it never wrote. */
  const held = () => JSON.parse(mockStored['invite.pendingToken'] ?? 'null') as string | null;

  const hold = (token: string) => {
    mockStored['invite.pendingToken'] = JSON.stringify(token);
  };

  /** A press of Accept whose answer never came, as storage records it. */
  const pressed = (token: string, id = 'operation-from-the-press') => {
    hold(token);
    mockStored['invite.acceptedOperation'] = JSON.stringify({ id, userId: ME, token });
  };

  it('does nothing, and calls nothing, when this device holds no invitation', async () => {
    // Which is almost every launch. The cost of finding out has to be one storage read
    // and no request.
    expect(await resumePendingInvite(ME)).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('ignores a stored value that is not a token', async () => {
    mockStored['invite.pendingToken'] = JSON.stringify('../../etc/passwd');

    expect(await resumePendingInvite(ME)).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('hands an unanswered invitation back to be shown, and sends nothing', async () => {
    // The whole of B-1 on this side. It used to redeem here.
    hold(TOKEN);

    expect(await resumePendingInvite(ME)).toBe(TOKEN);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(held()).toBe(TOKEN);
  });

  it('does not send a token an older build left beside its own operation id', async () => {
    hold(TOKEN);
    mockStored['invite.pendingOperation'] = JSON.stringify('op-from-the-old-background-path');

    expect(await resumePendingInvite(ME)).toBe(TOKEN);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('replays a press whose answer was lost, with the same id', async () => {
    // The id belongs to the intent, and here the intent survives the process: an acceptance
    // that commits and loses its reply has to be recognised, not spent twice.
    pressed(TOKEN);
    answers({ status: 'already_applied', attributed: true });

    expect(await resumePendingInvite(ME)).toBeNull();

    expect(mockRpc).toHaveBeenCalledWith('accept_invite', {
      p_operation_id: 'operation-from-the-press',
      p_token: TOKEN,
      p_accepting_user: ME,
    });
    expect(held()).toBeNull();
  });

  it('does not replay another account’s press, which on a shared phone accepts for them', async () => {
    // Account A pressed Accept and the reply was lost. Account B signs in on the same phone.
    // B has decided nothing, so B gets the screen.
    pressed(TOKEN);

    expect(await resumePendingInvite('user-who-only-signed-in')).toBe(TOKEN);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('does not replay a press made on a different invitation', async () => {
    // What a process killed halfway through swapping the held invitation leaves behind.
    pressed('b'.repeat(32));
    hold(TOKEN);

    expect(await resumePendingInvite(ME)).toBe(TOKEN);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('carries the same id into the next launch while the call stays unsettled', async () => {
    pressed(TOKEN);
    answers(null, { code: '', message: 'Network request failed' });
    await resumePendingInvite(ME);
    expect(held()).toBe(TOKEN);

    answers({ status: 'already_applied', attributed: true });
    await resumePendingInvite(ME);

    const ids = mockRpc.mock.calls.map(
      ([, args]) => (args as { p_operation_id: string }).p_operation_id,
    );
    expect(ids).toEqual(['operation-from-the-press', 'operation-from-the-press']);
  });

  it('lets every settled answer go, including one that used to be retried', async () => {
    // `unavailable` covers a block, and a retry would connect two accounts days after the
    // screen told the person it could not. They open the link again instead.
    for (const reason of ['invalid', 'self', 'already_attributed', 'blocked', 'unavailable']) {
      mockStored = {};
      pressed(TOKEN);
      answers({ status: 'refused', reason });

      await resumePendingInvite(ME);

      expect(held()).toBeNull();
    }
  });

  it('shows the invitation again, rather than sending it, after a refusal that did not commit', async () => {
    // `53400` and `42501` roll their claim back, so the press is not recorded any more and
    // nothing here may act on it.
    pressed(TOKEN);
    answers(null, { code: '53400', message: 'too many' });
    await resumePendingInvite(ME);

    mockRpc.mockClear();
    expect(await resumePendingInvite(ME)).toBe(TOKEN);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('never mints an id of its own', async () => {
    hold(TOKEN);

    await resumePendingInvite(ME);

    expect(mockIssued).toBe(0);
    await claimForRedemption(TOKEN, ME, () => 'op-1');
    expect(JSON.parse(mockStored['invite.acceptedOperation'] ?? 'null')).toEqual({
      id: 'op-1',
      userId: ME,
      token: TOKEN,
    });
  });
});
