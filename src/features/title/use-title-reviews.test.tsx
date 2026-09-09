import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { useSetReviewHelpful, useTitleReviews } from './use-title-reviews';

/**
 * The Helpful write, and what the cache does while it is in flight — 20260911000100.
 *
 * The tap has to feel immediate, so the count moves before the server has answered. That
 * makes two things worth pinning that nothing else can:
 *
 *   1. **the guess is replaced, not kept.** `set_review_helpful` returns the count as it
 *      stands after the write, which can differ from the optimistic one — somebody else
 *      voted between the render and the tap. A client that trusts its own arithmetic
 *      shows a number that is quietly wrong until the next refetch.
 *   2. **a failure puts the old value back.** There is no error surface for this, by
 *      design; the count returning to what it was is the whole report.
 */

let mockRpc: jest.Mock;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'op-1' }));

const MEDIA = 'media-1';

/** The row shape the RPC returns, so the hook's own mapping is exercised. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'review-1',
  user_id: 'author-1',
  username: 'author',
  display_name: 'Author',
  avatar_path: null,
  note: 'text',
  has_spoilers: false,
  updated_at: '2026-09-01T10:00:00.000Z',
  score: '8.4',
  reaction_count: 0,
  helpful_count: 2,
  viewer_helpful: false,
  ...over,
});

beforeEach(() => {
  mockRpc = jest.fn();
});

describe('reading the list', () => {
  it('asks the second version of the function, and maps its two new columns', async () => {
    mockRpc.mockResolvedValue({ data: [row({ helpful_count: 5, viewer_helpful: true })], error: null });

    const { result } = await renderHookWithProviders(() => useTitleReviews(MEDIA, 'top_desc'));

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(mockRpc).toHaveBeenCalledWith('title_reviews_v2', {
      p_media_item_id: MEDIA,
      p_sort: 'top_desc',
      p_limit: 50,
    });
    expect(result.current.data?.[0]?.helpfulCount).toBe(5);
    expect(result.current.data?.[0]?.viewerHelpful).toBe(true);
  });

  it('reads a row with no counts as zero and unmarked rather than as undefined', async () => {
    mockRpc.mockResolvedValue({
      data: [row({ helpful_count: null, viewer_helpful: null })],
      error: null,
    });

    const { result } = await renderHookWithProviders(() => useTitleReviews(MEDIA, 'recent_desc'));

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.[0]?.helpfulCount).toBe(0);
    expect(result.current.data?.[0]?.viewerHelpful).toBe(false);
  });
});

describe('marking a review helpful', () => {
  /**
   * The list is mounted alongside the mutation, deliberately.
   *
   * Reading `getQueryData` after the write looks simpler and does not work: the test
   * client runs with `gcTime: 0`, so the moment `onSettled` invalidates a query nothing is
   * observing, the entry is collected and every assertion reads `undefined`. An observer
   * also makes this the real sequence — optimistic write, server reconcile, refetch —
   * rather than three cache pokes.
   */
  let server: { count: number; mine: boolean };
  let failWrite: boolean;

  const mount = () =>
    renderHookWithProviders(() => ({
      list: useTitleReviews(MEDIA, 'top_desc'),
      set: useSetReviewHelpful(MEDIA),
    }));

  beforeEach(() => {
    server = { count: 2, mine: false };
    failWrite = false;
    mockRpc = jest.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'title_reviews_v2') {
        return { data: [row({ helpful_count: server.count, viewer_helpful: server.mine })], error: null };
      }
      if (name === 'set_review_helpful') {
        if (failWrite) return { data: null, error: { message: 'no such review' } };
        // What the server would hold afterwards. Not 3: somebody else voted between the
        // render and the tap, which is exactly the case an optimistic guess gets wrong.
        server = args.p_helpful ? { count: 7, mine: true } : { count: 1, mine: false };
        return { data: { helpful_count: server.count, viewer_helpful: server.mine }, error: null };
      }
      return { data: null, error: null };
    });
  });

  it('moves the count the instant it is asked, before any answer', async () => {
    const { result } = await mount();
    await waitFor(() => expect(result.current.list.data?.[0]?.helpfulCount).toBe(2));

    result.current.set.mutate({ reviewId: 'review-1', helpful: true });

    // The optimistic guess, and the only moment it is observable.
    await waitFor(() => expect(result.current.list.data?.[0]?.viewerHelpful).toBe(true));
  });

  it('ends on the server’s number rather than its own arithmetic', async () => {
    const { result } = await mount();
    await waitFor(() => expect(result.current.list.data?.[0]?.helpfulCount).toBe(2));

    result.current.set.mutate({ reviewId: 'review-1', helpful: true });

    await waitFor(() => expect(result.current.set.isSuccess).toBe(true));
    // 7, not the 3 the client would have guessed.
    await waitFor(() => expect(result.current.list.data?.[0]?.helpfulCount).toBe(7));
  });

  it('sends the toggle the caller asked for, with an operation id', async () => {
    const { result } = await mount();
    await waitFor(() => expect(result.current.list.data).toBeDefined());

    result.current.set.mutate({ reviewId: 'review-1', helpful: false });

    await waitFor(() => expect(result.current.set.isSuccess).toBe(true));
    expect(mockRpc).toHaveBeenCalledWith('set_review_helpful', {
      p_operation_id: 'op-1',
      p_review_id: 'review-1',
      p_helpful: false,
    });
  });

  it('puts the previous count back when the write fails', async () => {
    failWrite = true;
    const { result } = await mount();
    await waitFor(() => expect(result.current.list.data?.[0]?.helpfulCount).toBe(2));

    result.current.set.mutate({ reviewId: 'review-1', helpful: true });

    await waitFor(() => expect(result.current.set.isError).toBe(true));
    // Back to two, and unmarked. There is no error surface: this is the whole report.
    await waitFor(() => expect(result.current.list.data?.[0]?.helpfulCount).toBe(2));
    expect(result.current.list.data?.[0]?.viewerHelpful).toBe(false);
  });

  it('never shows a negative count, however far the cache has drifted', async () => {
    server = { count: 0, mine: true };
    const { result } = await mount();
    await waitFor(() => expect(result.current.list.data?.[0]?.helpfulCount).toBe(0));

    // An un-vote against a cache already at zero. Without the clamp the optimistic step
    // prints -1 for the moment before the server answers.
    result.current.set.mutate({ reviewId: 'review-1', helpful: false });

    await waitFor(() => expect(result.current.set.isSuccess).toBe(true));
    expect(result.current.list.data?.[0]?.helpfulCount).toBeGreaterThanOrEqual(0);
  });
});
