import {
  logWatched,
  mustReconcile,
  newOperationId,
  removeFromCollection,
  saveNote,
  setBucket,
  setWatchlist,
  today,
  unrank,
} from './writes';

const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
  startSessionRefresh: () => () => {},
}));

const mockRandomUUID = jest.fn();

jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
}));

let issued = 0;

beforeEach(() => {
  mockRpc.mockReset();
  issued = 0;
  mockRandomUUID.mockReset();
  // A fresh value every call, so a module-level constant cannot pass for a generator.
  mockRandomUUID.mockImplementation(() => `1111111${(issued += 1)}-2222-3333-4444-555555555555`);
});

const operationId = '00000000-0000-4000-8000-000000000000';
const mediaItemId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/**
 * The client half of the collection writers. What is worth testing here is the mapping —
 * the bucket names differ between the UI and the enum, `already_applied` is a success
 * that looks like a refusal, and two of the SQLSTATEs mean something a user has to be
 * told rather than "something went wrong".
 */
describe('setBucket', () => {
  it('translates the UI bucket into the database enum', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
    await setBucket({ operationId, mediaItemId, bucket: 'notForMe' });

    // notForMe is camel case only because it is a TypeScript identifier. Sending it
    // unchanged would be a 22P02 at runtime and nowhere else.
    expect(mockRpc).toHaveBeenCalledWith('set_bucket', {
      p_operation_id: operationId,
      p_media_item_id: mediaItemId,
      p_bucket: 'not_for_me',
    });
  });

  it.each([
    ['loved', 'loved'],
    ['fine', 'fine'],
    ['notForMe', 'not_for_me'],
  ] as const)('sends %s as %s', async (bucket, expected) => {
    mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
    await setBucket({ operationId, mediaItemId, bucket });
    expect(mockRpc).toHaveBeenCalledWith('set_bucket', expect.objectContaining({ p_bucket: expected }));
  });

  it('treats an already-applied operation as success', async () => {
    // The idempotency ledger answering "I have seen this one" is the mechanism working,
    // not a failure. Showing an error here would make every retry look broken.
    mockRpc.mockResolvedValue({ data: { status: 'already_applied' }, error: null });
    expect(await setBucket({ operationId, mediaItemId, bucket: 'loved' })).toEqual({
      outcome: 'already_applied',
    });
  });

  it('distinguishes a ranked title, which the user can act on', async () => {
    // 55000 from _assert_unranked. The bucket belongs to the ranking now, and the fix is
    // to re-rank rather than to try again.
    mockRpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'title is ranked' } });
    expect(await setBucket({ operationId, mediaItemId, bucket: 'loved' })).toEqual({
      outcome: 'ranked',
    });
  });

  it('passes the server message through for an invalid input', async () => {
    // 22023 covers a series, a future watch date and an over-long note. The server's own
    // wording is the only thing that tells them apart, so it is not replaced.
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'a series cannot be logged; log a season' },
    });
    expect(await setBucket({ operationId, mediaItemId, bucket: 'loved' })).toEqual({
      outcome: 'failed',
      message: 'a series cannot be logged; log a season',
    });
  });

  it.each([
    ['42501', 'Your account cannot make changes right now.'],
    ['28000', 'Your session expired. Sign in again.'],
    ['P0002', 'That title is no longer in the catalogue.'],
  ])('replaces SQLSTATE %s with something a user can read', async (code, message) => {
    mockRpc.mockResolvedValue({ data: null, error: { code, message: 'from postgres' } });
    expect(await setBucket({ operationId, mediaItemId, bucket: 'loved' })).toEqual({
      outcome: 'failed',
      message,
    });
  });

  it('carries an unrecognised error rather than swallowing it', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection lost' } });
    expect(await setBucket({ operationId, mediaItemId, bucket: 'loved' })).toEqual({
      outcome: 'failed',
      message: 'connection lost',
      // `08006` is the connection class. It carries a code and proves nothing about the
      // commit, which is the whole of independent review 21e's second Major.
      changed: true,
    });
  });
});

/**
 * **The outcome matrix, which is the point of this round.**
 *
 * Every writer here is one request, so the matrix is small: what the server did, crossed
 * with what this client was told. `changed` is the client's answer to "must the caller
 * reconcile", and it is wrong in exactly one direction — a false `changed` costs a
 * refetch, a missing one costs a screen that disagrees with the database.
 *
 * The rule under test is *not* "the error has a code". Review 21d wrote that rule, and
 * review 21e produced `08007 transaction_resolution_unknown` — a code whose meaning is
 * that the outcome is unknown. `lib/write-outcome.ts` holds the rule that survives.
 */
describe('what a single-request writer says happened', () => {
  const cases: [string, { code?: string; message: string } | null, boolean][] = [
    // Server committed, client was told so.
    ['an acknowledged success', null, false],
    // Server refused, client was told so. Every one of these is a SQLSTATE this app's
    // own functions raise on purpose.
    ['a validation refusal', { code: '22023', message: 'that date is in the future' }, false],
    ['an RLS refusal', { code: '42501', message: 'suspended' }, false],
    ['a session refusal', { code: '28000', message: 'no session' }, false],
    ['a missing-title refusal', { code: 'P0002', message: 'no such title' }, false],
    // Server outcome unknown, and the client is told a variety of unhelpful things.
    ['a transaction whose resolution is unknown', { code: '08007', message: 'unknown' }, true],
    ['a connection that failed', { code: '08006', message: 'connection failure' }, true],
    ['a database shutting down mid-request', { code: '57P01', message: 'terminating' }, true],
    ['a SQLSTATE nobody here has reasoned about', { code: 'XX000', message: 'internal' }, true],
    ['a request timeout', { code: '', message: 'AbortError: aborted' }, true],
    ['a socket that died after the request went out', { code: '', message: 'TypeError: fail' }, true],
    ['a gateway answering with something unparseable', { message: '<html>502</html>' }, true],
  ];

  it.each(cases)('%s', async (_name, error, reconcilable) => {
    mockRpc.mockResolvedValue({ data: error ? null : { status: 'ok' }, error });

    const result = await setWatchlist({ operationId, mediaItemId, present: true });

    if (!error) {
      expect(result).toEqual({ outcome: 'ok' });
      expect(mustReconcile(result)).toBe(true);
      return;
    }

    expect(result.outcome).toBe('failed');
    // Asserted on `mustReconcile` rather than on `changed`, because that is what every
    // caller reads. A test on the flag alone survives a caller that ignores it.
    expect(mustReconcile(result)).toBe(reconcilable);
  });

  it('reads a refusal the server answered with as nothing to reconcile', async () => {
    // The cheap side of the trade is still a side: an ordinary refusal must not make
    // every screen in the app refetch, or the flag would carry no information.
    mockRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'suspended' } });
    expect(mustReconcile(await setBucket({ operationId, mediaItemId, bucket: 'loved' }))).toBe(
      false,
    );
  });

  it('reads 55000 on a bucket as a refusal rather than as an ambiguity', async () => {
    // `ranked` is its own outcome and never carries `changed`: the server declined to
    // move the bucket because ranking owns it, which it can only do by not committing.
    mockRpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'already ranked' } });
    const result = await setBucket({ operationId, mediaItemId, bucket: 'loved' });
    expect(result).toEqual({ outcome: 'ranked' });
    // Reconciled all the same, and for a reason of its own rather than by accident:
    // `_assert_unranked` refusing proves the *client* was wrong about this title being
    // unranked. Nothing was written, and the sheet is still showing a stale fact.
    expect(mustReconcile(result)).toBe(true);
  });

  it('reads a note conflict as a refusal, with its own wording', async () => {
    // `save_note` reuses 55000 for its version conflict. Still a refusal, so still
    // nothing to reconcile — and still not a sentence about ranking.
    mockRpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'stale' } });
    const result = await saveNote({ operationId, mediaItemId, note: 'x' });
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(result).not.toHaveProperty('changed');
  });
});

describe('logWatched', () => {
  it('returns the note version the server issued', async () => {
    // A base version must always be one the server handed over. Inventing a local
    // timestamp would read as a conflict on the next edit — see offline-sync.md §4.
    mockRpc.mockResolvedValue({
      data: { status: 'ok', note_version: '2026-08-14T00:00:00.000Z' },
      error: null,
    });

    expect(
      await logWatched({ operationId, mediaItemId, note: 'better than I expected' }),
    ).toMatchObject({ outcome: 'ok', noteVersion: '2026-08-14T00:00:00.000Z' });
  });

  it('puts the date in the date and the note in the note', async () => {
    // With both absent they are both null, and a swapped pair looks identical. The note
    // arriving as p_watched_on is a 22007 the user cannot act on; the reverse files the
    // date as private prose.
    mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
    await logWatched({
      operationId,
      mediaItemId,
      watchedOn: '2026-08-13',
      note: 'better than I expected',
    });

    expect(mockRpc).toHaveBeenCalledWith('log_watched', {
      p_operation_id: operationId,
      p_media_item_id: mediaItemId,
      p_watched_on: '2026-08-13',
      p_note: 'better than I expected',
      // Absent from this call, so the server keeps whatever is stored. Only the
      // note editor names them, and it names both together.
      p_note_visibility: null,
      p_note_spoilers: null,
    });
  });

  it('carries the two note claims when the caller makes them', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
    await logWatched({
      operationId,
      mediaItemId,
      note: 'the ending is the point',
      noteVisibility: 'private',
      noteSpoilers: true,
    });

    expect(mockRpc).toHaveBeenCalledWith(
      'log_watched',
      expect.objectContaining({ p_note_visibility: 'private', p_note_spoilers: true }),
    );
  });

  it('sends nulls rather than undefined for the fields it was not given', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
    await logWatched({ operationId, mediaItemId });

    expect(mockRpc).toHaveBeenCalledWith('log_watched', {
      p_operation_id: operationId,
      p_media_item_id: mediaItemId,
      p_watched_on: null,
      p_note: null,
      p_note_visibility: null,
      p_note_spoilers: null,
    });
  });
});

describe('setWatchlist', () => {
  it('passes the operation id, media id, and desired presence', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });

    await setWatchlist({ operationId, mediaItemId, present: true });
    expect(mockRpc).toHaveBeenCalledWith('set_watchlist', {
      p_operation_id: operationId,
      p_media_item_id: mediaItemId,
      p_present: true,
    });
  });

  it('treats already_applied as success', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'already_applied' }, error: null });
    expect(await setWatchlist({ operationId, mediaItemId, present: false })).toEqual({
      outcome: 'already_applied',
    });
  });

  it('maps known SQLSTATE values to user-facing messages', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'x' } });
    expect(await setWatchlist({ operationId, mediaItemId, present: true })).toEqual({
      outcome: 'failed',
      message: 'Your account cannot make changes right now.',
    });
  });
});

describe('operation ids and dates', () => {
  it('asks for a fresh id on every call rather than holding a constant', () => {
    // A constant would make every write look like a retry of the first, and the ledger
    // would drop all but one. Asserting a mocked value cannot see that, because the mock
    // is itself a constant — so this asserts two calls differ, and that the generator is
    // the platform's rather than something home-made.
    const first = newOperationId();
    const second = newOperationId();

    expect(first).not.toBe(second);
    expect(mockRandomUUID).toHaveBeenCalledTimes(2);
  });

  it('formats today as a local calendar date', () => {
    // Not toISOString(). That converts to UTC first, so anyone west of it logging in the
    // evening would file the watch under tomorrow.
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 13, 23, 30));
    expect(today()).toBe('2026-08-13');
    jest.useRealTimers();
  });

  it('pads single-digit months and days', () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 0, 5, 12, 0));
    expect(today()).toBe('2026-01-05');
    jest.useRealTimers();
  });
});

/**
 * Undoing a ranking, and undoing a log.
 *
 * Both server functions have been granted since the first migration and nothing on the
 * client had ever called either, so an accidental comparison could be changed and never
 * removed. What is worth testing is the join between them: `unlog` refuses a ranked
 * title, so "remove this from my collection" is two calls in a fixed order, and the
 * first one failing has to stop the second rather than be retried into it.
 */
describe('unrank', () => {
  it('asks the server to drop the position, and nothing else', async () => {
    mockRpc.mockResolvedValue({ data: { done: true }, error: null });
    const result = await unrank(mediaItemId);

    expect(mockRpc).toHaveBeenCalledWith('rank_unrank', { p_media_item_id: mediaItemId });
    expect(result).toEqual({ outcome: 'ok' });
  });

  it('treats "it was not ranked" as the state the caller wanted', async () => {
    // P0002 from this function means there was nothing to remove. `interpret` reads
    // that code as a missing catalogue row, which is right for every other writer and
    // wrong here.
    mockRpc.mockResolvedValue({ data: null, error: { code: 'P0002', message: 'title is not ranked' } });

    expect(await unrank(mediaItemId)).toEqual({ outcome: 'ok' });
  });

  it('still reports a refusal the reader has to know about', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'suspended' } });

    expect(await unrank(mediaItemId)).toEqual({
      outcome: 'failed',
      message: 'Your account cannot make changes right now.',
    });
  });
});

describe('removeFromCollection', () => {
  it('clears the ranking first, because unlog refuses a ranked title', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
    await removeFromCollection({ operationId, mediaItemId, wasRanked: true });

    expect(mockRpc.mock.calls.map((call) => call[0])).toEqual(['rank_unrank', 'unlog']);
    expect(mockRpc).toHaveBeenLastCalledWith('unlog', {
      p_operation_id: operationId,
      p_media_item_id: mediaItemId,
    });
  });

  it('skips a round trip for a title that was never ranked', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
    await removeFromCollection({ operationId, mediaItemId, wasRanked: false });

    expect(mockRpc.mock.calls.map((call) => call[0])).toEqual(['unlog']);
  });

  it('stops rather than deleting when the ranking could not be cleared', async () => {
    // `unlog` would only refuse in turn, and reporting the second refusal would name
    // the wrong cause.
    mockRpc.mockResolvedValue({ data: null, error: { code: '28000', message: 'no session' } });
    const result = await removeFromCollection({ operationId, mediaItemId, wasRanked: true });

    expect(mockRpc.mock.calls.map((call) => call[0])).toEqual(['rank_unrank']);
    expect(result).toEqual({ outcome: 'failed', message: 'Your session expired. Sign in again.' });
  });

  /**
   * **Removal is two writes, so it has a middle**, and the middle is the case independent
   * review 21c found. `rank_unrank` succeeds, the connection drops, `unlog` fails: the
   * ranking is gone and the title is still logged.
   *
   * The caller treats `failed` as "nothing happened" and skips invalidation, which is
   * right for one write and wrong for this one — the ranked list, the score denominators
   * and Rating Rascal have all moved. So the outcome says so.
   */
  it('says the ranking went even when the delete that followed it failed', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'ok' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'network down' } });

    const result = await removeFromCollection({ operationId, mediaItemId, wasRanked: true });

    expect(mockRpc.mock.calls.map((call) => call[0])).toEqual(['rank_unrank', 'unlog']);
    expect(result).toMatchObject({ outcome: 'failed', changed: true });
  });

  it('does not claim anything changed when the server refused the first write', async () => {
    // A SQLSTATE is the server answering, and a server that answered no did not commit.
    mockRpc.mockResolvedValue({ data: null, error: { code: '28000', message: 'no session' } });
    const result = await removeFromCollection({ operationId, mediaItemId, wasRanked: true });

    expect(result).not.toHaveProperty('changed');
  });

  /**
   * **A request with no SQLSTATE was never answered**, which is not the same as being
   * answered no.
   *
   * `changed` as first written meant "acknowledged success", and independent review 21d
   * found the hole: `rank_unrank` can commit and lose its reply, or `unlog` can, and
   * either comes back as a plain failure. The client cannot tell that apart from a
   * refusal — so the only safe reading is that it may have landed, and the caller
   * refreshes on the way out of the error.
   */
  it('says a title may have gone when the delete was never answered', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'network down' } });
    const result = await removeFromCollection({ operationId, mediaItemId, wasRanked: false });

    expect(result).toMatchObject({ outcome: 'failed', changed: true });
  });

  it('says the same when the unranking was never answered', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'network down' } });
    const result = await removeFromCollection({ operationId, mediaItemId, wasRanked: true });

    expect(mockRpc.mock.calls.map((call) => call[0])).toEqual(['rank_unrank']);
    expect(result).toMatchObject({ outcome: 'failed', changed: true });
  });

  it('leaves a refused write alone, so an ordinary failure does not refetch', async () => {
    // The whole point of the distinction: 42501 is the server declining, every time.
    mockRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'suspended' } });
    const result = await removeFromCollection({ operationId, mediaItemId, wasRanked: false });

    expect(result).not.toHaveProperty('changed');
  });

  /**
   * **The multi-step matrix**, which is where "a fix covers the sequence that prompted
   * it" kept biting. Two writes means three places a failure can sit, and the client's
   * observation is a separate axis from the server's outcome.
   */
  it.each([
    // name, wasRanked, rank_unrank's error, unlog's error, must the caller reconcile
    ['the unranking is refused', true, { code: '42501', message: 'no' }, null, false],
    ['the unranking is unanswered', true, { code: '', message: 'lost' }, null, true],
    ['the unranking carries 08007', true, { code: '08007', message: '?' }, null, true],
    ['the delete is refused after the unranking landed', true, null, { code: '42501', message: 'no' }, true],
    ['the delete is unanswered after the unranking landed', true, null, { code: '', message: 'lost' }, true],
    ['the only write is refused', false, null, { code: '42501', message: 'no' }, false],
    ['the only write is unanswered', false, null, { code: '', message: 'lost' }, true],
    ['the only write carries 08007', false, null, { code: '08007', message: '?' }, true],
  ])(
    'reconciles when %s',
    async (_name, wasRanked, unrankError, unlogError, reconcilable) => {
      mockRpc.mockImplementation((fn: string) => {
        const error = fn === 'rank_unrank' ? unrankError : unlogError;
        return Promise.resolve({ data: error ? null : { status: 'ok' }, error });
      });

      const result = await removeFromCollection({ operationId, mediaItemId, wasRanked });

      expect(result.outcome).toBe('failed');
      expect(mustReconcile(result)).toBe(reconcilable);
    },
  );

  it('reports a replayed removal as already applied rather than as a failure', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'already_applied' }, error: null });

    expect(await removeFromCollection({ operationId, mediaItemId, wasRanked: false })).toEqual({
      outcome: 'already_applied',
    });
  });
});
