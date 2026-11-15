import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { focusManager } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import {
  COMMUNITY_SCORE_STALE_MS,
  communityScoreKey,
  useCommunityScore,
} from './use-community-score';

/**
 * The community score's cache, after contributor eligibility (20261119000100, founder spec
 * t168u §4G and §4K-14).
 *
 * A reader's rankings count toward community scores only from their tenth in a category,
 * so one write can move every title in it. This device invalidates by prefix
 * (`invalidate.test.ts`); another device cannot be told, so this query is short-lived and
 * refetches when the app returns to the foreground. Those two options are the cross-device
 * answer, and these tests pin them.
 */

const mockCalls: { fn: string; args: unknown }[] = [];
let mockServed: { score: string | null; rating_count: number; min_ratings: number } = {
  score: '7.5',
  rating_count: 3,
  min_ratings: 1,
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => {
      mockCalls.push({ fn, args });
      return Promise.resolve({ data: [mockServed], error: null });
    },
  },
  startSessionRefresh: () => () => {},
}));

const USER = 'user-1';
const TITLE = 'film-1';

beforeEach(() => {
  mockCalls.length = 0;
  mockServed = { score: '7.5', rating_count: 3, min_ratings: 1 };
});

afterEach(() => {
  jest.restoreAllMocks();
  focusManager.setFocused(undefined);
});

describe('useCommunityScore', () => {
  it('reads community_score under the account-first key the invalidation prefix matches', async () => {
    const { result, client } = await renderHookWithProviders(() =>
      useCommunityScore(TITLE, USER),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockCalls).toEqual([{ fn: 'community_score', args: { p_media_item_id: TITLE } }]);
    expect(communityScoreKey(USER, TITLE)).toEqual(['community-score', USER, TITLE]);
    expect(client.getQueryData(['community-score', USER, TITLE])).toEqual({
      score: 7.5,
      ratingCount: 3,
      minRatings: 1,
    });
  });

  it('keeps a null score null: no eligible contributors is the honest "no score" state', async () => {
    mockServed = { score: null, rating_count: 0, min_ratings: 1 };
    const { result } = await renderHookWithProviders(() => useCommunityScore(TITLE, USER));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ score: null, ratingCount: 0, minRatings: 1 });
  });

  it('is fresh for sixty seconds and opts into the focus refetch, alone', async () => {
    const { result, client } = await renderHookWithProviders(() =>
      useCommunityScore(TITLE, USER),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(COMMUNITY_SCORE_STALE_MS).toBe(60_000);
    const query = client.getQueryCache().find({ queryKey: communityScoreKey(USER, TITLE) });
    const options = query?.observers[0]?.options;
    expect(options?.staleTime).toBe(60_000);
    expect(options?.refetchOnWindowFocus).toBe(true);
  });

  it('refetches on return to the app once a minute old, and not before', async () => {
    const { result } = await renderHookWithProviders(() => useCommunityScore(TITLE, USER));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockCalls).toHaveLength(1);

    // Back within the minute: still fresh, no round trip.
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockCalls).toHaveLength(1);

    // The other device crossed nine to ten meanwhile; a minute later this one returns.
    mockServed = { score: '8.1', rating_count: 4, min_ratings: 1 };
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + COMMUNITY_SCORE_STALE_MS + 1_000);
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await waitFor(() => expect(result.current.data?.ratingCount).toBe(4));
    expect(mockCalls).toHaveLength(2);
    expect(result.current.data?.score).toBe(8.1);
  });
});

/**
 * §4D: personal scores are never suppressed. The reader's own score is computed from their
 * own bands (`scoreFor`, mirrored by SQL `score_for`) and shows from their first ranking;
 * the eligibility rule lives only inside the community aggregate. Structural, like
 * `no-community-anchor.test.ts`: the personal score path may not name the community read.
 */
describe('the personal score path never reads the community score', () => {
  const COLLECTION = join(__dirname, '..', 'collection');
  const personal = ['score.ts', 'use-score.ts'].map((file) => ({
    file,
    text: readFileSync(join(COLLECTION, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1'),
  }));

  it.each([/use-community-score/, /useCommunityScore/, /['"]community_score['"]/])(
    'no personal score source reaches %s',
    (pattern) => {
      expect(personal.filter((source) => pattern.test(source.text)).map((s) => s.file)).toEqual(
        [],
      );
    },
  );
});
