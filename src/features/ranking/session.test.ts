import {
  rankAgain,
  rankAnswer,
  rankBack,
  rankCancel,
  rankRebucket,
  rankSkip,
  rankStart,
} from './session';

const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
  startSessionRefresh: () => () => {},
}));

beforeEach(() => mockRpc.mockReset());

const subject = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const session = '11111111-2222-4333-8444-555555555555';
const pivot = '99999999-8888-4777-8666-555555555555';

/**
 * The operation id every ranking RPC has taken since `20260825000200`.
 *
 * One constant, because what this file checks about it is only that it *reaches the
 * wire* on every call — the server defaults it to null, so an argument this client
 * forgets to send is a silent loss of replay protection rather than an error. Which id
 * it is, and when it changes, is `RankingSheet`'s decision over `useOperationIntent`,
 * and is tested there.
 */
const op = '0d0d0d0d-1e1e-4f4f-8a8a-2b2b2b2b2b2b';

/**
 * The ranking session as the client sees it. The RPCs answer with one jsonb blob that
 * means four different things depending on which keys are present, and getting that wrong
 * is not a visible bug — it is a screen that shows a comparison after the title has
 * already been placed, or a reveal with no number in it.
 */
describe('reading the server\u2019s answer', () => {
  it('recognises a comparison', async () => {
    mockRpc.mockResolvedValue({
      data: { done: false, session_id: session, pivot, resumed: false },
      error: null,
    });

    expect(await rankStart(subject, 'loved', op)).toEqual({
      state: 'comparing',
      sessionId: session,
      subjectId: subject,
      pivotId: pivot,
      skipped: false,
    });
  });

  it('recognises a placement, which can happen on the very first call', async () => {
    // An empty band inserts directly: there is nothing to compare against, so the first
    // title in a bucket is placed without a single question.
    mockRpc.mockResolvedValue({
      data: {
        done: true,
        position: 1,
        category: 'movies',
        bucket: 'loved',
        // The first title in a band scores the top of it (score.ts), and the server
        // is what says so — the reveal shows this number rather than deriving one.
        score: 10,
        adjustable: false,
      },
      error: null,
    });

    expect(await rankStart(subject, 'loved', op)).toEqual({
      state: 'placed',
      position: 1,
      category: 'movies',
      bucket: 'loved',
      score: 10,
      adjustable: false,
      // Absent from the response above, and false here rather than undefined. An older
      // backend — anything before 20260819000500 — answers without the key, and the
      // reading has to be "no activation" rather than "unknown": `RankingSheet` emits
      // `invite_activated` from this flag, and a truthy undefined would be a growth
      // event fired on a missing field.
      activated: false,
    });
  });

  it('reports an activation only when the server says one happened', async () => {
    /**
     * PRD §28's tenth ranking, and the flag is the server's.
     *
     * `_maybe_activate_invite` flips `invite_attributions.activated_at` under a row
     * lock and returns true only for the transaction that flipped it — so two devices
     * finishing the tenth ranking together produce one true and one false, and a retry
     * produces false. Counting on the client would emit for accounts that were never
     * invited and again after a reinstall.
     */
    mockRpc.mockResolvedValue({
      data: { done: true, position: 4, category: 'movies', bucket: 'loved', activated: true },
      error: null,
    });

    expect(await rankStart(subject, 'loved', op)).toMatchObject({ state: 'placed', activated: true });
  });

  it('carries the adjustable flag rather than inferring it', async () => {
    // It means the title landed at the midpoint after too many skips. Deciding this on the
    // client would put PRD §10's "you can change this from Rankings" line in front of
    // people whose position was earned by comparison.
    mockRpc.mockResolvedValue({
      data: { done: true, position: 4, category: 'movies', bucket: 'fine', adjustable: true },
      error: null,
    });

    expect(await rankSkip(session, subject, op)).toMatchObject({ adjustable: true });
  });

  it('recognises the cancellation that Back produces at the first comparison', async () => {
    // rank_back deletes the session there and returns { done: false, cancelled: true }.
    // Read as a comparison, this would leave the screen waiting for a pivot that is
    // never coming.
    mockRpc.mockResolvedValue({ data: { done: false, cancelled: true }, error: null });
    expect(await rankBack(session, subject, op)).toEqual({ state: 'ended' });
  });

  it('does not mistake a response with no pivot for a comparison', async () => {
    mockRpc.mockResolvedValue({ data: { done: false, session_id: session }, error: null });
    expect(await rankAnswer(session, pivot, subject, op)).toEqual({ state: 'ended' });
  });

  it('marks a pivot reached by skipping, so the screen can say so', async () => {
    mockRpc.mockResolvedValue({
      data: { done: false, session_id: session, pivot, skipped: true },
      error: null,
    });
    expect(await rankSkip(session, subject, op)).toMatchObject({ skipped: true });
  });
});

describe('failures', () => {
  it('asks for a restart when the session has gone', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'P0002', message: 'no such ranking session' },
    });

    expect(await rankAnswer(session, pivot, subject, op)).toEqual({
      state: 'failed',
      message: 'That ranking session has ended. Start again.',
      restart: true,
    });
  });

  it('asks for a restart when a pivot stopped being ranked mid-session', async () => {
    // The server refuses rather than substituting another pivot, because answering would
    // otherwise attribute a judgement to a comparison the user was never shown
    // (api.md §8). The client has to start over, not retry.
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'winner must be one of the two titles being compared' },
    });

    expect(await rankAnswer(session, pivot, subject, op)).toMatchObject({ restart: true });
  });

  it('does not ask for a restart when the account is the problem', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'suspended' } });
    expect(await rankAnswer(session, pivot, subject, op)).toEqual({
      state: 'failed',
      message: 'Your account cannot make changes right now.',
      restart: false,
    });
  });

  it('treats a null answer as a failure rather than as a placement at zero', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    expect(await rankStart(subject, 'loved', op)).toMatchObject({ state: 'failed' });
  });
});

describe('rankCancel', () => {
  it('ends the session', async () => {
    mockRpc.mockResolvedValue({ data: { done: true, cancelled: true }, error: null });
    expect(await rankCancel(session)).toEqual({ state: 'ended' });
    expect(mockRpc).toHaveBeenCalledWith('rank_cancel', { p_session_id: session });
  });

  it('treats an already-gone session as success', async () => {
    // Closing the sheet twice, or closing one the server already finalised, is not an
    // error the user should be shown.
    mockRpc.mockResolvedValue({ data: null, error: { code: 'P0002', message: 'no such session' } });
    expect(await rankCancel(session)).toEqual({ state: 'ended' });
  });

  it('reports a real failure', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection lost' } });
    expect(await rankCancel(session)).toMatchObject({ state: 'failed', message: 'connection lost' });
  });
});

describe('arguments', () => {
  it('translates the bucket name the UI uses', async () => {
    mockRpc.mockResolvedValue({ data: { done: false, session_id: session, pivot }, error: null });
    await rankStart(subject, 'notForMe', op);

    expect(mockRpc).toHaveBeenCalledWith('rank_start', {
      p_media_item_id: subject,
      p_bucket: 'not_for_me',
      p_operation_id: op,
    });
  });

  it('sends the winner as the winner, not as the subject', async () => {
    // Getting these two the wrong way round would silently invert every comparison, and
    // the ranking would still look plausible.
    mockRpc.mockResolvedValue({ data: { done: false, session_id: session, pivot }, error: null });
    await rankAnswer(session, pivot, subject, op);

    expect(mockRpc).toHaveBeenCalledWith('rank_answer', {
      p_session_id: session,
      p_winner: pivot,
      p_operation_id: op,
    });
  });

  it.each([
    ['rankSkip', rankSkip, 'rank_skip'],
    ['rankBack', rankBack, 'rank_back'],
  ] as const)('calls the function %s is named after', async (_name, fn, rpc) => {
    // These four RPCs take the same single argument and answer with the same shape, so
    // calling the wrong one is invisible to every other test here. rankBack reaching
    // rank_cancel would end the session instead of stepping back a comparison, which the
    // user would read as the app losing their answers (PRD §26.3.9).
    mockRpc.mockResolvedValue({ data: { done: false, session_id: session, pivot }, error: null });
    await fn(session, subject, op);

    expect(mockRpc).toHaveBeenCalledWith(rpc, { p_session_id: session, p_operation_id: op });
  });

  /**
   * **The one property that cannot be checked by reading the calls above**, because the
   * failure is an *absent* key rather than a wrong one.
   *
   * `20260825000200` gives every ranking RPC `p_operation_id uuid default null`, so a
   * call that omits it is accepted, runs, and quietly gets no replay protection — the
   * price of keeping the installed beta client working during the deploy window. There
   * is no error for this client to notice, so the sweep is the notice: every wrapper in
   * `session.ts` that reaches a mutating RPC must put the id on the wire.
   *
   * `rankCancel` is deliberately absent. It is the one mutation that took no id in the
   * migration, because its replay is already harmless: it deletes a session by id, and
   * a second attempt names a session that is either gone or belongs to a later ranking
   * and does not match.
   */
  it.each([
    ['rankStart', () => rankStart(subject, 'loved', op)],
    ['rankAgain', () => rankAgain(subject, 'loved', op)],
    ['rankRebucket', () => rankRebucket(subject, 'loved', op)],
    ['rankAnswer', () => rankAnswer(session, pivot, subject, op)],
    ['rankSkip', () => rankSkip(session, subject, op)],
    ['rankBack', () => rankBack(session, subject, op)],
  ] as const)('sends an operation id from %s', async (_name, run) => {
    mockRpc.mockResolvedValue({ data: { done: false, session_id: session, pivot }, error: null });
    await run();

    const [, args] = mockRpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_operation_id).toBe(op);
  });
});

describe('an already ranked title', () => {
  it('is explained without naming an internal function', async () => {
    // rank_start raises 23505 with "use rank_rebucket to move it". Unmapped, that sentence
    // reaches the screen (api.md §8 maps it to BG409).
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'title is already ranked; use rank_rebucket to move it' },
    });

    const result = await rankStart(subject, 'loved', op);

    expect(result).toEqual({
      state: 'failed',
      message: 'This already has a position. Move it from your collection instead.',
      restart: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/rank_rebucket/);
  });
});

/**
 * A rollback is not an ambiguity, and independent review 30b caught the app calling it
 * one. `classifyWrite` reads an unrecognised SQLSTATE as `unknown` — correct by default,
 * wrong for this code, because Postgres aborts the transaction that raises it.
 */
describe('a transaction rolled back against a concurrent one', () => {
  it('is a definite refusal, not a write that may have landed', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '40001', message: 'could not serialize access due to concurrent update' },
    });

    const result = await rankStart(subject, 'loved', op);

    // No `changed`: nothing survived, so nothing needs refetching and nobody should be
    // told their ranking might be there.
    expect(result).toEqual({
      state: 'failed',
      message: 'Something else was changing your rankings at that moment. Try again.',
      restart: false,
    });
    // The database's own wording names a transaction isolation level.
    expect(JSON.stringify(result)).not.toMatch(/serialize/);
  });
});

/**
 * Ranking a title again inside the band it is already in.
 *
 * The founder reproduced the absence of this on the device: Loved, Change your rating,
 * Loved, and nothing happened at all. `rank_rebucket` cannot serve it — it raises 22023
 * on a bucket that is not moving, by design.
 *
 * **This used to be two calls from the client**, `rank_unrank` then `rank_start`, and
 * every test in this block was about the seam between them: what happens when the first
 * lands and the second does not, which errors from the first are fatal and which are the
 * state the caller wanted anyway. `20260825000200` replaced the pair with a `rank_again`
 * RPC that does both in one transaction, so the seam is gone and the tests that
 * described it are gone with it. What is asserted now is the property that made the
 * migration worth making: **one call, and one call only.**
 */
describe('ranking a title again in the same bucket', () => {
  it('is a single RPC, so there is no state between two of them to be stranded in', async () => {
    mockRpc.mockResolvedValue({
      data: { done: false, session_id: session, pivot },
      error: null,
    });

    expect(await rankAgain(subject, 'loved', op)).toEqual({
      state: 'comparing',
      sessionId: session,
      subjectId: subject,
      pivotId: pivot,
      skipped: false,
    });

    // The whole point. Two calls could land one and lose the other; one cannot.
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['rank_again']);
  });

  it('places outright when the band empties to nothing', async () => {
    // The only Loved title, re-ranked: after the unrank there is nothing left to compare
    // it against, so the server places it and there are no comparisons at all. The client
    // does not know or care that this happened inside one transaction — it reads the
    // same `done` it reads from every other entry point.
    mockRpc.mockResolvedValue({
      data: { done: true, position: 1, category: 'movies', bucket: 'loved', score: 10 },
      error: null,
    });

    expect(await rankAgain(subject, 'loved', op)).toMatchObject({
      state: 'placed',
      position: 1,
      bucket: 'loved',
    });
  });

  it('carries a not-for-me bucket through unchanged', async () => {
    mockRpc.mockResolvedValue({ data: { done: false, session_id: session, pivot }, error: null });
    await rankAgain(subject, 'notForMe', op);

    // The client's own vocabulary is camelCase and the database's is snake_case, and the
    // one place that mapping can go wrong is a bucket that is two words.
    expect(mockRpc).toHaveBeenCalledWith('rank_again', {
      p_media_item_id: subject,
      p_bucket: 'not_for_me',
      p_operation_id: op,
    });
  });

  it('reports a refusal without claiming anything moved', async () => {
    // A suspended account is refused before the transaction does anything, so the
    // position is exactly where it was and nothing needs refetching.
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'account is suspended' },
    });

    const result = await rankAgain(subject, 'loved', op);

    expect(result).toMatchObject({ state: 'failed', restart: false });
    expect(result).not.toHaveProperty('changed');
  });

  it('reports an unanswered call as a change that may have landed', async () => {
    // A dropped reply is not a refusal. The transaction may have committed, in which
    // case the old position is gone and a session is open — so the caller has to
    // refresh. `changed` is what tells the sheet to (`lib/write-outcome.ts`).
    //
    // This is now recoverable rather than merely reportable: the retry carries the same
    // operation id, and the server answers it with what the lost reply said instead of
    // unranking a second time.
    mockRpc.mockResolvedValue({ data: null, error: { code: '', message: 'TypeError: fail' } });

    expect(await rankAgain(subject, 'loved', op)).toMatchObject({
      state: 'failed',
      changed: true,
    });
  });

  it('does not treat a title that had already lost its position as an error', async () => {
    // The client used to absorb a P0002 from its own `rank_unrank` here, because "not
    // ranked" is the state this call was reaching for. The server takes the same reading
    // now, so an unranked title simply opens a session and there is nothing to absorb.
    mockRpc.mockResolvedValue({ data: { done: false, session_id: session, pivot }, error: null });

    expect(await rankAgain(subject, 'loved', op)).toMatchObject({ state: 'comparing' });
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['rank_again']);
  });
});
