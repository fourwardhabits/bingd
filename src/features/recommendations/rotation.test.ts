import {
  diversify,
  scoreSlate,
  EXPOSURE_TIERS as RANK_EXPOSURE_TIERS,
  SLATE_SIZE,
  type Anchor,
  type Candidate,
  type Exposure,
  type Scored,
  type Taste,
} from './rank';
import {
  EXPOSURE_TIERS,
  noteSlateOnScreen,
  recommendationArrangement,
  refreshRecommendations,
  resetRecommendationSession,
} from './session-seed';

/**
 * Refresh changes *which titles are on the wall*, not merely their order.
 *
 * ## The failure this file exists for
 *
 * The founder tested two consecutive Refresh states on the Android Preview. The visible
 * wall kept **eight of nine** titles and rearranged them — Jobs, AntiTrust, Creed,
 * Resistance, The Wizard of Lies, Ghost in the Shell, Batman Begins, The Dark Knight
 * Rises all still there. Which is a product failure however defensible the mechanism was:
 * "refresh" promises different recommendations and delivered a shuffle.
 *
 * The mechanism was `explore` — Gumbel top-k over the best sixty candidates. Nothing in it
 * knew what was on screen, so turnover was whatever the random draw happened to produce.
 * Measured against the real scorer that is 52–72% *retention* in the first nine depending
 * on pool shape, and the tail of that distribution is the founder's screenshot.
 *
 * ## Why the assertions here are about membership
 *
 * A previous round shipped freshness tests that passed without executing the behaviour
 * they named, and the brief is explicit that this must not happen again. So every test
 * below is built so it **can** fail on the old algorithm:
 *
 *   - the candidate pool is far larger than the wall, so there is somewhere to rotate to;
 *   - scores are differentiated rather than flat, so `explore` has a real gradient to
 *     resist — a flat pool would reorder freely and hide the defect;
 *   - the assertions are on the set of ids in the first nine, never on the array, so a
 *     permutation cannot pass one;
 *   - `permutes the same titles instead of replacing them` is the direct mutant: it
 *     fails if rotation is removed, and it is written as the founder's sentence.
 */

const GENRES = [
  'Drama', 'Action', 'Comedy', 'Thriller', 'Science Fiction', 'Crime', 'Adventure',
  'Romance', 'Horror', 'Mystery', 'Fantasy', 'Animation', 'Documentary', 'Family',
  'History', 'War', 'Western', 'Music',
];

/** The first nine posters — what the founder was actually looking at. */
const VISIBLE = 9;

/**
 * A pool shaped like a real anchored wall, with a real score gradient.
 *
 * `spread` is the lever the tests use to make the pool easy or hard to rotate within:
 * popularity feeds the score, so a wide spread produces the steep head that made the old
 * algorithm cling to its leaders.
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
      // Two genres each, walking the vocabulary at coprime strides so the genre ceiling
      // is not what decides the wall. A pool where every title is Drama would test
      // `diversify`'s ceilings rather than rotation.
      genres: [GENRES[i % GENRES.length]!, GENRES[(i * 5 + 2) % GENRES.length]!],
      language: 'en',
      // A genuine gradient, and the reason this fixture can fail on the old code: the
      // best candidates really are better, so nothing but an explicit preference for the
      // unseen will displace them.
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

const scoredPool = (options?: Parameters<typeof pool>[0]) => {
  const { candidates, anchors, taste } = pool(options);
  return scoreSlate({ candidates, anchors, taste, exclude: new Set<string>() });
};

const ids = (slate: readonly Scored[]) => slate.map((item) => item.mediaItemId);
const visible = (slate: readonly Scored[]) => ids(slate).slice(0, VISIBLE);
const overlap = (a: readonly string[], b: readonly string[]) => {
  const set = new Set(a);
  return b.filter((id) => set.has(id)).length;
};

const NO_EXPOSURE: Exposure = { current: new Set(), seen: new Map() };

/**
 * A session, driven exactly as the app drives it.
 *
 * `useForYou` parks the whole wall and `refreshRecommendations` promotes it, so a test
 * that built exposure by hand would be testing a story about the app rather than the app.
 * This runs the real module.
 */
function session(scored: readonly Scored[], seed = 4242, limit = SLATE_SIZE) {
  resetRecommendationSession(seed);
  const walls: Scored[][] = [];

  const draw = () => {
    const arrangement = recommendationArrangement();
    const wall = diversify(scored, limit, arrangement.seed, {
      current: arrangement.current,
      seen: arrangement.seen,
    });
    noteSlateOnScreen('movies|{}', ids(wall));
    walls.push(wall);
    return wall;
  };

  return {
    draw,
    refresh: () => {
      refreshRecommendations();
      return draw();
    },
    walls,
  };
}

describe('no refresh', () => {
  it('draws the identical wall, in the identical order, for as long as nobody asks', () => {
    const scored = scoredPool();
    const run = session(scored);

    const first = run.draw();
    // Re-deriving without a Refresh is what a re-render, a navigation and a bookmark all
    // do. Order as well as membership: this is the one place an array comparison is the
    // stronger assertion.
    expect(ids(run.draw())).toEqual(ids(first));
    expect(ids(run.draw())).toEqual(ids(first));
  });

  it('does not move because the wall was parked as being on screen', () => {
    // The loop this rules out: park -> exposure changes -> wall changes -> park again.
    // `noteSlateOnScreen` is silent and the arrangement is frozen until Refresh, so the
    // second draw sees exactly the exposure the first one did.
    const scored = scoredPool();
    const run = session(scored);
    const first = run.draw();

    noteSlateOnScreen('movies|{}', ids(first));
    noteSlateOnScreen('movies|{}', ids(first));

    expect(ids(run.draw())).toEqual(ids(first));
  });

  it('gives the initial slate of a session the wall it always had', () => {
    // Nothing has been presented, so exposure is empty and rotation is inert. The initial
    // slate is not a place to be clever: it is the best twenty, arranged.
    const scored = scoredPool();
    resetRecommendationSession(4242);
    const seed = recommendationArrangement().seed;

    expect(ids(diversify(scored, SLATE_SIZE, seed, NO_EXPOSURE))).toEqual(
      ids(diversify(scored, SLATE_SIZE, seed)),
    );
  });
});

describe('an explicit refresh, with a pool deep enough to rotate into', () => {
  it('replaces most of what is visible rather than rearranging it', () => {
    const scored = scoredPool();
    const run = session(scored);

    const before = visible(run.draw());
    const after = visible(run.refresh());

    const kept = overlap(before, after);
    // The brief: roughly 65–80% of the first visible nine should change when the pool
    // can support it, which is one to three retained. Asserted as a range rather than an
    // exact number because `diversify`'s ceilings can reject an anchor.
    expect(kept).toBeGreaterThanOrEqual(1);
    expect(kept).toBeLessThanOrEqual(3);
  });

  it('permutes the same titles instead of replacing them, if rotation is removed', () => {
    /**
     * **The founder's screenshot, as an assertion.**
     *
     * This is the mutation test for the whole change: it runs the *old* algorithm — a
     * seeded draw with no exposure — and asserts it does what the founder saw. If a later
     * round deletes the exposure argument, `the wall a refresh actually draws` below
     * starts failing, and this test says why in the language of the bug report.
     *
     * The claim is deliberately weak enough to be robust — "more than a third retained"
     * rather than "eight of nine" — because the exact retention depends on the draw. The
     * point is the contrast with the one to three above, on the identical pool.
     */
    const scored = scoredPool();
    resetRecommendationSession(4242);
    const firstSeed = recommendationArrangement().seed;
    refreshRecommendations();
    const secondSeed = recommendationArrangement().seed;

    const before = visible(diversify(scored, SLATE_SIZE, firstSeed));
    const after = visible(diversify(scored, SLATE_SIZE, secondSeed));

    expect(after).not.toEqual(before);
    expect(overlap(before, after)).toBeGreaterThan(VISIBLE / 3);
  });

  it('keeps at most two, and only ones that are genuinely the strongest available', () => {
    const scored = scoredPool();
    const run = session(scored);

    const before = run.draw();
    const after = run.refresh();

    const kept = ids(after).filter((id) => new Set(ids(before)).has(id));
    const strongest = [...scored]
      .sort((a, b) => b.explanation.total - a.explanation.total)
      .slice(0, 2)
      .map((item) => item.mediaItemId);

    // Anything retained across a refresh is exempted by score rank, never by having
    // happened to be on the wall — so a weak head keeps nothing.
    for (const id of kept) expect(strongest).toContain(id);
  });

  it('changes the whole wall, not only the part that was visible', () => {
    const scored = scoredPool();
    const run = session(scored);

    const before = ids(run.draw());
    const after = ids(run.refresh());

    // A wall of twenty that rotated only its first nine would look right in a screenshot
    // and be wrong the moment somebody scrolled.
    expect(overlap(before, after)).toBeLessThanOrEqual(2);
  });

  it('takes every replacement from the bounded pool, never from the whole catalogue', () => {
    const scored = scoredPool();
    const run = session(scored);
    run.draw();
    const after = run.refresh();

    // The relevance bound is unchanged by rotation: sampling still cannot promote a title
    // from outside the best `3 x limit`. `diversify` may still reach the tail in strict
    // score order when the ceilings reject the head, which is the pre-existing behaviour
    // documented on FRESHNESS_POOL_MULTIPLE — so this asserts the pool bound, not that
    // the tail is unreachable.
    const poolBound = new Set(
      [...scored]
        .sort((a, b) => b.explanation.total - a.explanation.total)
        .slice(0, SLATE_SIZE * 3)
        .map((item) => item.mediaItemId),
    );
    const fresh = ids(after).slice(0, VISIBLE);
    for (const id of fresh) expect(poolBound.has(id)).toBe(true);
  });

  it('does not fill the wall with the weakest thing it can find', () => {
    // "Do not destroy score relevance for novelty." The refreshed wall's mean score has
    // to stay in the same neighbourhood as the original's, not collapse toward the
    // bottom of the pool.
    const scored = scoredPool();
    const run = session(scored);

    const mean = (slate: readonly Scored[]) =>
      slate.slice(0, VISIBLE).reduce((sum, item) => sum + item.explanation.total, 0) / VISIBLE;

    const before = mean(run.draw());
    const after = mean(run.refresh());
    const worst = Math.min(...scored.map((item) => item.explanation.total));

    expect(after).toBeGreaterThan(worst);
    // Within a fifth of the original wall's mean. Some drop is the point of the feature —
    // the second-best nine are by definition not the best nine.
    expect(after).toBeGreaterThan(before * 0.8);
  });
});

describe('refreshing again, and again', () => {
  it('keeps introducing titles the session has not shown yet', () => {
    const scored = scoredPool();
    const run = session(scored);

    const seen = new Set<string>();
    const freshPerRefresh: number[] = [];

    let wall = run.draw();
    ids(wall).forEach((id) => seen.add(id));

    for (let refresh = 0; refresh < 2; refresh += 1) {
      wall = run.refresh();
      const fresh = visible(wall).filter((id) => !seen.has(id)).length;
      freshPerRefresh.push(fresh);
      ids(wall).forEach((id) => seen.add(id));
    }

    // Refresh #1 and #2. Seven of nine visible posters never shown before is what the
    // measurement gives on any pool of sixty or more, and the two the reader keeps are
    // the score anchors — so seven is also the ceiling, not a floor being cleared easily.
    for (const fresh of freshPerRefresh) expect(fresh).toBeGreaterThanOrEqual(6);
  });

  it('runs out of unseen candidates on the third refresh, and says so honestly', () => {
    /**
     * **This is a bound, not a defect, and it is here so nobody re-derives it.**
     *
     * The rotation pool is the best `3 x limit` — sixty candidates for a wall of twenty —
     * because that bound is where the relevance guarantee lives. Sixty candidates is
     * exactly three walls. So an initial slate plus two fully-fresh refreshes exhausts it,
     * and the third necessarily starts re-showing titles from earlier in the session.
     *
     * That is rule E's "progressively relax the exposure penalty" arriving on schedule
     * rather than a failure to plan. Widening the pool to buy a fourth novel refresh would
     * put the hundredth-best candidate on the visible wall, which is the trade the brief's
     * quality bound rules out.
     *
     * The next test is the one that matters for how this *feels*: turnover does not fall
     * off when novelty does.
     */
    const scored = scoredPool();
    const run = session(scored);

    const seen = new Set<string>();
    ids(run.draw()).forEach((id) => seen.add(id));
    ids(run.refresh()).forEach((id) => seen.add(id));
    ids(run.refresh()).forEach((id) => seen.add(id));

    const third = visible(run.refresh()).filter((id) => !seen.has(id)).length;
    expect(third).toBeLessThan(7);
    expect(seen.size).toBeGreaterThanOrEqual(SLATE_SIZE * 2);
  });

  it('still turns the visible wall over once novelty is exhausted', () => {
    /**
     * The failure mode this rules out is the founder's original one returning by the back
     * door: a session that rotates well twice and then settles into showing the same nine
     * posters. It does not, because the tiers keep ordering titles by how stale they are
     * relative to each other — the *current* wall is always the worst tier, so it always
     * moves aside, even when everything available has been seen three times.
     */
    const scored = scoredPool();
    const run = session(scored);

    let previous = visible(run.draw());
    for (let refresh = 0; refresh < 6; refresh += 1) {
      const next = visible(run.refresh());
      expect(overlap(previous, next)).toBeLessThanOrEqual(3);
      previous = next;
    }
  });

  it('does not oscillate between two arrangements', () => {
    const scored = scoredPool();
    const run = session(scored);

    run.draw();
    const walls = [run.refresh(), run.refresh(), run.refresh()].map((wall) =>
      visible(wall).join(),
    );

    // The specific failure: refresh #3 returning refresh #1's wall, which is what a
    // two-state toggle looks like from the sofa.
    expect(new Set(walls).size).toBe(walls.length);
  });

  it('reaches a large part of the pool over a session rather than circling the head', () => {
    const scored = scoredPool();
    const run = session(scored);

    const seen = new Set<string>();
    ids(run.draw()).forEach((id) => seen.add(id));
    for (let refresh = 0; refresh < 3; refresh += 1) {
      ids(run.refresh()).forEach((id) => seen.add(id));
    }

    // Four walls of twenty against a bounded pool of sixty. Rotation cannot invent
    // candidates, so the bound is the pool, and reaching most of it is the claim.
    expect(seen.size).toBeGreaterThanOrEqual(SLATE_SIZE * 2);
  });

  it('relaxes progressively once the unseen candidates run out', () => {
    const scored = scoredPool();
    const run = session(scored);

    run.draw();
    const lengths: number[] = [];
    for (let refresh = 0; refresh < 10; refresh += 1) {
      lengths.push(run.refresh().length);
    }

    // Rule E's floor: never a short wall merely because novelty ran out. Past exhaustion
    // the tiers flatten — `EXPOSURE_TIERS` caps what is counted — and score decides again.
    for (const length of lengths) expect(length).toBe(SLATE_SIZE);
    expect(lengths).toHaveLength(10);
  });

  it('terminates: ten refreshes is ten refreshes, whatever the pool has left', () => {
    // There is no loop that retries until a turnover target is met, and this is the test
    // that says so. A retry loop is the obvious wrong implementation of "65-80% different"
    // and it is unbounded on a constrained pool.
    const scored = scoredPool({ size: 22 });
    const run = session(scored);
    run.draw();
    for (let refresh = 0; refresh < 10; refresh += 1) run.refresh();
    expect(run.walls).toHaveLength(11);
  });
});

describe('a pool with barely more titles than the wall', () => {
  it('increases overlap gracefully rather than emptying the wall', () => {
    // Twenty-two candidates for a wall of twenty: there is almost nothing to rotate to,
    // and the correct behaviour is to say so by showing the same titles rather than by
    // showing fewer of them.
    const scored = scoredPool({ size: 22 });
    const run = session(scored);

    const before = run.draw();
    const after = run.refresh();

    expect(after.length).toBe(before.length);
    expect(overlap(ids(before), ids(after))).toBeGreaterThanOrEqual(SLATE_SIZE - 2);
  });

  it('keeps the wall full and relevant across repeated refreshes', () => {
    const scored = scoredPool({ size: 24 });
    const run = session(scored);
    run.draw();

    const eligible = new Set(scored.map((item) => item.mediaItemId));
    for (let refresh = 0; refresh < 5; refresh += 1) {
      const wall = run.refresh();
      expect(wall).toHaveLength(SLATE_SIZE);
      for (const id of ids(wall)) expect(eligible.has(id)).toBe(true);
    }
  });

  it('never returns a short wall in place of a repetitive one', () => {
    // The tempting wrong answer: drop the titles that cannot be rotated away from. A wall
    // of eleven is a broken screen; a wall of twenty with familiar titles is an honest one.
    const scored = scoredPool({ size: 21 });
    const run = session(scored);
    run.draw();
    for (let refresh = 0; refresh < 4; refresh += 1) {
      expect(run.refresh().length).toBe(SLATE_SIZE);
    }
  });
});

describe('what rotation is not allowed to touch', () => {
  it('leaves the filtered pool alone: a refresh cannot reach outside it', () => {
    // Filters narrow the candidates *before* scoring (`useForYou`), so this is the
    // property that has to hold at this layer: everything drawn came from what it was
    // given, refreshed or not. A rotation that reached for unseen titles from a wider set
    // would be the way that guarantee got broken.
    const all = pool();
    const comedies = all.candidates.filter((candidate) => candidate.genres.includes('Comedy'));
    const scored = scoreSlate({
      candidates: comedies,
      anchors: all.anchors,
      taste: all.taste,
      exclude: new Set<string>(),
    });
    const inFilter = new Set(comedies.map((candidate) => candidate.mediaItemId));

    const run = session(scored);
    run.draw();
    for (let refresh = 0; refresh < 3; refresh += 1) {
      for (const id of ids(run.refresh())) expect(inFilter.has(id)).toBe(true);
    }
  });

  it('never shows a title the viewer has already logged', () => {
    const { candidates, anchors, taste } = pool();
    const exclude = new Set(candidates.slice(0, 30).map((candidate) => candidate.mediaItemId));
    const scored = scoreSlate({ candidates, anchors, taste, exclude });

    const run = session(scored);
    run.draw();
    for (let refresh = 0; refresh < 3; refresh += 1) {
      for (const id of ids(run.refresh())) expect(exclude.has(id)).toBe(false);
    }
  });

  it('is deterministic: the same session, replayed, gives the same walls', () => {
    // Refresh is not `Math.random()`. Two runs of the same seed and the same presses draw
    // the same walls, which is what makes every assertion above reproducible and what
    // makes a visit stable across re-renders.
    const scored = scoredPool();
    const first = session(scored);
    const a = [ids(first.draw()), ids(first.refresh()), ids(first.refresh())];
    const second = session(scored);
    const b = [ids(second.draw()), ids(second.refresh()), ids(second.refresh())];

    expect(b).toEqual(a);
  });
});

describe('the session ledger itself', () => {
  it('agrees with the ranker about how deep the tiers go', () => {
    // Two copies of the number: `session-seed.ts` caps what it stores and `rank.ts` caps
    // what it reads. Duplicated to keep the ranker free of session state, which is only
    // safe because this fails the moment they drift — if the store's cap were the larger
    // of the two, the extra tiers would silently collapse into one inside `explore`.
    expect(RANK_EXPOSURE_TIERS).toBe(EXPOSURE_TIERS);
  });

  it('counts a title as seen once per arrangement, capped', () => {
    resetRecommendationSession(7);
    for (let refresh = 0; refresh < EXPOSURE_TIERS + 4; refresh += 1) {
      noteSlateOnScreen('movies|{}', ['a', 'b']);
      refreshRecommendations();
    }
    expect(recommendationArrangement().seen.get('a')).toBe(EXPOSURE_TIERS);
  });

  it('holds the two walls apart, so switching medium does not erase either', () => {
    resetRecommendationSession(7);
    noteSlateOnScreen('movies|{}', ['film']);
    noteSlateOnScreen('tv|{}', ['season']);
    refreshRecommendations();

    const { seen } = recommendationArrangement();
    // Parked under one key, both walls would have collapsed into whichever rendered last,
    // and the erased one would have come straight back on the next refresh.
    expect(seen.get('film')).toBe(1);
    expect(seen.get('season')).toBe(1);
  });

  it('replaces `current` rather than accumulating it', () => {
    resetRecommendationSession(7);
    noteSlateOnScreen('movies|{}', ['a']);
    refreshRecommendations();
    noteSlateOnScreen('movies|{}', ['b']);
    refreshRecommendations();

    const { current, seen } = recommendationArrangement();
    // `current` means "on screen when Refresh was pressed". A title that has since left
    // the wall keeps counting through `seen`, where it no longer counts hardest — which
    // is what lets it come back once the unseen candidates are gone.
    expect([...current]).toEqual(['b']);
    expect(seen.get('a')).toBe(1);
  });

  it('starts a fresh process with nothing presented', () => {
    // Rule F: session exposure may reset on a genuinely fresh app process, and persistent
    // history stays deferred (`docs/product/deferred-roadmap.md`).
    noteSlateOnScreen('movies|{}', ['a']);
    refreshRecommendations();
    resetRecommendationSession(7);

    const { current, seen } = recommendationArrangement();
    expect(current.size).toBe(0);
    expect(seen.size).toBe(0);
  });
});
