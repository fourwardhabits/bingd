import {
  diversify,
  scoreSlate,
  SLATE_SIZE,
  type Anchor,
  type Candidate,
  type Exposure,
  type Scored,
  type Taste,
} from './rank';
import {
  noteSlateOnScreen,
  recommendationArrangement,
  refreshRecommendations,
  resetRecommendationSession,
} from './session-seed';

/**
 * **The five-refresh diagnostic**, and the two mechanisms it found.
 *
 * The founder's report, twice over: *Jobs* and *Creed III* recurring across weeks, an
 * external high-history user reporting repetitive recommendations, and five consecutive
 * pull-to-refreshes on a device reusing the same candidate core.
 *
 * This file measures rather than asserts a feeling. It runs five generations against the
 * real scorer and the real `diversify`, and reports overlap the way the brief asks for
 * it: pairwise, appearing in ≥3 of 5, appearing in 5 of 5, and top-position recurrence.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ESTABLISHED
 *
 * **Session rotation works.** Consecutive refreshes inside one process turn the wall
 * over almost completely — that was the 2026-08-28 fix and it holds.
 *
 * **A small number of titles survive everything, and that is by construction.**
 * `REFRESH_ANCHORS` exempts the strongest candidates in the pool from every exposure
 * penalty, so that "show me something else" cannot throw away the best answer the engine
 * has. The exemption is by rank in the pool and had no decay: while the reader's rankings
 * are stable the score order is stable, so the *same* titles were exempt on every
 * refresh, on every launch, in every week. That is the founder's Jobs and Creed III.
 *
 * The fix is not to remove the exemption — a wall that discards its best recommendation
 * on the first refresh is the opposite failure. It is to let the exemption **expire**:
 * a title stops being protected once the reader has genuinely seen it enough times. See
 * `anchorsFor` in `rank.ts`.
 * ---------------------------------------------------------------------------
 */

const VISIBLE = 9;

const GENRES = ['Drama', 'Comedy', 'Thriller', 'Action', 'Sci-Fi', 'Horror', 'Romance'];

/**
 * A pool shaped like a real anchored wall, with a real score gradient — the same fixture
 * `rotation.test.ts` uses, because a pool where every candidate scores the same would
 * measure `diversify`'s ceilings rather than rotation.
 */
function pool({ size = 120, anchors = 6 }: { size?: number; anchors?: number } = {}) {
  const perAnchor: string[][] = Array.from({ length: anchors }, () => []);
  const candidates: Candidate[] = [];

  for (let i = 0; i < size; i += 1) {
    const id = `c${String(i).padStart(3, '0')}`;
    candidates.push({
      mediaItemId: id,
      title: `Title ${i}`,
      year: 2015,
      posterPath: null,
      kind: 'movie',
      genres: [GENRES[i % GENRES.length]!, GENRES[(i * 5 + 2) % GENRES.length]!],
      language: 'en',
      popularity: Math.max(1, 400 - i * 3),
    });
    perAnchor[i % anchors]!.push(id);
  }

  const anchorList: Anchor[] = perAnchor.map((similarIds, i) => ({
    mediaItemId: `anchor-${i}`,
    title: `Anchor ${i}`,
    score: 9.5 - i * 0.2,
    similarIds,
  }));

  const taste: Taste = {
    genres: new Map(GENRES.map((genre, i) => [genre, 1 - i * 0.04])),
    languages: new Map([['en', 1]]),
    sampleSize: 40,
  };

  return { candidates, anchors: anchorList, taste };
}

const scoredPool = (size = 120) => {
  const { candidates, anchors, taste } = pool({ size });
  return scoreSlate({ candidates, anchors, taste, exclude: new Set<string>() });
};

const ids = (slate: readonly Scored[]) => slate.map((item) => item.mediaItemId);

/** Five generations, each separated by the Refresh the founder actually pressed. */
const generations = (scored: Scored[], count = 5): string[][] => {
  const out: string[][] = [];
  for (let n = 0; n < count; n += 1) {
    const arrangement = recommendationArrangement();
    const exposure: Exposure = {
      current: arrangement.current,
      seen: arrangement.seen,
    };
    const wall = ids(diversify(scored, SLATE_SIZE, arrangement.seed, exposure));
    noteSlateOnScreen('movies', wall);
    out.push(wall.slice(0, VISIBLE));
    refreshRecommendations();
  }
  return out;
};

/** How many of the five generations each title appears in. */
const frequency = (runs: string[][]) => {
  const counts = new Map<string, number>();
  for (const run of runs) for (const id of run) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
};

const appearingAtLeast = (runs: string[][], n: number) =>
  [...frequency(runs).entries()].filter(([, count]) => count >= n).map(([id]) => id);

beforeEach(() => resetRecommendationSession(1));

describe('five consecutive refreshes', () => {
  it('turns the visible wall over rather than reordering it', () => {
    // Rule C in the brief's taxonomy: the same titles on an immediate refresh. This is
    // the behaviour the 2026-08-28 session layer bought, asserted so a regression in it
    // is visible here rather than only on a device.
    const runs = generations(scoredPool());

    const consecutiveOverlap = runs.slice(1).map((run, i) => {
      const previous = new Set(runs[i]);
      return run.filter((id) => previous.has(id)).length;
    });

    // At most a third of nine kept between consecutive generations.
    for (const kept of consecutiveOverlap) expect(kept).toBeLessThanOrEqual(3);
  });

  it('leaves no title on every single generation', () => {
    /**
     * **The founder's Jobs and Creed III, as an assertion.**
     *
     * This is the one that failed before `anchorsFor` expired the exemption: the two
     * strongest candidates were exempt from every penalty by rank, the rank never moved
     * because the reader's collection did not, and so exactly those two titles sat on
     * every wall of every session for weeks.
     */
    const runs = generations(scoredPool());

    expect(appearingAtLeast(runs, 5)).toEqual([]);
  });

  it('keeps recurrence across the five to a small minority', () => {
    // Some recurrence is correct — a strong candidate should come back once the reader
    // has seen enough else — so this bounds it rather than forbidding it.
    const runs = generations(scoredPool());

    expect(appearingAtLeast(runs, 3).length).toBeLessThanOrEqual(2);
  });

  it('does not hand the top position to one title every time', () => {
    const runs = generations(scoredPool());
    const leaders = new Set(runs.map((run) => run[0]));

    expect(leaders.size).toBeGreaterThan(1);
  });
});

describe('a pool too small to rotate through', () => {
  it('still draws a full wall rather than falling back to junk', () => {
    // Ten candidates for a nine-poster wall: there is nothing to rotate to, and the
    // right answer is the best nine rather than an empty screen or filler.
    const runs = generations(scoredPool(10), 3);

    for (const run of runs) expect(run).toHaveLength(VISIBLE);
  });

  it('lets exposure lose to relevance when there is nothing else to show', () => {
    // The brief's rule 8: a low pool falls back gracefully. Repetition here is honest —
    // the alternative is padding a wall with candidates the engine does not believe in.
    const runs = generations(scoredPool(10), 3);

    expect(appearingAtLeast(runs, 3).length).toBeGreaterThan(0);
  });
});

/**
 * **The A/B/A/B question** (founder audit, 2026-09-07).
 *
 * Turnover between *consecutive* refreshes is measured above and is high. That is not
 * the same question as whether the wall is *cycling*: an engine that alternated between
 * two arrangements would pass every test in this file — consecutive overlap would be
 * near zero every time — while a reader pressing Refresh four times saw two walls twice.
 *
 * So this compares each generation to the one two before it, and to the first. If the
 * wall cycled with period two, generation 3 would match generation 1 and the numbers
 * below would be at or near nine.
 *
 * Audit only: nothing here changes weights, anchors, exposure tiers or sources.
 */
describe('whether the wall cycles rather than moves on', () => {
  const overlap = (a: readonly string[], b: readonly string[]) => {
    const set = new Set(b);
    return a.filter((id) => set.has(id)).length;
  };

  it('does not return to an earlier wall two refreshes later', () => {
    const runs = generations(scoredPool(), 6);

    // Period-two cycling would put generation n back on generation n-2.
    const twoBack = runs.slice(2).map((run, i) => overlap(run, runs[i]!));
    for (const kept of twoBack) expect(kept).toBeLessThanOrEqual(4);
  });

  it('keeps drifting away from the first wall rather than orbiting it', () => {
    const runs = generations(scoredPool(), 6);

    // Against the opening wall, every later generation stays a minority of nine.
    const againstFirst = runs.slice(1).map((run) => overlap(run, runs[0]!));
    for (const kept of againstFirst) expect(kept).toBeLessThanOrEqual(4);
  });

  it('visits more distinct titles than two walls could hold', () => {
    // Six generations of nine. Two alternating arrangements would show at most 18
    // distinct titles however many times they were refreshed.
    const runs = generations(scoredPool(), 6);
    const distinct = new Set(runs.flat());

    expect(distinct.size).toBeGreaterThan(18);
  });
});
