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

  it('ignores a folder placeholder, which has no id', async () => {
    // Passing one to `remove` is a no-op that reports success, so counting it would
    // overstate what was deleted.
    mockList.mockResolvedValueOnce({ data: [{ name: '.emptyFolderPlaceholder', id: null }], error: null });

    expect(await deleteAllAvatars('user-1')).toBe(0);
    expect(mockRemove).not.toHaveBeenCalled();
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
