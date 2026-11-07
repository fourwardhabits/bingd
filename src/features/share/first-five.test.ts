import type { RankedEntry } from '@/features/collection/use-collection';

import {
  FIRST_FIVE_SHARE_URL,
  firstFiveMessage,
  firstFiveRows,
  firstFiveSpokenSummary,
} from './first-five';

const entry = (over: Partial<RankedEntry> & { position: number }): RankedEntry =>
  ({
    mediaItemId: `title-${over.position}`,
    title: `Title ${over.position}`,
    year: 2000 + over.position,
    posterPath: null,
    genres: [],
    runtimeMinutes: null,
    kind: 'movie',
    seriesTitle: null,
    bucket: 'loved',
    category: 'movies',
    ...over,
  }) as RankedEntry;

describe('firstFiveRows', () => {
  it('orders by the reader’s own position, not by the order the query answered', () => {
    const rows = firstFiveRows(
      [entry({ position: 3 }), entry({ position: 1 }), entry({ position: 2 })],
      5,
    );

    expect(rows.map((row) => row.mediaItemId)).toEqual(['title-1', 'title-2', 'title-3']);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3]);
  });

  it('stops at the count it is given', () => {
    const entries = [1, 2, 3, 4, 5, 6, 7].map((position) => entry({ position }));

    expect(firstFiveRows(entries, 5).map((row) => row.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  /**
   * A score is a position within a band, so a band's size is part of the sum. Counting only
   * the five rows drawn would print a number the title page does not, and the shared image
   * would disagree with the app it came from.
   */
  it('scores against the whole list, not just the rows it returns', () => {
    const whole = [1, 2, 3, 4, 5, 6, 7, 8].map((position) => entry({ position }));

    const fromWholeList = firstFiveRows(whole, 5).at(-1)?.score;
    const fromFiveAlone = firstFiveRows(whole.slice(0, 5), 5).at(-1)?.score;

    expect(fromWholeList).not.toBe(fromFiveAlone);
  });

  it('keeps each title’s own band, so a badge can say which it is', () => {
    const rows = firstFiveRows(
      [entry({ position: 1 }), entry({ position: 2, bucket: 'fine' })],
      5,
    );

    expect(rows.map((row) => row.bucket)).toEqual(['loved', 'fine']);
  });

  it('answers an empty list with no rows', () => {
    expect(firstFiveRows([], 5)).toEqual([]);
  });
});

describe('firstFiveMessage', () => {
  const rows = firstFiveRows(
    [
      entry({ position: 1, title: 'The Dark Knight', year: 2008 }),
      entry({ position: 2, title: 'No Year', year: null }),
    ],
    5,
  );

  it('lists every title with its score', () => {
    const message = firstFiveMessage(rows);

    expect(message).toContain('1. The Dark Knight (2008), ');
    expect(message).toContain('2. No Year, ');
  });

  it('ends by telling a stranger what to do next, and where', () => {
    expect(firstFiveMessage(rows).trimEnd().endsWith(FIRST_FIVE_SHARE_URL)).toBe(true);
  });

  /** A card is posted publicly, and an invite link in a post would attach every stranger. */
  it('sends people to the home page rather than to a personal invite', () => {
    expect(FIRST_FIVE_SHARE_URL).toBe('https://bingd.app');
  });
});

describe('firstFiveSpokenSummary', () => {
  it('says what the image shows, including the scores', () => {
    const rows = firstFiveRows([entry({ position: 1, title: 'Parasite' })], 5);

    expect(firstFiveSpokenSummary(rows)).toContain('1, Parasite, 10.0');
  });
});
