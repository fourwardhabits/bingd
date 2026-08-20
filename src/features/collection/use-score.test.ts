import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { scoreFor } from './score';
import { useBandSizes, useTitleScore } from './use-score';

/**
 * **The worst place in the app for a silently short read**, and where it actually was.
 *
 * PostgREST caps an unbounded select at 1,000 rows and says so only in a header
 * supabase-js discards. Every other version of that defect this project has found was a
 * count that came back too small. This one is a *divisor*: `total` is the ranking
 * denominator and `sizes` is what `scoreFor` interpolates a position across, so a band
 * one member short does not make one score wrong, it makes **every score in that band**
 * wrong — and the title at position 1,001 renders "#1,001 of 1,000", which at least had
 * the decency to look impossible. Independent review 21b.
 *
 * So these tests are about arithmetic at and around the boundary, in both directions.
 * There is no other symptom to assert on: nothing errors, nothing logs, and the number
 * that comes out looks exactly like a number.
 */

jest.mock('@/lib/supabase', () => {
  // A `jest.mock` factory runs before this module's imports, so an `import` here would
  // be undefined.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPostgrest } = require('@/test-utils/postgrest');
  const client = createPostgrest();
  (globalThis as { __pg?: unknown }).__pg = client;
  return { supabase: { from: client.from }, startSessionRefresh: () => () => {} };
});

const pg = () =>
  (globalThis as unknown as { __pg: import('@/test-utils/postgrest').Postgrest }).__pg;

const USER = 'user-1';

/** `loved` first, then `fine`, then `not_for_me` — the order positions run in (I2). */
const rankings = (loved: number, fine: number, notForMe: number) =>
  [
    ...Array.from({ length: loved }, () => 'loved' as const),
    ...Array.from({ length: fine }, () => 'fine' as const),
    ...Array.from({ length: notForMe }, () => 'not_for_me' as const),
  ].map((bucket, i) => ({
    user_id: USER,
    category: 'movies',
    media_item_id: `m${String(i).padStart(6, '0')}`,
    bucket,
    position: i + 1,
  }));

const seed = (rows: unknown[]) => {
  pg().tables.rankings = rows;
};

beforeEach(() => {
  pg().reads.length = 0;
  for (const key of Object.keys(pg().requests)) delete pg().requests[key];
  for (const key of Object.keys(pg().tables)) delete pg().tables[key];
  pg().between = () => {};
});

const bands = async (rows: unknown[]) => {
  seed(rows);
  const { result } = await renderHookWithProviders(() => useBandSizes(USER, 'movies'));
  await waitFor(() => expect(result.current.data).toBeDefined(), { timeout: 10_000 });
  return result.current.data!;
};

describe('the ranking total', () => {
  it.each([999, 1000, 1001, 2000, 2500])('is %i, not a page of it', async (total) => {
    const { total: counted } = await bands(rankings(total, 0, 0));
    expect(counted).toBe(total);
  }, 30_000);

  it('asks once more when the total lands exactly on a page boundary', async () => {
    await bands(rankings(1000, 0, 0));
    // A full page cannot be known to be the last one; the empty request is the price of
    // not guessing.
    expect(pg().requests.rankings).toBe(2);
  }, 30_000);

  it('makes one request for a short first page', async () => {
    await bands(rankings(12, 3, 1));
    expect(pg().requests.rankings).toBe(1);
  });

  it('pages on the key, with a cursor rather than an offset', async () => {
    await bands(rankings(1200, 0, 0));
    const requests = pg().reads.filter((read) => read.table === 'rankings');

    expect(requests[0]!.gt).toEqual([]);
    expect(requests[1]!.gt).toEqual([['media_item_id', 'm000999']]);
    expect(requests.every((read) => !('range' in read))).toBe(true);
    // The cursor column has to be selected, or there is nothing to page on.
    expect(requests[0]!.columns).toContain('media_item_id');
  }, 30_000);

  it('reads only this account and this category', async () => {
    await bands(rankings(3, 0, 0));
    expect(pg().reads[0]!.filters).toEqual({ user_id: USER, category: 'movies' });
  });
});

describe('the band sizes, which are divisors', () => {
  it('splits a collection past the cap across its three bands', async () => {
    const { sizes, total } = await bands(rankings(900, 400, 200));
    expect(sizes).toEqual({ loved: 900, fine: 400, not_for_me: 200 });
    expect(total).toBe(1500);
  }, 30_000);

  it('does not lose the band that falls entirely past the first page', async () => {
    // 1,000 loved fills page one exactly, so before this fix `not_for_me` was zero and
    // every title in it divided by a band of nothing.
    const { sizes } = await bands(rankings(1000, 30, 20));
    expect(sizes.fine).toBe(30);
    expect(sizes.not_for_me).toBe(20);
  }, 30_000);
});

describe('the score that comes out of it', () => {
  /**
   * The whole point, in one comparison.
   *
   * A score is a position interpolated across the size of its band, so the divisor is the
   * band. Read short at 1,000 and **every score in that band moves**: the step between
   * two adjacent titles changes, so a title in the middle of the list — one nowhere near
   * the boundary, belonging to a reader who has never seen a page in their life — is
   * quietly given somebody else's number.
   *
   * The two ends are unaffected, which is the part that makes it hard to notice: the top
   * of a band is always the high and the bottom is always the low, whatever the size.
   */
  it('scores the middle of a band against the whole band, not the first page of it', async () => {
    const { sizes, total } = await bands(rankings(1200, 0, 0));
    const short = { loved: 1000, fine: 0, not_for_me: 0 };

    expect(total).toBe(1200);
    expect(scoreFor('loved', 1, sizes)).toBe(10);
    expect(scoreFor('loved', 1200, sizes)).toBe(7);

    // Position 700 of 1,200 is 8.3. Divided by a band of 1,000 it is 7.9 — the same
    // title, four tenths adrift, with nothing anywhere to say why.
    expect(scoreFor('loved', 700, sizes)).toBe(8.3);
    expect(scoreFor('loved', 700, short)).toBe(7.9);
  }, 30_000);

  it('never states "#1,001 of 1,000"', async () => {
    seed(rankings(1001, 0, 0));
    const { result } = await renderHookWithProviders(() =>
      useTitleScore(USER, 'movies', { position: 1001, bucket: 'loved' }),
    );

    await waitFor(() => expect(result.current.total).not.toBeNull(), { timeout: 10_000 });
    expect(result.current.total).toBe(1001);
    expect(result.current.score).toBe(7);
  }, 30_000);

  it('stays inside its band for every position, across a page boundary', async () => {
    const { sizes } = await bands(rankings(600, 600, 300));

    for (const position of [1, 600, 601, 1200, 1201, 1500]) {
      const bucket = position <= 600 ? 'loved' : position <= 1200 ? 'fine' : 'not_for_me';
      const score = scoreFor(bucket, position, sizes);
      const range = { loved: [7, 10], fine: [3.5, 6.9], not_for_me: [0, 3.4] }[bucket];
      expect(score).toBeGreaterThanOrEqual(range[0]!);
      expect(score).toBeLessThanOrEqual(range[1]!);
    }
  }, 30_000);
});

describe('while a ranking session is running on another device', () => {
  it('counts every row once when one is inserted mid-read', async () => {
    // A ranking insert **shifts every position below it**, which is exactly why the
    // cursor is `media_item_id` and not `position`: an offset — or a position cursor —
    // moves under this read, and the denominator comes out plausible and wrong.
    seed(rankings(1500, 0, 0));
    pg().between = (table, requests, tables) => {
      if (table !== 'rankings' || requests !== 1) return;
      for (const row of tables.rankings as { position: number }[]) row.position += 1;
      (tables.rankings as unknown[]).unshift({
        user_id: USER,
        category: 'movies',
        media_item_id: 'm000000-a',
        bucket: 'loved',
        position: 1,
      });
    };

    const { result } = await renderHookWithProviders(() => useBandSizes(USER, 'movies'));
    await waitFor(() => expect(result.current.data).toBeDefined(), { timeout: 10_000 });

    // 1,500 — the set the read began over. Not 1,501, and above all not 1,500 with one
    // row counted twice and another never seen.
    expect(result.current.data?.total).toBe(1500);
    expect(result.current.data?.sizes.loved).toBe(1500);
  }, 30_000);
});
