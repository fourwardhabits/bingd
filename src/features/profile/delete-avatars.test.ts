import { deleteAllAvatars } from './avatar';

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
 * The return value carries the whole contract. A number means "this many are gone";
 * **null means we could not be sure**, and the caller says so to the person leaving.
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

beforeEach(() => {
  mockList.mockReset();
  mockRemove.mockReset();
  mockRemove.mockResolvedValue({ error: null });
});

describe('removing every picture an account uploaded', () => {
  it('removes what one page holds', async () => {
    mockList.mockResolvedValueOnce({ data: objects(3), error: null });

    expect(await deleteAllAvatars('user-1')).toBe(3);
    expect(mockRemove).toHaveBeenCalledWith(['user-1/0.jpg', 'user-1/1.jpg', 'user-1/2.jpg']);
  });

  it('keeps going past the first hundred', async () => {
    // Every upload writes a fresh filename, so an account is not limited to one
    // object — and a listing that returns a full page has not told you it is done.
    mockList
      .mockResolvedValueOnce({ data: objects(100), error: null })
      .mockResolvedValueOnce({ data: objects(100, 100), error: null })
      .mockResolvedValueOnce({ data: objects(7, 200), error: null });

    expect(await deleteAllAvatars('user-1')).toBe(207);
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

  it('reports nothing to remove as zero rather than as a failure', async () => {
    mockList.mockResolvedValueOnce({ data: [], error: null });

    expect(await deleteAllAvatars('user-1')).toBe(0);
    expect(mockRemove).not.toHaveBeenCalled();
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

    expect(await deleteAllAvatars('user-1')).toBeNull();
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

    expect(await deleteAllAvatars('user-1')).toBeNull();
  });

  it('says it could not be sure when the listing fails', async () => {
    mockList.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });

    expect(await deleteAllAvatars('user-1')).toBeNull();
  });

  it('says the same when the removal fails', async () => {
    mockList.mockResolvedValueOnce({ data: objects(2), error: null });
    mockRemove.mockResolvedValueOnce({ error: { message: 'offline' } });

    expect(await deleteAllAvatars('user-1')).toBeNull();
  });

  it('gives up rather than looping on a listing that never shortens', async () => {
    // A ceiling far past anything a real account produces and far short of a hang.
    // Null rather than a count, because the folder is demonstrably not empty.
    mockList.mockResolvedValue({ data: objects(100), error: null });

    expect(await deleteAllAvatars('user-1')).toBeNull();
  });
});
