import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import {
  SENT_LIMIT,
  isUnread,
  unreadCount,
  unreadIsAtLeast,
  useSentToYou,
} from './use-sent-to-you';

import type { SentRecommendation } from './use-sent-to-you';

const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
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
    seenAt: null,
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
    expect(unreadCount(list(3, 5))).toBe(3);
  });

  it('is nothing for an empty or absent list', () => {
    expect(unreadCount([])).toBe(0);
    expect(unreadCount(undefined)).toBe(0);
  });
});

describe('whether that number is the whole truth', () => {
  it('is exact for an ordinary list', () => {
    expect(unreadIsAtLeast(list(3, 5))).toBe(false);
  });

  it('is still exact on a full page that has opened rows on the end of it', () => {
    // The page is full, so the *list* is capped — but the unopened rows are a prefix and
    // that prefix ended before the cap did, so there cannot be another unopened one.
    expect(unreadIsAtLeast(list(150, SENT_LIMIT - 150))).toBe(false);
    expect(unreadCount(list(150, SENT_LIMIT - 150))).toBe(150);
  });

  it('is a floor when the whole page is unopened', () => {
    // 200 unopened and nothing else: there is no way to tell this from 201.
    expect(unreadIsAtLeast(list(SENT_LIMIT))).toBe(true);
    expect(unreadCount(list(SENT_LIMIT))).toBe(SENT_LIMIT);
  });

});

/**
 * **Unread is neither opened nor seen** (FU1113-E, 20261121000100). The dot counts unread;
 * the floor test still reads `openedAt`, because the server's order is still unopened first.
 */
describe('unread', () => {
  const seen = '2026-01-03T00:00:00Z';

  it('is neither opened nor seen', () => {
    expect(isUnread(row())).toBe(true);
    expect(isUnread(row({ seenAt: seen }))).toBe(false);
    expect(isUnread(row({ openedAt: seen }))).toBe(false);
  });

  it('is what the dot counts', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', seenAt: seen }), ...list(0, 2)];
    expect(unreadCount(rows)).toBe(1);
  });

  it('is a floor only when the whole full page is unopened, seen or not', () => {
    // 200 unopened, some of them seen: there may be unread ones beyond the cap.
    const full = list(SENT_LIMIT).map((r, i) => (i < 50 ? { ...r, seenAt: seen } : r));
    expect(unreadCount(full)).toBe(SENT_LIMIT - 50);
    expect(unreadIsAtLeast(full)).toBe(true);

    // An opened row on the page ends the unopened prefix, so the count is exact.
    expect(unreadIsAtLeast(list(SENT_LIMIT - 1, 1))).toBe(false);
  });

  it('reads seen_at from the server, and treats an older backend without it as unseen', async () => {
    mockRpc.mockResolvedValue({
      data: [
        { ...serverRow('r1'), seen_at: seen },
        serverRow('r2'), // no seen_at at all: a backend before 20261121000100
      ],
      error: null,
    });
    const { result } = await renderHookWithProviders(() => useSentToYou('viewer-1'));

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(result.current.data?.map((r) => r.seenAt)).toEqual([seen, null]);
    expect(unreadCount(result.current.data)).toBe(1);
  });
});

const serverRow = (id: string) => ({
  id,
  sender_id: 's1',
  sender_username: 'ada',
  sender_display_name: 'Ada',
  sender_avatar_path: null,
  media_item_id: `film-${id}`,
  media_kind: 'movie',
  media_title: 'Heat',
  series_title: null,
  poster_path: null,
  release_date: '1995-12-15',
  genres: [],
  original_language: 'en',
  runtime_minutes: 170,
  recommended_at: '2026-01-01T00:00:00Z',
  opened_at: null,
  message: null,
});

/**
 * **The request, not the constant.**
 *
 * The first version of this asserted `SENT_LIMIT === 200` and nothing else, which
 * independent review 21e correctly called out: replacing `p_limit: SENT_LIMIT` with a
 * literal `100` left it green. The constant would still be 200, `unreadIsAtLeast`
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
