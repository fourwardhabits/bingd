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

import { MAX_RECOVERABLE_ATTEMPTS } from './pending';
import { redeemInvite, redeemPendingInvite } from './redeem';

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

const answers = (body: unknown, error: unknown = null) =>
  mockRpc.mockResolvedValue({ data: body, error });

beforeEach(() => {
  jest.clearAllMocks();
  mockStored = {};
  mockIssued = 0;
});

describe('redeemInvite', () => {
  it('reports the inviter, the follow state, and records the redemption', async () => {
    answers({
      status: 'ok',
      inviter_id: 'user-2',
      inviter_username: 'ada',
      follow_state: 'approved',
    });

    expect(await redeemInvite(TOKEN, 'op-1')).toEqual({
      outcome: 'redeemed',
      inviterUsername: 'ada',
      followState: 'approved',
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
    expect(await redeemInvite(TOKEN, 'op-1')).toMatchObject({ followState: 'pending' });

    // A backend that predates the acceptance semantics answers without the key. Null,
    // not a guess: the screen then says the invitation was recorded and nothing about
    // following, which is the only honest thing it can say.
    answers({ status: 'ok', inviter_username: 'ada' });
    expect(await redeemInvite(TOKEN, 'op-1')).toMatchObject({ followState: null });

    answers({ status: 'ok', inviter_username: 'ada', follow_state: 'something_else' });
    expect(await redeemInvite(TOKEN, 'op-1')).toMatchObject({ followState: null });
  });

  it('sends the token to nobody', async () => {
    // Not to PostHog and not as an event property. `ALLOWED_PROPERTY_KEYS` would strip
    // it, and `FORBIDDEN_PROPERTY_KEYS` names it — this asserts it is not offered.
    answers({ status: 'ok', inviter_username: 'ada' });

    await redeemInvite(TOKEN, 'op-1');

    for (const call of [...mockTrack.mock.calls, ...mockSetAcquisition.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
      expect(JSON.stringify(call)).not.toContain('ada');
    }
  });

  it('records nothing on a replay, which wrote no row', async () => {
    // The designed path: a redemption commits, the reply is lost, the retry carries the
    // same operation id. Counting it again would report two arrivals from one person.
    answers({ status: 'already_applied', attributed: true });

    expect(await redeemInvite(TOKEN, 'op-1')).toEqual({
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

      const result = await redeemInvite(TOKEN, 'op-1');

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
    expect(await redeemInvite(TOKEN, 'op-1')).toEqual({ outcome: 'unavailable' });

    answers({ status: 'refused', reason: 'unavailable' });
    expect(await redeemInvite(TOKEN, 'op-1')).toEqual({ outcome: 'unavailable' });
  });

  it('treats a refusal it does not recognise as invalid rather than as success', async () => {
    // A reason added to the server and not here. The safe reading is "this did not
    // work", not "assume it did".
    answers({ status: 'refused', reason: 'something_new' });

    expect(await redeemInvite(TOKEN, 'op-1')).toEqual({ outcome: 'invalid' });
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('reads an unanswered call as possibly committed', async () => {
    answers(null, { code: '', message: 'Network request failed' });

    expect(await redeemInvite(TOKEN, 'op-1')).toEqual({
      outcome: 'failed',
      message: 'Network request failed',
      changed: true,
    });
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('reads a raised refusal as a refusal, so the retry may mint a fresh id', async () => {
    answers(null, { code: '53400', message: 'too many' });

    expect(await redeemInvite(TOKEN, 'op-1')).toMatchObject({
      outcome: 'failed',
      changed: false,
    });
  });

  it('treats a 200 with no body as a change, because the request was answered', async () => {
    answers(null);

    expect(await redeemInvite(TOKEN, 'op-1')).toMatchObject({ outcome: 'failed', changed: true });
  });
});

describe('redeemPendingInvite', () => {
  /** What the module actually persisted, or undefined if it never wrote. */
  const held = () => JSON.parse(mockStored['invite.pendingToken'] ?? 'null') as string | null;

  const hold = (token: string) => {
    mockStored['invite.pendingToken'] = JSON.stringify(token);
  };

  it('does nothing, and calls nothing, when this device holds no invitation', async () => {
    // Which is almost every launch. The cost of finding out has to be one storage read
    // and no request.
    expect(await redeemPendingInvite()).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('ignores a stored value that is not a token', async () => {
    mockStored['invite.pendingToken'] = JSON.stringify('../../etc/passwd');

    expect(await redeemPendingInvite()).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('redeems what it holds and then lets it go', async () => {
    hold(TOKEN);
    answers({ status: 'ok', inviter_username: 'ada' });

    expect(await redeemPendingInvite()).toMatchObject({ outcome: 'redeemed' });
    expect(mockRpc).toHaveBeenCalledWith('redeem_invite', {
      p_operation_id: 'operation-1',
      p_token: TOKEN,
    });
    expect(held()).toBeNull();
  });

  it('lets a final refusal go rather than replaying it every launch', async () => {
    // Three of the four. `unavailable` is not final and has its own test below —
    // independent review 26's second Major.
    for (const reason of ['invalid', 'self', 'already_attributed']) {
      mockStored = {};
      hold(TOKEN);
      answers({ status: 'refused', reason });

      await redeemPendingInvite();

      expect(held()).toBeNull();
    }
  });

  it('keeps the invitation through a block or a suspension, which get lifted', async () => {
    /**
     * The failure independent review 26 named. `unavailable` covers a block in either
     * direction and a suspended inviter, and **both of those stop being true**. The
     * first version of this module treated it as final, so a recipient who completed
     * signup during a temporary block lost their invitation permanently, with nothing
     * on any screen to say so.
     */
    hold(TOKEN);
    answers({ status: 'refused', reason: 'blocked' });

    await redeemPendingInvite();

    expect(held()).toBe(TOKEN);
  });

  it('releases the operation id after a recoverable refusal, or the retry is inert', async () => {
    /**
     * Independent review 26b's first Major, and the sharpest test in this file because
     * the version it catches *looked* correct.
     *
     * An `unavailable` refusal is a **settled** answer: `_claim_operation` committed, so
     * that operation id is spent. A retry carrying it is answered `already_applied` —
     * the server never reconsiders the token, the block or the suspension — so the five
     * recoverable attempts were five identical non-answers and the whole mechanism was
     * inert. The first version of the file below it mocked five independent
     * `unavailable` answers and therefore could not see it.
     *
     * The rule is `lib/operation-intent.ts`'s: the id is dropped the moment the server
     * answers anything, and held only when the outcome was never established.
     */
    hold(TOKEN);
    answers({ status: 'refused', reason: 'unavailable' });
    await redeemPendingInvite();

    answers({ status: 'ok', inviter_username: 'ada', follow_state: 'approved' });
    await redeemPendingInvite();

    const ids = mockRpc.mock.calls.map(
      ([, args]) => (args as { p_operation_id: string }).p_operation_id,
    );
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('releases the operation id after a refusal that certainly did not commit', async () => {
    // 53400 from the rate limiter and 42501 from a suspension roll their claim back
    // with the raise, so the id was never spent. Holding it would be harmless today and
    // wrong tomorrow; the asymmetry is the rule rather than an optimisation.
    hold(TOKEN);
    answers(null, { code: '53400', message: 'too many' });
    await redeemPendingInvite();

    answers({ status: 'ok', inviter_username: 'ada' });
    await redeemPendingInvite();

    const ids = mockRpc.mock.calls.map(
      ([, args]) => (args as { p_operation_id: string }).p_operation_id,
    );
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('gives up on an unavailable inviter after a bounded number of launches', async () => {
    /**
     * Bounded rather than retried for ever, because the same answer also covers a
     * *deleted* inviter, which never recovers — and an unbounded retry would spend a
     * redeem slot on every cold start until the daily ceiling refused a redemption that
     * might genuinely have worked.
     *
     * The count is in storage rather than in memory precisely because the retries are
     * on different launches.
     */
    hold(TOKEN);
    answers({ status: 'refused', reason: 'unavailable' });

    for (let i = 0; i < MAX_RECOVERABLE_ATTEMPTS - 1; i += 1) {
      await redeemPendingInvite();
      expect(held()).toBe(TOKEN);
    }

    await redeemPendingInvite();
    expect(held()).toBeNull();
  });

  it('keeps the invitation when the call did not settle', async () => {
    hold(TOKEN);
    answers(null, { code: '', message: 'Network request failed' });

    await redeemPendingInvite();

    expect(held()).toBe(TOKEN);
  });

  it('keeps the invitation when the refusal is one that stops being true', async () => {
    /**
     * `53400` from the rate limiter and `42501` from a suspension are refusals — the
     * call certainly did not commit — and they are still kept, because the question
     * here is "could this succeed later" rather than "may this have committed".
     * Discarding somebody's invitation because they were briefly over a ceiling is the
     * failure this beta can least afford.
     */
    for (const code of ['53400', '42501']) {
      mockStored = {};
      hold(TOKEN);
      answers(null, { code, message: 'refused' });

      await redeemPendingInvite();

      expect(held()).toBe(TOKEN);
    }
  });

  it('carries the same operation id into the retry after an unsettled call', async () => {
    // The id belongs to the intent, and here the intent survives the process: a
    // redemption that commits and loses its reply is retried on the next launch, and
    // only the same id lets `_claim_operation` recognise it rather than spending a
    // second slot on one decision.
    hold(TOKEN);
    answers(null, { code: '', message: 'Network request failed' });
    await redeemPendingInvite();

    answers({ status: 'already_applied', attributed: true });
    await redeemPendingInvite();

    const ids = mockRpc.mock.calls.map(([, args]) => (args as { p_operation_id: string }).p_operation_id);
    expect(ids).toEqual(['operation-1', 'operation-1']);
  });
});
