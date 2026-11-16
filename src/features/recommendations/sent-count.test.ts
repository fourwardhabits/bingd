import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import {
  SENT_LIMIT,
  isUnread,
  resetSentToYouSource,
  sentShortcutBadge,
  unreadCount,
  unreadInMedium,
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

/** A backend without 20261121000400: the page function is unknown, as PostgREST says it. */
const legacyBackend = (name: string) =>
  Promise.resolve(
    name === 'recommendations_to_me_page'
      ? { data: null, error: { code: 'PGRST202', message: 'not found' } }
      : { data: [], error: null },
  );

beforeEach(() => {
  mockRpc.mockReset();
  mockRpc.mockImplementation(legacyBackend);
  resetSentToYouSource();
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

  /**
   * **Codex review, #290.** With more than 200 unopened, seeing the first page makes the
   * count in hand 0 while the page is still all unopened — there may be unread rows past
   * the cap. The badge used to need a count above zero, so they vanished.
   */
  it('keeps an indicator when none in hand is unread but the page is a floor', () => {
    const allSeen = list(SENT_LIMIT).map((r) => ({ ...r, seenAt: seen }));
    expect(unreadCount(allSeen)).toBe(0);
    expect(unreadIsAtLeast(allSeen)).toBe(true);
    expect(sentShortcutBadge(allSeen, 'movies')).toEqual({
      badge: 'New',
      spoken: 'Sent to You, more may be new',
    });

    // Before it was seen, the floor as a number, as before.
    expect(sentShortcutBadge(list(SENT_LIMIT), 'movies')).toEqual({
      badge: `${SENT_LIMIT}+`,
      spoken: `Sent to You, at least ${SENT_LIMIT} new`,
    });
    // An exact count, and an exact nothing, are unchanged.
    expect(sentShortcutBadge(list(3, 5), 'movies')).toEqual({ badge: '3', spoken: 'Sent to You, 3 new' });
    const seenAndOpened = list(SENT_LIMIT - 1, 1).map((r) => ({ ...r, seenAt: seen }));
    expect(sentShortcutBadge(seenAndOpened, 'movies')).toEqual({ badge: null, spoken: 'Sent to You' });
    expect(sentShortcutBadge(undefined, 'movies')).toEqual({ badge: null, spoken: 'Sent to You' });
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

/**
 * **The unread-first page** (20261121000400, #290 Codex P2 #5). The client asks for it
 * first and falls back to `recommendations_to_me` where the backend does not have it yet,
 * remembering that for the app session.
 */
describe('recommendations_to_me_page, and falling back from it', () => {
  const calls = (name: string) => mockRpc.mock.calls.filter(([called]) => called === name);
  const ranked = (id: string, rank: 0 | 1 | 2) => ({ ...serverRow(id), read_rank: rank });

  it('asks the page function first, with the same p_limit, and maps read_rank', async () => {
    mockRpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'recommendations_to_me_page'
          ? { data: [ranked('a', 0), ranked('b', 1), ranked('c', 2)], error: null }
          : { data: [], error: null },
      ),
    );
    const { result } = await renderHookWithProviders(() => useSentToYou('viewer-1'));

    await waitFor(() => expect(result.current.data).toHaveLength(3));
    expect(mockRpc).toHaveBeenCalledWith('recommendations_to_me_page', { p_limit: SENT_LIMIT });
    expect(calls('recommendations_to_me')).toHaveLength(0);
    expect(result.current.data?.map((r) => r.readRank)).toEqual([0, 1, 2]);
  });

  it('falls back to recommendations_to_me on PGRST202, and remembers it', async () => {
    mockRpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'recommendations_to_me_page'
          ? { data: null, error: { code: 'PGRST202', message: 'not found' } }
          : { data: [serverRow('r1')], error: null },
      ),
    );
    const first = await renderHookWithProviders(() => useSentToYou('viewer-1'));
    await waitFor(() => expect(first.result.current.data).toHaveLength(1));
    expect(first.result.current.data?.[0]?.readRank).toBeNull();
    expect(mockRpc).toHaveBeenCalledWith('recommendations_to_me', { p_limit: SENT_LIMIT });

    // A second load in the same app session goes straight to the legacy function.
    const second = await renderHookWithProviders(() => useSentToYou('viewer-1'));
    await waitFor(() => expect(second.result.current.data).toHaveLength(1));
    expect(calls('recommendations_to_me_page')).toHaveLength(1);
    expect(calls('recommendations_to_me')).toHaveLength(2);
  });

  it('falls back on 42883 too', async () => {
    mockRpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'recommendations_to_me_page'
          ? { data: null, error: { code: '42883', message: 'function does not exist' } }
          : { data: [serverRow('r1')], error: null },
      ),
    );
    const { result } = await renderHookWithProviders(() => useSentToYou('viewer-1'));
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(calls('recommendations_to_me')).toHaveLength(1);
  });

  it('does not fall back on any other error: that is a failed load', async () => {
    mockRpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'recommendations_to_me_page'
          ? { data: null, error: { code: '08006', message: 'unreachable' } }
          : { data: [serverRow('r1')], error: null },
      ),
    );
    const { result } = await renderHookWithProviders(() => useSentToYou('viewer-1'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(calls('recommendations_to_me')).toHaveLength(0);
  });
});

describe('whether the count is a floor, under each server order', () => {
  const seen = '2026-01-03T00:00:00Z';
  const opened = '2026-01-04T00:00:00Z';
  /** The page order: `unread` rank-0 rows, then `seenRows` rank 1, then `openedRows` rank 2. */
  const page = (unread: number, seenRows = 0, openedRows = 0) => [
    ...Array.from({ length: unread }, (_, i) => row({ id: `u${i}`, readRank: 0 })),
    ...Array.from({ length: seenRows }, (_, i) => row({ id: `s${i}`, seenAt: seen, readRank: 1 })),
    ...Array.from({ length: openedRows }, (_, i) =>
      row({ id: `o${i}`, openedAt: opened, readRank: 2 }),
    ),
  ];

  it('unread first: a floor only for a full page that was all unread when fetched', () => {
    expect(unreadIsAtLeast(page(SENT_LIMIT))).toBe(true);
    expect(unreadIsAtLeast(page(SENT_LIMIT - 1))).toBe(false);
    // A seen row on the page ends the unread prefix, so every unread one is in hand — the
    // same page under the legacy rule (all unopened) would have been a floor.
    const endsSeen = page(SENT_LIMIT - 1, 1);
    expect(unreadIsAtLeast(endsSeen)).toBe(false);
    expect(unreadIsAtLeast(endsSeen.map((r) => ({ ...r, readRank: null })))).toBe(true);
    expect(unreadIsAtLeast(page(0, SENT_LIMIT))).toBe(false);
    expect(unreadIsAtLeast(page(100, 50, 50))).toBe(false);
  });

  it('opened only (no readRank): the legacy rule, unchanged', () => {
    expect(unreadIsAtLeast(list(SENT_LIMIT))).toBe(true);
    expect(unreadIsAtLeast(list(SENT_LIMIT - 1, 1))).toBe(false);
    expect(unreadIsAtLeast(list(SENT_LIMIT).map((r) => ({ ...r, seenAt: seen })))).toBe(true);
    expect(unreadIsAtLeast(list(SENT_LIMIT).map((r) => ({ ...r, readRank: null })))).toBe(true);
  });

  it('keeps 200+ and then New through optimistic seen marks, until the next fetch', () => {
    const fetched = page(SENT_LIMIT);
    expect(sentShortcutBadge(fetched, 'movies')).toEqual({
      badge: `${SENT_LIMIT}+`,
      spoken: `Sent to You, at least ${SENT_LIMIT} new`,
    });

    // Half marked seen in the cache: still a floor, because the rank is the fetch's.
    const half = fetched.map((r, i) => (i < 100 ? { ...r, seenAt: seen } : r));
    expect(sentShortcutBadge(half, 'movies')).toEqual({
      badge: '100+',
      spoken: 'Sent to You, at least 100 new',
    });

    // All of it marked seen: nothing in hand is unread, and more may be.
    const all = fetched.map((r) => ({ ...r, seenAt: seen }));
    expect(sentShortcutBadge(all, 'movies')).toEqual({ badge: 'New', spoken: 'Sent to You, more may be new' });

    // The next fetch ranks those as seen and brings the rest: an exact count again.
    const next = page(5, SENT_LIMIT - 5);
    expect(sentShortcutBadge(next, 'movies')).toEqual({ badge: '5', spoken: 'Sent to You, 5 new' });
  });
});

/**
 * **The side of Movies / TV on screen** (founder QA B6, 2026-11-15). The shortcut counts the
 * unread rows of the selected medium only; whether that count is a floor is still asked of
 * the whole page, because neither server order sorts by medium.
 */
describe('one side of the Movies / TV switch', () => {
  const seen = '2026-01-03T00:00:00Z';
  const film = (id: string, over: Partial<SentRecommendation> = {}) =>
    row({ id, mediaItemId: id, kind: 'movie', ...over });
  const show = (id: string, over: Partial<SentRecommendation> = {}) =>
    row({ id, mediaItemId: id, kind: id.startsWith('season') ? 'season' : 'series', ...over });

  it('counts films on Movies and series and seasons on TV', () => {
    const rows = [film('f1'), show('series-1'), show('season-1'), film('f2', { seenAt: seen })];
    expect(unreadInMedium(rows, 'movies')).toBe(1);
    expect(unreadInMedium(rows, 'tv')).toBe(2);
    expect(sentShortcutBadge(rows, 'movies')).toEqual({ badge: '1', spoken: 'Sent to You, 1 new' });
    expect(sentShortcutBadge(rows, 'tv')).toEqual({ badge: '2', spoken: 'Sent to You, 2 new' });
  });

  it('draws no count for a side with nothing unread, while the other still has some', () => {
    const rows = [film('f1', { seenAt: seen }), show('series-1')];
    expect(sentShortcutBadge(rows, 'movies')).toEqual({ badge: null, spoken: 'Sent to You' });
    expect(unreadInMedium(rows, 'tv')).toBe(1);
    expect(unreadInMedium(undefined, 'tv')).toBe(0);
  });

  /**
   * The mutant this guards: asking `unreadIsAtLeast` of the side's own rows. A full page
   * split 120 / 80 has fewer than `SENT_LIMIT` rows on either side, so that test would
   * call both counts exact while rows past the cap, of either medium, may still be unread.
   */
  it('is a floor on both sides whenever the whole page is, however the page splits', () => {
    const fetched = [
      ...Array.from({ length: 120 }, (_, i) => film(`f${i}`, { readRank: 0 })),
      ...Array.from({ length: SENT_LIMIT - 120 }, (_, i) => show(`series-${i}`, { readRank: 0 })),
    ];
    expect(unreadIsAtLeast(fetched)).toBe(true);
    expect(unreadIsAtLeast(fetched.filter((r) => r.kind === 'movie'))).toBe(false);

    expect(sentShortcutBadge(fetched, 'movies')).toEqual({
      badge: '120+',
      spoken: 'Sent to You, at least 120 new',
    });
    expect(sentShortcutBadge(fetched, 'tv')).toEqual({
      badge: '80+',
      spoken: 'Sent to You, at least 80 new',
    });

    // Every film seen: none in hand on Movies, but the rows past the cap may be films.
    const filmsSeen = fetched.map((r) => (r.kind === 'movie' ? { ...r, seenAt: seen } : r));
    expect(sentShortcutBadge(filmsSeen, 'movies')).toEqual({
      badge: 'New',
      spoken: 'Sent to You, more may be new',
    });
    expect(sentShortcutBadge(filmsSeen, 'tv').badge).toBe('80+');
    // A whole page of one medium is still a floor on the other side, which holds none.
    const allFilms = Array.from({ length: SENT_LIMIT }, (_, i) => film(`f${i}`, { readRank: 0 }));
    expect(sentShortcutBadge(allFilms, 'tv')).toEqual({
      badge: 'New',
      spoken: 'Sent to You, more may be new',
    });
    // ...but nothing in hand proves TV has anything, so no dot would be drawn for it.
    expect(unreadInMedium(allFilms, 'tv')).toBe(0);
  });

  it('is exact on both sides when the page is, even a full one', () => {
    // A seen row ends the unread prefix: every unread row of either medium is in hand.
    const fetched = [
      ...Array.from({ length: 100 }, (_, i) => film(`f${i}`, { readRank: 0 })),
      ...Array.from({ length: 99 }, (_, i) => show(`series-${i}`, { readRank: 0 })),
      film('seen-1', { seenAt: seen, readRank: 1 }),
    ];
    expect(fetched).toHaveLength(SENT_LIMIT);
    expect(sentShortcutBadge(fetched, 'movies')).toEqual({
      badge: '100',
      spoken: 'Sent to You, 100 new',
    });
    expect(sentShortcutBadge(fetched, 'tv').badge).toBe('99');

    // The legacy order: an opened row ends the unopened prefix the same way.
    const legacy = [
      ...Array.from({ length: SENT_LIMIT - 1 }, (_, i) =>
        i % 2 ? film(`f${i}`) : show(`series-${i}`),
      ),
      film('opened-1', { openedAt: seen }),
    ];
    expect(sentShortcutBadge(legacy, 'tv').badge).toBe(String(Math.ceil((SENT_LIMIT - 1) / 2)));
    expect(sentShortcutBadge(legacy, 'tv').badge).not.toMatch(/\+/);
  });
});
