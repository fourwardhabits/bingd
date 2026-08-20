import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { SENT_LIMIT, unopenedCount, unopenedIsAtLeast, useSentToYou } from './use-sent-to-you';

import type { SentRecommendation } from './use-sent-to-you';

const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => {
      const chain = {
        select: () => chain,
        in: () => chain,
        then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

beforeEach(() => {
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: [], error: null });
});

/**
 * **The one cap in this app that is the server's, not PostgREST's.**
 *
 * Every other version of this defect was a select silently truncated at 1,000 rows, and
 * the answer was to page it to exhaustion. `recommendations_to_me` clamps its own
 * `p_limit` to 200 (`20260817001300`), so there is nothing to page — which meant the
 * sweep that fixed the rest walked straight past it. Independent review 21c found it: the
 * chip read the length of a capped list as a total, so a reader with 101 unopened
 * recommendations was told they had 100, and the list agreed with the lie.
 *
 * The fix is not a bigger number. It is that a number which might be a ceiling says so.
 * The server orders unopened first, which is what makes the test exact rather than
 * defensive: unopened rows are a prefix, so if the prefix does not fill the page then
 * every unopened recommendation is in hand.
 */

const row = (over: Partial<SentRecommendation> = {}): SentRecommendation =>
  ({
    id: 'r1',
    senderId: 's1',
    senderUsername: 'ada',
    senderName: 'Ada',
    senderAvatarUri: null,
    mediaItemId: 'film-1',
    kind: 'movie',
    title: 'Heat',
    seriesTitle: null,
    posterPath: null,
    year: 1995,
    genres: [],
    language: null,
    runtimeMinutes: null,
    recommendedAt: '2026-01-01T00:00:00Z',
    openedAt: null,
    ...over,
  }) as SentRecommendation;

/** `unopened` rows first, then `opened` ones — the order the server returns. */
const list = (unopened: number, opened = 0) => [
  ...Array.from({ length: unopened }, (_, i) => row({ id: `u${i}` })),
  ...Array.from({ length: opened }, (_, i) =>
    row({ id: `o${i}`, openedAt: '2026-01-02T00:00:00Z' }),
  ),
];

describe('how many are unopened', () => {
  it('counts them', () => {
    expect(unopenedCount(list(3, 5))).toBe(3);
  });

  it('is nothing for an empty or absent list', () => {
    expect(unopenedCount([])).toBe(0);
    expect(unopenedCount(undefined)).toBe(0);
  });
});

describe('whether that number is the whole truth', () => {
  it('is exact for an ordinary list', () => {
    expect(unopenedIsAtLeast(list(3, 5))).toBe(false);
  });

  it('is still exact on a full page that has opened rows on the end of it', () => {
    // The page is full, so the *list* is capped — but the unopened rows are a prefix and
    // that prefix ended before the cap did, so there cannot be another unopened one.
    expect(unopenedIsAtLeast(list(150, SENT_LIMIT - 150))).toBe(false);
    expect(unopenedCount(list(150, SENT_LIMIT - 150))).toBe(150);
  });

  it('is a floor when the whole page is unopened', () => {
    // 200 unopened and nothing else: there is no way to tell this from 201.
    expect(unopenedIsAtLeast(list(SENT_LIMIT))).toBe(true);
    expect(unopenedCount(list(SENT_LIMIT))).toBe(SENT_LIMIT);
  });

});

/**
 * **The request, not the constant.**
 *
 * The first version of this asserted `SENT_LIMIT === 200` and nothing else, which
 * independent review 21e correctly called out: replacing `p_limit: SENT_LIMIT` with a
 * literal `100` left it green. The constant would still be 200, `unopenedIsAtLeast`
 * would still compare against 200, and a hundred unopened recommendations would be
 * presented as an exact count of a hundred while the reader had more. A test on a
 * constant proves the constant.
 */
describe('what the query actually asks the server for', () => {
  it('sends the server\'s own maximum as p_limit', async () => {
    await renderHookWithProviders(() => useSentToYou('viewer-1'));

    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(mockRpc).toHaveBeenCalledWith('recommendations_to_me', { p_limit: 200 });
  });

  it('sends the same number the ceiling test is written against', async () => {
    // The two have to agree or the floor check is measured against a page that cannot
    // reach it. Asserted as one fact rather than two, so raising one and not the other
    // is a failure rather than a silent mismatch.
    await renderHookWithProviders(() => useSentToYou('viewer-1'));

    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    const [, args] = mockRpc.mock.calls[0] as [string, { p_limit: number }];
    expect(args.p_limit).toBe(SENT_LIMIT);
  });

  it('asks once rather than paging, because the cap is the server\'s', async () => {
    // `recommendations_to_me` clamps `p_limit` to 200 itself (`20260817001300`), so
    // there is no cursor to advance and a second request would return the same rows.
    // Paging this one out is a migration, and is carried as deferred work rather than
    // faked here — see `use-sent-to-you.ts`.
    await renderHookWithProviders(() => useSentToYou('viewer-1'));

    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(
      mockRpc.mock.calls.filter(([name]) => name === 'recommendations_to_me'),
    ).toHaveLength(1);
  });
});
