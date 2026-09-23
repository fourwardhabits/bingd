import {
  celebrationGrid,
  DENSITY_THRESHOLD,
  LARGE_GRID,
  SMALL_GRID,
  stableHash,
} from './celebration-posters';
import type { BreakdownRow, WatchedTitle } from './tracks';

/**
 * The wall of posters behind an award celebration.
 *
 * Two properties carry the whole feature and everything here is one of them: the wall is
 * **about the award** — the titles that actually counted toward it, first — and it is
 * **the same wall every time**, without anything being written down.
 */

const title = (id: string, over: Partial<WatchedTitle> = {}): WatchedTitle => ({
  mediaItemId: id,
  kind: 'movie',
  title: id,
  seriesTitle: null,
  seasonNumber: null,
  posterPath: `/${id}.jpg`,
  genres: [],
  language: 'en',
  year: 2020,
  watchedOn: null,
  ...over,
});

const row = (id: string, over: Partial<BreakdownRow> = {}): BreakdownRow => ({
  key: id,
  label: id,
  posterPath: `/${id}.jpg`,
  ...over,
});

const titles = (count: number, prefix = 'c') =>
  Array.from({ length: count }, (_, index) => title(`${prefix}${index}`));

const rows = (count: number, prefix = 'a') =>
  Array.from({ length: count }, (_, index) => row(`${prefix}${index}`));

const build = (over: Partial<Parameters<typeof celebrationGrid>[0]> = {}) =>
  celebrationGrid({
    contributing: [],
    collection: [],
    awardKey: 'lol-mode',
    tierKey: 'giggle',
    ...over,
  });

describe('how dense the wall is', () => {
  it('is three by three below the threshold', () => {
    const grid = build({ contributing: rows(DENSITY_THRESHOLD - 1) });

    expect([grid.columns, grid.rows]).toEqual([SMALL_GRID.columns, SMALL_GRID.rows]);
    expect(grid.posters).toHaveLength(9);
  });

  it('is four by five at the threshold and above', () => {
    const grid = build({ contributing: rows(DENSITY_THRESHOLD) });

    expect([grid.columns, grid.rows]).toEqual([LARGE_GRID.columns, LARGE_GRID.rows]);
    expect(grid.posters).toHaveLength(20);
  });

  it('never draws fifty, however large the collection', () => {
    // The founder ruled 5 × 10 out by name: at 78pt a poster is texture rather than a
    // film somebody watched.
    const grid = build({ collection: titles(400) });

    expect(grid.columns * grid.rows).toBe(20);
    expect(grid.posters).toHaveLength(20);
  });

  it('counts everything usable, not the award’s own titles alone', () => {
    // An award about comments has no contributing posters at all. A rule that read only
    // the primary set would put every non-title award on the sparse grid however large
    // the reader's collection is, which is the case the dense one is best for.
    const grid = build({ contributing: [], collection: titles(30) });

    expect(grid.columns).toBe(LARGE_GRID.columns);
  });
});

describe('which posters', () => {
  it('prefers the titles that actually counted toward the award', () => {
    // The wall is an argument that the award was earned. "Watch 25 comedies" should lead
    // with comedies, not with whatever else is in the collection.
    //
    // Nine contributing beside fifty others is a dense grid — density counts everything
    // usable — so the assertion is that the award's own titles come *first*, filling
    // every cell they can, and the collection only reaches the ones they leave.
    const grid = build({ contributing: rows(9, 'comedy'), collection: titles(50, 'other') });

    expect(grid.posters.slice(0, 9).every((poster) => poster.key.startsWith('comedy'))).toBe(
      true,
    );
    expect(grid.posters.slice(9).every((poster) => poster.key.startsWith('other'))).toBe(true);
  });

  it('is a wall of nothing but the award’s titles when it has enough of them', () => {
    const grid = build({ contributing: rows(30, 'comedy'), collection: titles(50, 'other') });

    expect(grid.posters.every((poster) => poster.key.startsWith('comedy'))).toBe(true);
  });

  it('fills the rest from the collection when the award has too few', () => {
    const grid = build({ contributing: rows(4, 'comedy'), collection: titles(20, 'other') });

    expect(grid.posters.filter((p) => p.key.startsWith('comedy'))).toHaveLength(4);
    expect(grid.posters.length).toBeGreaterThan(4);
  });

  it('falls through entirely for an award that is not about titles', () => {
    // Invites, comments, reactions. Still the reader's own wall, just not the award's.
    const grid = build({
      contributing: [
        row('person-1', { posterPath: null }),
        row('person-2', { posterPath: null }),
      ],
      collection: titles(9),
    });

    expect(grid.posters).toHaveLength(9);
    expect(grid.posters.every((poster) => poster.key.startsWith('c'))).toBe(true);
  });

  it('counts a title once however many times it arrives, before tiling', () => {
    // Deduplicated first: the same title from the breakdown and the collection is one
    // poster, and with only one there is no neighbour it could differ from.
    const shared = title('same');
    const grid = build({ contributing: [row('same'), row('same')], collection: [shared] });

    expect(new Set(grid.posters.map((poster) => poster.posterPath))).toEqual(new Set(['/same.jpg']));
  });

  it('skips a title the catalogue has no poster for', () => {
    const grid = build({ collection: [title('has'), title('none', { posterPath: null })] });

    // Only the titled one is on the wall (tiled into every cell since 2026-09-21).
    expect(new Set(grid.posters.map((poster) => poster.posterPath))).toEqual(new Set(['/has.jpg']));
  });

  it('draws a poster-less account no wall at all, rather than placeholders', () => {
    expect(build({ collection: [title('none', { posterPath: null })] }).posters).toEqual([]);
  });

  it('draws nothing at all for an empty collection, rather than placeholders', () => {
    expect(build().posters).toEqual([]);
  });
});

describe('the same wall every time', () => {
  it('gives the same answer for the same award', () => {
    const input = { contributing: rows(30), collection: titles(30) };

    expect(build(input).posters).toEqual(build(input).posters);
  });

  it('gives a different wall for a different tier of the same award', () => {
    // Crossing Cackle after Giggle is a second thing to celebrate, and celebrating it
    // with the identical picture makes the second one feel like a repeat.
    const input = { contributing: rows(30) };
    const giggle = build({ ...input, tierKey: 'giggle' }).posters.map((p) => p.key);
    const cackle = build({ ...input, tierKey: 'cackle' }).posters.map((p) => p.key);

    expect(giggle).not.toEqual(cackle);
  });

  it('is not simply the order the rows arrived in', () => {
    // If it were, "deterministic" would be a property of the query rather than of this
    // function, and a change to the fact read's ordering would silently reshuffle every
    // wall in the app.
    const grid = build({ contributing: rows(30) });

    expect(grid.posters.map((p) => p.key)).not.toEqual(
      rows(30)
        .slice(0, 20)
        .map((r) => r.key),
    );
  });

  it('does not move when titles are added afterwards, for a collection dated forward', () => {
    /**
     * The founder's requirement, and the reason `asOf` exists. A comedy watched after
     * the award was earned is not a candidate for the wall behind it, so reopening the
     * celebration next month shows the same nine films.
     */
    const earned = '2026-06-01T12:00:00Z';
    const before = titles(9, 'old').map((t) => ({ ...t, watchedOn: '2026-05-01' }));
    const after = titles(9, 'new').map((t) => ({ ...t, watchedOn: '2026-07-01' }));

    const atUnlock = build({ collection: before, asOf: earned });
    const later = build({ collection: [...before, ...after], asOf: earned });

    expect(later.posters).toEqual(atUnlock.posters);
  });

  it('counts a title watched on the day the award was earned', () => {
    // `watched_on` is a date and the unlock is an instant. Excluding the same day would
    // drop the very title that probably crossed the threshold.
    const grid = build({
      collection: [title('today', { watchedOn: '2026-06-01' })],
      asOf: '2026-06-01T12:00:00Z',
    });

    expect(new Set(grid.posters.map((poster) => poster.posterPath))).toEqual(new Set(['/today.jpg']));
  });

  it('keeps an undated title rather than emptying the wall for anyone who logs without dates', () => {
    // `watched_on` is optional and most rows have none. The cost is stated in the
    // function's own header: the wall can shift for a collection backfilled with old
    // dates, and that is the price of not storing the list.
    const grid = build({
      collection: [title('undated', { watchedOn: null })],
      asOf: '2026-06-01T12:00:00Z',
    });

    expect(new Set(grid.posters.map((poster) => poster.posterPath))).toEqual(new Set(['/undated.jpg']));
  });

  it('does not narrow at all when the unlock time could not be read', () => {
    // A ledger read that failed leaves `asOf` null. A wall built from the whole
    // collection is a better answer there than an empty one.
    const grid = build({
      collection: titles(9).map((t) => ({ ...t, watchedOn: '2030-01-01' })),
    });

    expect(grid.posters).toHaveLength(9);
  });
});

describe('the hash underneath it', () => {
  it('is stable for the same string', () => {
    expect(stableHash('lol-mode:giggle:film-1')).toBe(stableHash('lol-mode:giggle:film-1'));
  });

  it('separates strings that differ by one character', () => {
    expect(stableHash('film-1')).not.toBe(stableHash('film-2'));
  });

  it('stays a non-negative 32-bit integer', () => {
    // The sort subtracts two of these. A value that had gone negative through a sign
    // bit would order correctly by accident and stop doing so on a different input.
    for (const value of ['', 'a', 'lol-mode:wheeze:some-very-long-media-item-id-0000']) {
      const hash = stableHash(value);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

/**
 * **The wall fills the screen at the smallest collection that can earn an award**
 * (founder QA, 2026-09-21).
 *
 * An award at five ranked titles drew five posters into a 3 × 3 wall sized to cover the
 * screen, and the other four cells were a gray block behind the card. The reader's own
 * posters are now tiled into every cell — never a poster beside or beneath itself where
 * the count allows, never artwork they do not own, and the same wall every time.
 */
describe('a small collection still fills the wall', () => {
  /** The distinct posters, cell by cell, as a grid of source paths. */
  const layout = (grid: ReturnType<typeof build>) =>
    Array.from({ length: grid.rows }, (_, r) =>
      grid.posters.slice(r * grid.columns, (r + 1) * grid.columns).map((p) => p.posterPath),
    );

  const expectNoPosterBesideItself = (grid: ReturnType<typeof build>) => {
    const cells = layout(grid);
    for (let r = 0; r < cells.length; r += 1) {
      for (let c = 0; c < cells[r]!.length; c += 1) {
        if (c > 0) expect(cells[r]![c]).not.toBe(cells[r]![c - 1]);
        if (r > 0) expect(cells[r]![c]).not.toBe(cells[r - 1]![c]);
      }
    }
  };

  it.each([5, 6])('fills all nine cells from %i titles', (count) => {
    const grid = build({ collection: titles(count) });

    expect(grid.posters).toHaveLength(SMALL_GRID.columns * SMALL_GRID.rows);
    // Every one of the reader's posters is on the wall, and nothing that is not theirs.
    const drawn = new Set(grid.posters.map((p) => p.posterPath));
    expect(drawn).toEqual(new Set(titles(count).map((t) => t.posterPath)));
    expectNoPosterBesideItself(grid);
  });

  it('repeats nothing once there are enough posters, exactly as before', () => {
    const grid = build({ collection: titles(10) });

    expect(grid.posters).toHaveLength(9);
    expect(new Set(grid.posters.map((p) => p.posterPath)).size).toBe(9);
  });

  it('tiles around missing artwork rather than leaving its cell empty', () => {
    const collection = [
      ...titles(5),
      title('gone-1', { posterPath: null }),
      title('gone-2', { posterPath: null }),
    ];
    const grid = build({ collection });

    expect(grid.posters).toHaveLength(9);
    expect(grid.posters.every((p) => Boolean(p.posterPath))).toBe(true);
    expect(grid.posters.some((p) => p.key.startsWith('gone'))).toBe(false);
    expectNoPosterBesideItself(grid);
  });

  it('keeps the award’s own titles in the leading cells', () => {
    const grid = build({ contributing: rows(3), collection: titles(2) });

    expect(grid.posters.slice(0, 3).every((p) => p.key.startsWith('a'))).toBe(true);
    expect(grid.posters).toHaveLength(9);
  });

  it('checkerboards two posters, so neither ever touches itself', () => {
    const grid = build({ collection: titles(2) });

    expect(grid.posters).toHaveLength(9);
    expectNoPosterBesideItself(grid);
  });

  it('gives every cell its own key, and the first appearance keeps the title id', () => {
    const grid = build({ collection: titles(5) });
    const keys = grid.posters.map((p) => p.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => !k.includes('~'))).toHaveLength(5);
  });

  it('is the same wall every time', () => {
    const input = { collection: titles(5) };

    expect(build(input).posters).toEqual(build(input).posters);
  });
});
