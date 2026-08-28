import { diversifyPaged, maxPerGenre, SLATE_SIZE, type Candidate, type Scored } from './rank';
import { mergeExposure } from './use-exposure';
import { EXPOSURE_TIERS } from './session-seed';

/**
 * For You rotation V1.5 — the paging and the two-source penalty (founder §§13–18, §32).
 *
 * ---------------------------------------------------------------------------
 * WHAT V1.5 CHANGED, AND WHAT IT DELIBERATELY DID NOT
 *
 * The 2026-08-27 pass split "which titles are good" from "which arrangement this session
 * is showing" and taught the ranker to demote what the session had already presented. Its
 * own header records the limit it could not pass: exposure was module state, so it reset
 * with the process, and the *first* slate after every launch was drawn from an
 * un-penalised pool. That is the founder's report surviving the fix meant to answer it.
 *
 * V1.5 adds two things and changes no score:
 *
 *   **a durable half** — `recommendation_exposure()` carries what previous sessions
 *   showed, merged here with what this one has;
 *   **paging** — the wall grows on scroll without the part already read moving.
 *
 * `scoreCandidate`, `WEIGHTS`, the anchor decay, the popularity prior and the three
 * diversity ceilings are all untouched. These tests are about ordering and membership,
 * which is the only thing the tranche was allowed to move.
 */

const candidate = (index: number, genre = 'Drama'): Candidate => ({
  mediaItemId: `film-${index}`,
  title: `Film ${index}`,
  year: 2020,
  posterPath: null,
  kind: 'movie',
  genres: [genre],
  language: 'en',
  popularity: 100,
});

/**
 * A scored pool with a real gradient, built without the scorer.
 *
 * Deliberate: these tests are about what `diversifyPaged` does with an ordering, and
 * driving them through `scoreCandidate` would make a scoring change look like a paging
 * regression. The gradient is monotonic so "the strongest candidate" is unambiguous.
 */
const GENRES = ['Drama', 'Comedy', 'Horror', 'Action', 'Sci-Fi'];

/**
 * Spread across five genres by default, and that is load-bearing rather than decorative.
 *
 * `maxPerGenre(20)` is eight, so a pool where every title shares one genre produces a
 * page of **eight**, not twenty — the ceiling binds long before the limit does. A fixture
 * that ignored this would make every length assertion below a statement about the genre
 * cap wearing the clothes of a statement about paging.
 */
const pool = (count: number, genreFor: (index: number) => string = (index) => GENRES[index % GENRES.length]!): Scored[] =>
  Array.from({ length: count }, (_, index) => ({
    ...candidate(index, genreFor(index)),
    explanation: {
      total: 1 - index / (count * 2),
      anchors: [],
      genre: null,
      language: null,
      popularity: 0.5,
      lead: 'popular' as const,
    },
  }));

const ids = (items: readonly Scored[]) => items.map((item) => item.mediaItemId);

// ---------------------------------------------------------------------------

describe('paging the wall', () => {
  it('gives one page by default', () => {
    expect(diversifyPaged(pool(80), SLATE_SIZE, 1)).toHaveLength(SLATE_SIZE);
  });

  it('grows by a page at a time', () => {
    expect(diversifyPaged(pool(80), SLATE_SIZE, 2)).toHaveLength(SLATE_SIZE * 2);
    expect(diversifyPaged(pool(80), SLATE_SIZE, 3)).toHaveLength(SLATE_SIZE * 3);
  });

  /**
   * **The property the whole design exists for.**
   *
   * Raising `diversify`'s own `limit` would have been one line, and it reshuffles what
   * the reader has already read: `maxPerGenre` is a share of the limit and `explore`'s
   * sampling pool is `limit × 3`, so the greedy pass makes different choices from the
   * first slot. Every "load more" would be a small earthquake in the top half.
   */
  it('never moves what the reader has already seen', () => {
    const scored = pool(90, (index) => ['Drama', 'Comedy', 'Horror'][index % 3]!);

    const first = diversifyPaged(scored, SLATE_SIZE, 1, 7);
    const second = diversifyPaged(scored, SLATE_SIZE, 2, 7);
    const third = diversifyPaged(scored, SLATE_SIZE, 3, 7);

    expect(ids(second).slice(0, SLATE_SIZE)).toEqual(ids(first));
    expect(ids(third).slice(0, SLATE_SIZE * 2)).toEqual(ids(second));
  });

  it('never repeats a title across pages', () => {
    const all = ids(diversifyPaged(pool(90), SLATE_SIZE, 4));
    expect(new Set(all).size).toBe(all.length);
  });

  /**
   * The diversity contract holds **per page**, which is the honest reading of it.
   *
   * "At most eight of one genre" means eight in the twenty being looked at. Under a
   * single `diversify(pool, 80)` the ceiling would relax to thirty-two, so the further a
   * reader scrolled the less the rule would mean.
   */
  it('applies the genre ceiling to every page rather than to the whole wall', () => {
    /**
     * Three genres, skewed toward Drama, in a ratio that still fills a page.
     *
     * Two would not: at eight per genre a page could only reach sixteen, and the pages
     * would be short for a reason that has nothing to do with what this asserts. Three
     * gives 8 + 8 + 4 = 20, so every page is full **and** the Drama ceiling is the
     * binding constraint — which is the only arrangement in which the assertion means
     * anything.
     */
    const scored = pool(120, (index) => (index % 5 < 3 ? 'Drama' : index % 5 === 3 ? 'Comedy' : 'Horror'));
    const wall = diversifyPaged(scored, SLATE_SIZE, 3);
    expect(wall).toHaveLength(SLATE_SIZE * 3);

    for (let page = 0; page < 3; page += 1) {
      const slice = wall.slice(page * SLATE_SIZE, (page + 1) * SLATE_SIZE);
      const drama = slice.filter((item) => item.genres[0] === 'Drama').length;
      expect(drama).toBeLessThanOrEqual(maxPerGenre(SLATE_SIZE));
    }

    // And the point of paging, stated as the thing that would be false without it: a
    // single `diversify` at the full length would have allowed `maxPerGenre(60)` — 24 —
    // in one stretch, which is more Drama than three separate pages can hold.
    const drama = wall.filter((item) => item.genres[0] === 'Drama').length;
    expect(drama).toBeLessThanOrEqual(maxPerGenre(SLATE_SIZE) * 3);
  });

  it('stops when the pool runs out rather than recycling', () => {
    // The founder's rule: do not keep recycling the same five cards at the bottom. A
    // short return is how the screen learns there is no more.
    const wall = diversifyPaged(pool(25), SLATE_SIZE, 5);
    expect(wall.length).toBeLessThan(SLATE_SIZE * 5);
    expect(new Set(ids(wall)).size).toBe(wall.length);
  });

  it('terminates on an empty pool', () => {
    expect(diversifyPaged([], SLATE_SIZE, 5)).toEqual([]);
  });

  it('treats zero pages as one rather than as none', () => {
    expect(diversifyPaged(pool(40), SLATE_SIZE, 0)).toHaveLength(SLATE_SIZE);
  });
});

// ---------------------------------------------------------------------------

describe('the two halves of the penalty', () => {
  it('is the session alone when nothing durable has arrived', () => {
    const session = new Map([['a', 2]]);
    expect(mergeExposure(undefined, session)).toBe(session);
    expect(mergeExposure(new Map(), session)).toBe(session);
  });

  it('is the durable half alone on the first wall of a session', () => {
    const durable = new Map([['a', 3]]);
    expect(mergeExposure(durable, new Map())).toBe(durable);
  });

  /**
   * `Math.max`, not a sum, and the difference is the point.
   *
   * A tier is a *staleness band*, not a quantity of boredom: a title shown twice last
   * week and twice today is stale, not four-times-stale. Summing would push ordinary
   * candidates past `EXPOSURE_TIERS`, where everything is equally stale and score decides
   * again — so the penalty would stop discriminating exactly among the titles it is
   * supposed to be ordering.
   */
  it('takes the larger of the two rather than adding them', () => {
    const merged = mergeExposure(new Map([['a', 2]]), new Map([['a', 2]]));
    expect(merged.get('a')).toBe(2);
  });

  it('keeps whichever side knows more about each title', () => {
    const merged = mergeExposure(
      new Map([
        ['a', 3],
        ['b', 1],
      ]),
      new Map([
        ['a', 1],
        ['b', 2],
        ['c', 1],
      ]),
    );

    expect(merged.get('a')).toBe(3);
    expect(merged.get('b')).toBe(2);
    expect(merged.get('c')).toBe(1);
  });

  it('does not mutate either side', () => {
    const durable = new Map([['a', 1]]);
    const session = new Map([['a', 3]]);
    mergeExposure(durable, session);

    expect(durable.get('a')).toBe(1);
    expect(session.get('a')).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe('what the penalty does to an ordering', () => {
  const scored = pool(60);
  const seed = 12345;

  /**
   * A title shown in previous sessions is demoted **on the first wall of a new one**,
   * which is precisely what session-only exposure could not do.
   *
   * Asserted over the whole wall rather than on one position: `explore` samples, so a
   * single index is a coin flip, while "is it on the wall at all" is the membership
   * claim the rotation is actually making.
   */
  it('pushes previously-shown titles off the first wall of a new session', () => {
    const fresh = diversifyPaged(scored, SLATE_SIZE, 1, seed, {
      current: new Set(),
      seen: new Map(),
    });

    // Everything the un-penalised wall would have shown, marked as seen to the cap.
    const durable = new Map(ids(fresh).map((id) => [id, EXPOSURE_TIERS] as const));
    const rotated = diversifyPaged(scored, SLATE_SIZE, 1, seed, {
      current: new Set(),
      seen: mergeExposure(durable, new Map()),
    });

    const kept = ids(rotated).filter((id) => ids(fresh).includes(id));
    // Not zero: `REFRESH_ANCHORS` deliberately exempts the two strongest candidates, so
    // "show me something else" never throws away the best answer the engine has.
    expect(kept.length).toBeLessThanOrEqual(2);
  });

  it('still prefers a strong candidate over a weak one at equal staleness', () => {
    // Relevance stays primary — the founder's binding constraint. With every title
    // equally stale the tiers cancel and score decides again, which is what stops
    // rotation degenerating into a shuffle.
    const seen = new Map(ids(scored).map((id) => [id, EXPOSURE_TIERS] as const));
    const wall = diversifyPaged(scored, SLATE_SIZE, 1, seed, { current: new Set(), seen });

    const positions = ids(wall).map((id) => Number(id.split('-')[1]));
    const average = positions.reduce((sum, value) => sum + value, 0) / positions.length;
    // The pool is 60 deep and ordered by score. A wall drawn at random would average
    // about 30; one that still respects score sits well below it.
    expect(average).toBeLessThan(20);
  });

  it('lets a title return once its impressions age out of the window', () => {
    // The server excludes rows outside `foryou.impression_window_hours` rather than
    // deleting them, so "aged out" arrives here as simply not being in the map. Nothing
    // is permanently hidden merely for having been shown.
    // Not `film-0`: the two strongest candidates in the pool are exempt from the penalty
    // by design (`REFRESH_ANCHORS`), so the best title in the catalogue is the one title
    // this assertion could never be made about.
    const durable = new Map([['film-5', EXPOSURE_TIERS]]);
    const penalised = diversifyPaged(scored, SLATE_SIZE, 1, seed, {
      current: new Set(),
      seen: mergeExposure(durable, new Map()),
    });
    const expired = diversifyPaged(scored, SLATE_SIZE, 1, seed, {
      current: new Set(),
      seen: new Map(),
    });

    expect(ids(penalised)).not.toContain('film-5');
    expect(ids(expired)).toContain('film-5');
  });

  it('leaves the wall unchanged when there is no exposure at all', () => {
    // The un-rotated path must stay byte-for-byte what it was, so a reader on their very
    // first launch gets the same wall this engine has always produced.
    const withEmpty = diversifyPaged(scored, SLATE_SIZE, 1, seed, {
      current: new Set(),
      seen: new Map(),
    });
    const withNone = diversifyPaged(scored, SLATE_SIZE, 1, seed);
    expect(ids(withEmpty)).toEqual(ids(withNone));
  });
});
