import {
  rankAgain,
  rankAnswer,
  rankBack,
  rankCancel,
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

    expect(await rankStart(subject, 'loved')).toEqual({
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

    expect(await rankStart(subject, 'loved')).toEqual({
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

    expect(await rankStart(subject, 'loved')).toMatchObject({ state: 'placed', activated: true });
  });

  it('carries the adjustable flag rather than inferring it', async () => {
    // It means the title landed at the midpoint after too many skips. Deciding this on the
    // client would put PRD §10's "you can change this from Rankings" line in front of
    // people whose position was earned by comparison.
    mockRpc.mockResolvedValue({
      data: { done: true, position: 4, category: 'movies', bucket: 'fine', adjustable: true },
      error: null,
    });

    expect(await rankSkip(session, subject)).toMatchObject({ adjustable: true });
  });

  it('recognises the cancellation that Back produces at the first comparison', async () => {
    // rank_back deletes the session there and returns { done: false, cancelled: true }.
    // Read as a comparison, this would leave the screen waiting for a pivot that is
    // never coming.
    mockRpc.mockResolvedValue({ data: { done: false, cancelled: true }, error: null });
    expect(await rankBack(session, subject)).toEqual({ state: 'ended' });
  });

  it('does not mistake a response with no pivot for a comparison', async () => {
    mockRpc.mockResolvedValue({ data: { done: false, session_id: session }, error: null });
    expect(await rankAnswer(session, pivot, subject)).toEqual({ state: 'ended' });
  });

  it('marks a pivot reached by skipping, so the screen can say so', async () => {
    mockRpc.mockResolvedValue({
      data: { done: false, session_id: session, pivot, skipped: true },
      error: null,
    });
    expect(await rankSkip(session, subject)).toMatchObject({ skipped: true });
  });
});

describe('failures', () => {
  it('asks for a restart when the session has gone', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'P0002', message: 'no such ranking session' },
    });

    expect(await rankAnswer(session, pivot, subject)).toEqual({
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

    expect(await rankAnswer(session, pivot, subject)).toMatchObject({ restart: true });
  });

  it('does not ask for a restart when the account is the problem', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'suspended' } });
    expect(await rankAnswer(session, pivot, subject)).toEqual({
      state: 'failed',
      message: 'Your account cannot make changes right now.',
      restart: false,
    });
  });

  it('treats a null answer as a failure rather than as a placement at zero', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    expect(await rankStart(subject, 'loved')).toMatchObject({ state: 'failed' });
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
    await rankStart(subject, 'notForMe');

    expect(mockRpc).toHaveBeenCalledWith('rank_start', {
      p_media_item_id: subject,
      p_bucket: 'not_for_me',
    });
  });

  it('sends the winner as the winner, not as the subject', async () => {
    // Getting these two the wrong way round would silently invert every comparison, and
    // the ranking would still look plausible.
    mockRpc.mockResolvedValue({ data: { done: false, session_id: session, pivot }, error: null });
    await rankAnswer(session, pivot, subject);

    expect(mockRpc).toHaveBeenCalledWith('rank_answer', {
      p_session_id: session,
      p_winner: pivot,
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
    await fn(session, subject);

    expect(mockRpc).toHaveBeenCalledWith(rpc, { p_session_id: session });
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

    const result = await rankStart(subject, 'loved');

    expect(result).toEqual({
      state: 'failed',
      message: 'This already has a position. Move it from your collection instead.',
      restart: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/rank_rebucket/);
  });
});

/**
 * Ranking a title again inside the band it is already in.
 *
 * The founder reproduced the absence of this on the device: Loved, Change your rating,
 * Loved, and nothing happened at all. `rank_rebucket` cannot serve it — it raises 22023
 * on a bucket that is not moving, by design — so this composes the two calls it would
 * have made anyway. The interesting cases are all about the seam between them, which a
 * transaction would not have.
 */
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

    const result = await rankStart(subject, 'loved');

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

describe('ranking a title again in the same bucket', () => {
  const answering = (byName: Record<string, unknown>) =>
    mockRpc.mockImplementation((name: string) =>
      Promise.resolve(byName[name] ?? { data: null, error: null }),
    );

  it('drops the position, then opens a session in the bucket it already had', async () => {
    answering({
      rank_unrank: { data: { done: true, unranked: true }, error: null },
      rank_start: { data: { done: false, session_id: session, pivot }, error: null },
    });

    expect(await rankAgain(subject, 'loved')).toEqual({
      state: 'comparing',
      sessionId: session,
      subjectId: subject,
      pivotId: pivot,
      skipped: false,
    });
    // In this order. `rank_start` refuses a title that still holds a position.
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['rank_unrank', 'rank_start']);
    // The bucket does not move. That is the entire difference from a rebucket.
    expect(mockRpc.mock.calls[1][1]).toEqual({
      p_media_item_id: subject,
      p_bucket: 'loved',
    });
  });

  it('places outright when the band empties to nothing', async () => {
    // The only Loved title, re-ranked: after the unrank there is nothing left to compare
    // it against, so the server places it and there are no comparisons at all.
    answering({
      rank_unrank: { data: { done: true, unranked: true }, error: null },
      rank_start: {
        data: { done: true, position: 1, category: 'movies', bucket: 'loved', score: 10 },
        error: null,
      },
    });

    const result = await rankAgain(subject, 'loved');

    expect(result).toMatchObject({ state: 'placed', position: 1, bucket: 'loved' });
  });

  it('carries a not-for-me bucket through unchanged', async () => {
    answering({
      rank_unrank: { data: { done: true }, error: null },
      rank_start: { data: { done: false, session_id: session, pivot }, error: null },
    });

    await rankAgain(subject, 'notForMe');

    // The client's own vocabulary is camelCase and the database's is snake_case, and the
    // one place that mapping can go wrong is a bucket that is two words.
    expect(mockRpc.mock.calls[1][1]).toEqual({
      p_media_item_id: subject,
      p_bucket: 'not_for_me',
    });
  });

  it('does not open a session when the unrank was refused', async () => {
    // A refusal means the position is still there, and starting over it would earn a
    // 23505 that reads to the user as a different fault entirely.
    answering({
      rank_unrank: { data: null, error: { code: '42501', message: 'suspended' } },
    });

    const result = await rankAgain(subject, 'loved');

    expect(result).toMatchObject({ state: 'failed', restart: false });
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['rank_unrank']);
  });

  it('reports an unanswered unrank as a change that may have landed', async () => {
    // A dropped reply is not a refusal. The position may be gone, so the caller has to
    // refresh — `changed` is what tells the sheet to (`lib/write-outcome.ts`).
    answering({ rank_unrank: { data: null, error: { code: '', message: 'TypeError: fail' } } });

    expect(await rankAgain(subject, 'loved')).toMatchObject({ state: 'failed', changed: true });
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['rank_unrank']);
  });

  it('goes on when the title had already lost its position', async () => {
    // P0002 from the unrank is "title is not ranked", which is the state this call was
    // trying to reach. Treating it as an error would strand a title the user asked to
    // rank in a queue instead of ranking it.
    answering({
      rank_unrank: { data: null, error: { code: 'P0002', message: 'title is not ranked' } },
      rank_start: { data: { done: false, session_id: session, pivot }, error: null },
    });

    expect(await rankAgain(subject, 'loved')).toMatchObject({ state: 'comparing' });
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['rank_unrank', 'rank_start']);
  });
});
