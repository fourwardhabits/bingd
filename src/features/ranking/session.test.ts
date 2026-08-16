import { rankAnswer, rankBack, rankCancel, rankSkip, rankStart } from './session';

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
    });
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
