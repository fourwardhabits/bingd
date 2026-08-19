import { SENT_LIMIT, unopenedCount, unopenedIsAtLeast } from './use-sent-to-you';

import type { SentRecommendation } from './use-sent-to-you';

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

  it('asks the server for as many as it will give, which is 200', () => {
    // It was 100, which was half of what was available for no reason anybody wrote down.
    // The clamp is `least(greatest(coalesce(p_limit, 100), 1), 200)`.
    expect(SENT_LIMIT).toBe(200);
  });
});
