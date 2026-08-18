import {
  logWatched,
  newOperationId,
  removeFromCollection,
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
    });
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

  it('reports a replayed removal as already applied rather than as a failure', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'already_applied' }, error: null });

    expect(await removeFromCollection({ operationId, mediaItemId, wasRanked: false })).toEqual({
      outcome: 'already_applied',
    });
  });
});
