import { avatarsMayHaveGone, deleteAllAvatars } from './avatar';

/**
 * The bytes, not the row.
 *
 * `delete_account` removes `storage.objects` metadata; Supabase is explicit that a SQL
 * delete leaves the file in the bucket. Independent review 14 raised that as a Blocker
 * against a deletion that described a metadata sweep as removing somebody's picture, so
 * this function is the part that actually removes it — and 14b found that the first
 * version stopped after one page of a hundred and reported success, which is worse than
 * failing: an account with more uploads than that had its remaining bytes orphaned with
 * nobody told.
 *
 * **The return value is now three facts rather than one**, because review 21e found that
 * one could not carry them. `number | null` collapsed "nothing was removed", "a hundred
 * were removed and then the next listing failed" and "a removal request was never
 * answered" into the same `null`, and the caller — which decides whether to refetch the
 * profile and what sentence to show somebody whose account survived — cannot tell those
 * apart. So: `removed` is what definitely went, `complete` is whether the folder was
 * emptied, and `uncertain` is whether a removal request's outcome is unknown.
 *
 * Every test below is a point on the matrix: which page fails, and what the client was
 * told about it.
 */

const mockList = jest.fn();
const mockRemove = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    storage: { from: () => ({ list: (...a: unknown[]) => mockList(...a), remove: (...a: unknown[]) => mockRemove(...a) }) },
    rpc: () => Promise.resolve({ error: null }),
  },
  startSessionRefresh: () => () => {},
}));

const objects = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, index) => ({
    name: `${offset + index}.jpg`,
    id: `id-${offset + index}`,
  }));

/** A Storage 4xx: the API declined a request it understood, so nothing was deleted. */
const refused = { message: 'not authorised', status: 403, statusCode: '403' };
/** A Storage 5xx, and a dead socket. Either may have deleted before it failed. */
const serverFault = { message: 'upstream error', status: 500, statusCode: '500' };
const socketDied = { message: 'TypeError: Network request failed' };

beforeEach(() => {
  mockList.mockReset();
  mockRemove.mockReset();
  mockRemove.mockResolvedValue({ error: null });
});

describe('removing every picture an account uploaded', () => {
  it('removes what one page holds', async () => {
    mockList.mockResolvedValueOnce({ data: objects(3), error: null });

    expect(await deleteAllAvatars('user-1')).toEqual({
      removed: 3,
      complete: true,
      uncertain: false,
    });
    expect(mockRemove).toHaveBeenCalledWith(['user-1/0.jpg', 'user-1/1.jpg', 'user-1/2.jpg']);
  });

  it('keeps going past the first hundred', async () => {
    // Every upload writes a fresh filename, so an account is not limited to one
    // object — and a listing that returns a full page has not told you it is done.
    mockList
      .mockResolvedValueOnce({ data: objects(100), error: null })
      .mockResolvedValueOnce({ data: objects(100, 100), error: null })
      .mockResolvedValueOnce({ data: objects(7, 200), error: null });

    expect(await deleteAllAvatars('user-1')).toEqual({
      removed: 207,
      complete: true,
      uncertain: false,
    });
    expect(mockList).toHaveBeenCalledTimes(3);
  });

  it('lists from the start each time, because the previous pass deleted what it saw', async () => {
    mockList
      .mockResolvedValueOnce({ data: objects(100), error: null })
      .mockResolvedValueOnce({ data: objects(2, 100), error: null });

    await deleteAllAvatars('user-1');

    // Paging forward through a shrinking list would skip a page for every page
    // removed, which is exactly how half of them would be left behind.
    expect(mockList).toHaveBeenLastCalledWith('user-1', { limit: 100, offset: 0 });
  });

  it('reports nothing to remove as an empty, finished sweep', async () => {
    mockList.mockResolvedValueOnce({ data: [], error: null });

    expect(await deleteAllAvatars('user-1')).toEqual({
      removed: 0,
      complete: true,
      uncertain: false,
    });
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('empties a folder that is exactly one full page, and knows it is done', async () => {
    // The boundary the previous round got wrong elsewhere: a page that fills exactly is
    // followed by one more listing, which comes back empty. Two requests, one answer.
    mockList
      .mockResolvedValueOnce({ data: objects(100), error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    expect(await deleteAllAvatars('user-1')).toEqual({
      removed: 100,
      complete: true,
      uncertain: false,
    });
  });

  it('refuses to claim success when something in the folder is not an object', async () => {
    // Independent review 14c. Storage lists a nested folder as an entry with no id,
    // and the insert policy in 20260815030000 checked only the *first* path segment —
    // so `{id}/nested/file.jpg` was possible, invisible to the app, and sitting in a
    // public bucket. Filtering the entry away and calling the page short would report
    // everything gone while those bytes stayed.
    //
    // `20260817000600` narrows the policy so nothing new can nest. This is what keeps
    // the answer honest about anything that already did.
    mockList.mockResolvedValueOnce({ data: [{ name: 'nested', id: null }], error: null });

    expect(await deleteAllAvatars('user-1')).toEqual({
      removed: 0,
      complete: false,
      uncertain: false,
    });
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('refuses even when the rest of the page removed cleanly', async () => {
    // The dangerous shape: a real object and a folder in the same listing. Removing
    // the object and reporting the count would be a partial deletion described as a
    // complete one.
    mockList.mockResolvedValueOnce({
      data: [{ name: '1.jpg', id: 'id-1' }, { name: 'nested', id: null }],
      error: null,
    });

    expect(await deleteAllAvatars('user-1')).toMatchObject({ complete: false });
  });

  it('says it could not be sure it finished when the first listing fails', async () => {
    mockList.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });

    expect(await deleteAllAvatars('user-1')).toEqual({
      removed: 0,
      complete: false,
      uncertain: false,
    });
  });

  /**
   * **The sequence independent review 21e named**, and the reason the return type
   * changed. A page goes, the next listing fails, and the old version answered `null` —
   * so `account.tsx` could not tell it from "we removed nothing", showed the generic
   * alert and did not refetch the profile whose picture had just been deleted.
   */
  it('keeps what it definitely removed when a later listing fails', async () => {
    mockList
      .mockResolvedValueOnce({ data: objects(100), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'offline' } });

    const sweep = await deleteAllAvatars('user-1');

    expect(sweep).toEqual({ removed: 100, complete: false, uncertain: false });
    // A listing is a read. It cannot have removed anything, so the count is still exact.
    expect(sweep.uncertain).toBe(false);
    expect(avatarsMayHaveGone(sweep)).toBe(true);
  });

  it('keeps what it removed across several pages before the failure', async () => {
    mockList
      .mockResolvedValueOnce({ data: objects(100), error: null })
      .mockResolvedValueOnce({ data: objects(100, 100), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'offline' } });

    expect(await deleteAllAvatars('user-1')).toEqual({
      removed: 200,
      complete: false,
      uncertain: false,
    });
  });

  it('reports an exact count when the API declines a removal outright', async () => {
    // A 403 is the API refusing a request it understood. Those objects are still there,
    // so what was already removed is exactly what was removed.
    mockList.mockResolvedValueOnce({ data: objects(100), error: null });
    mockRemove
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: refused });
    mockList.mockResolvedValueOnce({ data: objects(5, 100), error: null });

    expect(await deleteAllAvatars('user-1')).toEqual({
      removed: 100,
      complete: false,
      uncertain: false,
    });
  });

  /**
   * **The lost reply, which is the case a count alone cannot express.**
   *
   * A 5xx or a dead socket may have deleted every object it named. Reporting the removal
   * as not having happened would let the caller tell somebody their pictures are intact
   * when they may be gone; reporting it as having happened would be the opposite lie.
   */
  it.each([
    ['a 5xx', serverFault],
    ['a socket that died with the DELETE already sent', socketDied],
  ])('says the count is a floor when a removal ends in %s', async (_name, error) => {
    mockList.mockResolvedValueOnce({ data: objects(2), error: null });
    mockRemove.mockResolvedValueOnce({ error });

    const sweep = await deleteAllAvatars('user-1');

    expect(sweep).toEqual({ removed: 0, complete: false, uncertain: true });
    // Nothing is *counted*, and the profile still has to be refetched — which is the
    // whole reason this is a separate field from the number.
    expect(avatarsMayHaveGone(sweep)).toBe(true);
  });

  it('holds an earlier page in the count when a later removal is unanswered', async () => {
    mockList
      .mockResolvedValueOnce({ data: objects(100), error: null })
      .mockResolvedValueOnce({ data: objects(4, 100), error: null });
    mockRemove.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: socketDied });

    expect(await deleteAllAvatars('user-1')).toEqual({
      removed: 100,
      complete: false,
      uncertain: true,
    });
  });

  it('gives up rather than looping on a listing that never shortens', async () => {
    // A ceiling far past anything a real account produces and far short of a hang.
    // Not complete, because the folder is demonstrably not empty — but everything
    // counted did go, and discarding that was the defect.
    mockList.mockResolvedValue({ data: objects(100), error: null });

    expect(await deleteAllAvatars('user-1')).toEqual({
      removed: 10_000,
      complete: false,
      uncertain: false,
    });
  });
});

describe('whether the caller has a profile to refetch', () => {
  it('is false only when nothing was removed and nothing is in doubt', async () => {
    // The one case where a screen may leave the avatar alone: the listing never
    // succeeded, so no `remove` was ever issued.
    mockList.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });

    expect(avatarsMayHaveGone(await deleteAllAvatars('user-1'))).toBe(false);
  });

  it('is true for a clean sweep that removed something', async () => {
    mockList.mockResolvedValueOnce({ data: objects(1), error: null });

    expect(avatarsMayHaveGone(await deleteAllAvatars('user-1'))).toBe(true);
  });

  it('is false for an account that never uploaded one', async () => {
    mockList.mockResolvedValueOnce({ data: [], error: null });

    expect(avatarsMayHaveGone(await deleteAllAvatars('user-1'))).toBe(false);
  });
});
