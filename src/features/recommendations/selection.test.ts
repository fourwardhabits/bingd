import {
  maxPerAnchor,
  maxPerFranchise,
  scoreSlate,
  franchiseKey,
  type Anchor,
  type Candidate,
  type Scored,
  type Taste,
} from './rank';
import {
  FOR_YOU_SELECTION,
  drawSlate,
  exposurePenalty,
  qualifiedPool,
  type ExposureEntry,
} from './selection';

/**
 * **For You V2 selection** (2026-09-13): the qualified pool, score-weighted sampling, decayed
 * exposure and light diversity, each pinned by the property it exists for.
 *
 * Bounds are structural or deliberately loose — the evidence for the constants is the
 * real-profile simulation in `recommendations.md` §11, and a test tuned to that output
 * would pin the fixture rather than the behaviour.
 */

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 13, 12);
const GENRES = ['Drama', 'Comedy', 'Thriller', 'Action', 'Horror', 'Romance', 'Crime'];

/** A realistic anchored pool: six anchors, a real score gradient, mixed genres. */
function pool(size = 120, genreOf: (index: number) => string[] = (i) => [GENRES[i % GENRES.length]!, GENRES[(i * 3 + 1) % GENRES.length]!]) {
  const perAnchor: string[][] = Array.from({ length: 6 }, () => []);
  const candidates: Candidate[] = [];
  for (let index = 0; index < size; index += 1) {
    const id = `c${String(index).padStart(3, '0')}`;
    candidates.push({
      mediaItemId: id,
      title: `Title ${index}`,
      year: 2000 + (index % 25),
      posterPath: null,
      kind: 'movie',
      genres: genreOf(index),
      language: 'en',
      popularity: Math.max(1, 400 - index * 3),
    });
    perAnchor[index % 6]!.push(id);
  }
  const anchors: Anchor[] = perAnchor.map((similarIds, index) => ({
    mediaItemId: `anchor-${index}`,
    title: `Anchor ${index}`,
    score: 9.5 - index * 0.3,
    similarIds,
  }));
  const taste: Taste = {
    genres: new Map(GENRES.map((genre, index) => [genre, 1 - index * 0.08])),
    languages: new Map([['en', 1]]),
    sampleSize: 40,
  };
  return scoreSlate({ candidates, anchors, taste, exclude: new Set() });
}

const ids = (items: readonly Scored[]) => items.map((item) => item.mediaItemId);
const overlap = (a: readonly Scored[], b: readonly Scored[]) => {
  const other = new Set(ids(b));
  return a.filter((item) => other.has(item.mediaItemId)).length;
};
const mean = (items: readonly Scored[]) =>
  items.reduce((total, item) => total + item.explanation.total, 0) / Math.max(1, items.length);
const strictTop = (scored: readonly Scored[], count: number) =>
  [...scored].sort((a, b) => b.explanation.total - a.explanation.total).slice(0, count);
const draw = (scored: readonly Scored[], seed: number, extra: Partial<Parameters<typeof drawSlate>[1]> = {}) =>
  drawSlate(scored, { pageSize: 20, pages: 1, seed, now: NOW, ...extra });

describe('the qualified pool', () => {
  it('is measured against the first page’s quality frontier, not a fixed top sixty', () => {
    const scored = pool(200);
    const byScore = strictTop(scored, 200);
    const frontier = byScore[FOR_YOU_SELECTION.frontierRank - 1]!.explanation.total;
    const { pool: qualified, rest } = qualifiedPool(scored);
    expect(qualified.length + rest.length).toBe(200);
    for (const item of qualified.slice(FOR_YOU_SELECTION.minPool)) {
      expect(item.explanation.total).toBeGreaterThanOrEqual(frontier * FOR_YOU_SELECTION.qualifyRatio);
    }
    for (const item of rest) {
      expect(item.explanation.total).toBeLessThanOrEqual(qualified[qualified.length - 1]!.explanation.total);
    }
  });

  it('never samples from fewer than the floor or more than the ceiling', () => {
    expect(qualifiedPool(pool(30)).pool).toHaveLength(30);
    const flat = pool(400).map((item) => ({ ...item, explanation: { ...item.explanation, total: 0.5 } }));
    expect(qualifiedPool(flat).pool).toHaveLength(FOR_YOU_SELECTION.maxPool);
    const steep = pool(200).map((item, index) => ({ ...item, explanation: { ...item.explanation, total: 1 / (1 + index) } }));
    expect(qualifiedPool(steep).pool).toHaveLength(FOR_YOU_SELECTION.minPool);
  });

  it('is empty for an empty slate, and the draw is then empty too', () => {
    expect(qualifiedPool([])).toEqual({ pool: [], rest: [], baseSize: 0 });
    expect(draw([], 1)).toEqual([]);
  });
});

describe('drawing the wall', () => {
  it('is deterministic: the same seed and inputs always give the same wall', () => {
    const scored = pool();
    expect(ids(draw(scored, 42))).toEqual(ids(draw(scored, 42)));
    expect(ids(draw([...scored].reverse(), 42))).toEqual(ids(draw(scored, 42)));
  });

  it('draws a different wall under a different seed, from the same qualified pool', () => {
    const scored = pool();
    const qualified = new Set(ids(qualifiedPool(scored).pool));
    const walls = [1, 2, 3, 4, 5].map((seed) => draw(scored, seed));
    expect(new Set(walls.map((wall) => ids(wall).join())).size).toBe(5);
    for (const wall of walls) for (const item of wall) expect(qualified.has(item.mediaItemId)).toBe(true);
  });

  it('keeps stronger titles more likely to lead without guaranteeing the lead to any', () => {
    // A computed #1 is a neighbourhood, not a verdict. Measured on this pool: the best title
    // leads 87 of 400 fresh walls, the second 62, the tenth 3.
    const scored = pool();
    const byScore = strictTop(scored, 120);
    const leads = new Map<string, number>();
    const onWall = new Map<string, number>();
    for (let seed = 1; seed <= 400; seed += 1) {
      const wall = draw(scored, seed);
      leads.set(wall[0]!.mediaItemId, (leads.get(wall[0]!.mediaItemId) ?? 0) + 1);
      for (const id of ids(wall)) onWall.set(id, (onWall.get(id) ?? 0) + 1);
    }
    const best = byScore[0]!.mediaItemId;
    const tenth = byScore[9]!.mediaItemId;
    const weakestQualified = qualifiedPool(scored).pool.at(-1)!.mediaItemId;
    expect(leads.get(best) ?? 0).toBeGreaterThan((leads.get(tenth) ?? 0) * 5);
    expect(leads.get(best) ?? 0).toBeLessThan(200);
    expect(onWall.get(best) ?? 0).toBeGreaterThan((onWall.get(weakestQualified) ?? 0) * 2);
  });

  it('is not uniform: the wall’s mean score stays close to the strict top twenty', () => {
    // The quality-regression guard. Real profiles measured −2% to +0% on the first wall.
    const scored = pool();
    const ceiling = mean(strictTop(scored, 20));
    for (let seed = 1; seed <= 50; seed += 1) {
      expect(mean(draw(scored, seed))).toBeGreaterThanOrEqual(ceiling * 0.9);
    }
    // And a uniform draw from the same pool would sit well below that.
    const qualified = qualifiedPool(scored).pool;
    expect(mean(qualified)).toBeLessThan(ceiling * 0.95);
  });

  it('keeps the prefix fixed as the wall grows by pages', () => {
    const scored = pool(200);
    const one = draw(scored, 9, { pages: 1 });
    const three = draw(scored, 9, { pages: 3 });
    expect(ids(three.slice(0, 20))).toEqual(ids(one));
    expect(three).toHaveLength(60);
    expect(new Set(ids(three)).size).toBe(60);
  });

  it('continues past the qualified pool only in strict score order', () => {
    const scored = pool(200);
    // The pool a five-page draw actually uses: extended while unseen titles are short.
    const { pool: qualified, rest } = qualifiedPool(scored, FOR_YOU_SELECTION, { need: 100, recent: () => false });
    const wall = draw(scored, 3, { pages: 5 });
    const beyond = wall.filter((item) => !qualified.some((q) => q.mediaItemId === item.mediaItemId));
    const restOrder = ids(rest);
    const positions = beyond.map((item) => restOrder.indexOf(item.mediaItemId));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('keeps the hard ceilings on every page: four per anchor, two per franchise', () => {
    const franchised = pool(160).map((item, index) => ({ ...item, title: index % 5 === 0 ? `Saga: Part ${index}` : item.title }));
    const wall = draw(franchised, 11, { pages: 4 });
    for (let start = 0; start < wall.length; start += 20) {
      const page = wall.slice(start, start + 20);
      const perAnchor = new Map<string, number>();
      const perFranchise = new Map<string, number>();
      for (const item of page) {
        for (const hit of item.explanation.anchors) perAnchor.set(hit.mediaItemId, (perAnchor.get(hit.mediaItemId) ?? 0) + 1);
        const key = franchiseKey(item.title);
        if (key) perFranchise.set(key, (perFranchise.get(key) ?? 0) + 1);
      }
      expect(Math.max(0, ...perAnchor.values())).toBeLessThanOrEqual(maxPerAnchor());
      expect(Math.max(0, ...perFranchise.values())).toBeLessThanOrEqual(maxPerFranchise());
    }
  });

  it('never changes a score or an explanation — only which titles and in what order', () => {
    const scored = pool();
    const byId = new Map(scored.map((item) => [item.mediaItemId, item]));
    for (const item of draw(scored, 5, { pages: 3 })) expect(item).toBe(byId.get(item.mediaItemId));
  });
});

describe('light diversity, not quotas', () => {
  it('still gives a single-genre reader a single-genre wall', () => {
    const horror = pool(120, () => ['Horror']);
    const wall = draw(horror, 7);
    expect(wall).toHaveLength(20);
    expect(wall.every((item) => item.genres[0] === 'Horror')).toBe(true);
  });

  it('spreads genres when equally good alternatives exist', () => {
    // Two genres, alternating, identical score gradients: without the penalty a lucky run of
    // one genre could fill the page; with it, neither dominates.
    const mixed = pool(120, (index) => [index % 2 === 0 ? 'Horror' : 'Comedy']);
    const noPenalty = { ...FOR_YOU_SELECTION, genreRepeatPenalty: 0 };
    let worstWith = 0;
    let worstWithout = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const count = (wall: readonly Scored[]) => Math.max(...['Horror', 'Comedy'].map((genre) => wall.filter((item) => item.genres[0] === genre).length));
      worstWith = Math.max(worstWith, count(draw(mixed, seed)));
      worstWithout = Math.max(worstWithout, count(draw(mixed, seed, { config: noPenalty })));
    }
    expect(worstWith).toBeLessThanOrEqual(worstWithout);
    expect(worstWith).toBeLessThanOrEqual(14);
  });
});

describe('exposure decays rather than expiring', () => {
  const entry = (hoursAgo: number, count = 1): ExposureEntry => ({ count, lastShownAt: NOW - hoursAgo * HOUR });

  it('is zero for a title never shown', () => {
    expect(exposurePenalty(undefined, undefined, NOW)).toBe(0);
  });

  it('falls monotonically with age and never becomes infinite', () => {
    const ages = [0, 1, 6, 17, 19, 24, 48, 96, 168, 336, 1000];
    const penalties = ages.map((age) => exposurePenalty(entry(age, 3), undefined, NOW));
    for (let index = 1; index < penalties.length; index += 1) {
      expect(penalties[index]!).toBeLessThanOrEqual(penalties[index - 1]!);
    }
    for (const penalty of penalties) expect(Number.isFinite(penalty)).toBe(true);
  });

  it('suppresses the same day strongly, a few days moderately, and weeks barely', () => {
    const today = exposurePenalty(entry(2), undefined, NOW);
    const days = exposurePenalty(entry(72), undefined, NOW);
    const weeks = exposurePenalty(entry(24 * 21), undefined, NOW);
    expect(today).toBeGreaterThan(FOR_YOU_SELECTION.recentPenalty);
    expect(days).toBeGreaterThan(weeks * 4);
    expect(days).toBeLessThan(FOR_YOU_SELECTION.exposureStrength * Math.log2(2) + 1e-9);
    expect(weeks).toBeLessThan(0.1);
  });

  it('has no 72-hour cliff: a title shown three days and one hour ago is still penalised', () => {
    const before = exposurePenalty(entry(71), undefined, NOW);
    const after = exposurePenalty(entry(73), undefined, NOW);
    expect(after).toBeGreaterThan(0);
    expect(before - after).toBeLessThan(0.1);
  });

  it('takes the stronger of the server’s record and this session’s, without adding them', () => {
    const durable = entry(48, 1);
    const session = NOW - 1 * HOUR;
    const both = exposurePenalty(durable, session, NOW);
    expect(both).toBe(exposurePenalty(undefined, session, NOW));
  });

  it('prefers unseen titles of close quality over ones seen a couple of days ago', () => {
    // Measured on this pool over 40 seeds: 7.2 of 20 recur with two-day-old exposure, against
    // 13.0 with none. Moderate, not a blacklist — some strong titles deserve to return.
    const scored = pool();
    let withExposure = 0;
    let withoutExposure = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const first = draw(scored, seed * 7);
      const durable = new Map(ids(first).map((id) => [id, entry(48)]));
      withExposure += overlap(draw(scored, seed * 7 + 1, { durable }), first);
      withoutExposure += overlap(draw(scored, seed * 7 + 1), first);
    }
    expect(withExposure).toBeLessThan(withoutExposure * 0.7);
    expect(withExposure).toBeGreaterThan(0);
  });

  it('lets a strong title recur once enough time has passed', () => {
    const scored = pool();
    const first = draw(scored, 31);
    const longAgo = new Map(ids(first).map((id) => [id, entry(24 * 30)]));
    const later = draw(scored, 31, { durable: longAgo });
    // Same seed, month-old exposure: essentially the same wall again. Not a blacklist.
    expect(overlap(later, first)).toBeGreaterThanOrEqual(16);
  });

  it('still fills the wall from exposed titles when nothing unseen qualifies', () => {
    const scored = pool(40);
    const everything = new Map(scored.map((item) => [item.mediaItemId, entry(1, 5)]));
    expect(draw(scored, 5, { durable: everything })).toHaveLength(20);
  });
});

describe('explicit Refresh', () => {
  it('draws a genuinely new wall from the qualified pool', () => {
    const scored = pool();
    const first = draw(scored, 100);
    const session = new Map(ids(first).map((id) => [id, NOW]));
    const refreshed = draw(scored, 101, { now: NOW + 5 * 60_000, session });
    expect(overlap(refreshed, first)).toBeLessThanOrEqual(2);
    expect(mean(refreshed)).toBeGreaterThanOrEqual(mean(strictTop(scored, 20)) * 0.85);
  });
});

describe('what the review of V2 found', () => {
  const HOUR_MS = 3_600_000;

  it('never hands back the wall on screen across consecutive Refreshes, even on a steep pool', () => {
    // M1: a steep profile clamped its pool at forty and ran out of unseen titles by the second
    // Refresh. The on-screen tier and the pool extension keep every Refresh a new wall.
    const steep = pool(200).map((item, index) => ({
      ...item,
      explanation: { ...item.explanation, total: 0.9 * 0.985 ** index },
    }));
    const session = new Map<string, number>();
    let now = NOW;
    let previous = draw(steep, 1, { now, session });
    for (let press = 2; press <= 7; press += 1) {
      for (const id of ids(previous)) session.set(id, now);
      now += 5 * 60_000;
      const next = draw(steep, press, { now, session, current: new Set(ids(previous)) });
      expect(next).toHaveLength(20);
      expect(overlap(next, previous)).toBeLessThanOrEqual(2);
      previous = next;
    }
  });

  it('extends the pool only as far as relevance allows', () => {
    const scored = pool(200);
    const byScore = strictTop(scored, 200);
    const frontier = byScore[FOR_YOU_SELECTION.frontierRank - 1]!.explanation.total;
    const everyone = qualifiedPool(scored, FOR_YOU_SELECTION, { need: 10_000, recent: () => true }).pool;
    for (const item of everyone.slice(FOR_YOU_SELECTION.minPool)) {
      expect(item.explanation.total).toBeGreaterThanOrEqual(frontier * FOR_YOU_SELECTION.extendRatio);
    }
    expect(everyone.length).toBeLessThanOrEqual(FOR_YOU_SELECTION.maxPool);
  });

  it('draws five pages from a full pool quickly enough for the JS thread', () => {
    // M2. Desktop measured 145 ms before per-title metadata was hoisted out of the pick loop.
    // A generous bound: it guards against the quadratic recomputation returning.
    const flat = pool(400).map((item) => ({ ...item, explanation: { ...item.explanation, total: 0.5 } }));
    draw(flat, 1, { pages: 5 });
    const started = performance.now();
    for (let seed = 2; seed <= 6; seed += 1) draw(flat, seed, { pages: 5 });
    expect((performance.now() - started) / 5).toBeLessThan(60);
  });

  it('replaces a dismissed title without reshuffling the rest of the wall', () => {
    // Minor 1. The veto is inside the draw, so the frontier and tau do not move.
    const scored = pool();
    let kept = 0;
    let possible = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      const wall = draw(scored, seed);
      const dismissed = wall[seed % 20]!.mediaItemId;
      const after = draw(scored, seed, { veto: new Set([dismissed]) });
      expect(ids(after)).not.toContain(dismissed);
      const before = ids(wall).filter((id) => id !== dismissed);
      kept += before.filter((id) => ids(after).includes(id)).length;
      possible += before.length;
    }
    expect(kept / possible).toBeGreaterThanOrEqual(0.85);
  });

  it('treats a title on screen now as staler than one seen hours ago', () => {
    const onScreen = exposurePenalty(undefined, NOW, NOW) + FOR_YOU_SELECTION.onScreenPenalty;
    const earlier = exposurePenalty(undefined, NOW - 10 * HOUR_MS, NOW);
    expect(onScreen).toBeGreaterThan(earlier + 10);
  });
});

describe('the pool extension and the veto, pinned exactly', () => {
  const HOUR_MS = 3_600_000;

  it('leaves the wall identical when the vetoed title was not on it', () => {
    // The veto is inside the draw, so the frontier and τ are the whole scoring's. Vetoing the
    // pool's lowest title — which moves τ if it is removed first — must not move the wall.
    const scored = pool();
    for (let seed = 1; seed <= 20; seed += 1) {
      const wall = draw(scored, seed);
      const onWall = new Set(ids(wall));
      const offWall = qualifiedPool(scored).pool.filter((item) => !onWall.has(item.mediaItemId));
      const lowest = offWall[offWall.length - 1]!.mediaItemId;
      expect(ids(draw(scored, seed, { veto: new Set([lowest]) }))).toEqual(ids(wall));
    }
  });

  it('reaches unseen titles below the pool before re-showing the pool, while relevance allows', () => {
    // A gentle gradient: the frontier ratio qualifies about sixty, the extension floor far more.
    const gentle = pool(200).map((item, index) => ({
      ...item,
      explanation: { ...item.explanation, total: 0.9 - index * 0.004 },
    }));
    const base = qualifiedPool(gentle).pool.length;
    const session = new Map<string, number>();
    const seen = new Set<string>();
    let now = NOW;
    let current = new Set<string>();
    for (let press = 1; press <= 6; press += 1) {
      const wall = draw(gentle, press, { now, session, current });
      for (const id of ids(wall)) {
        seen.add(id);
        session.set(id, now);
      }
      current = new Set(ids(wall));
      now += 5 * 60_000;
    }
    // Six walls of twenty: without extension they could only ever cycle the base pool.
    expect(base).toBeLessThan(120);
    expect(seen.size).toBeGreaterThan(base);
    const frontier = strictTop(gentle, 20)[19]!.explanation.total;
    for (const id of seen) {
      expect(gentle.find((item) => item.mediaItemId === id)!.explanation.total).toBeGreaterThanOrEqual(
        frontier * FOR_YOU_SELECTION.extendRatio,
      );
    }
    void HOUR_MS;
  });
});

describe('growing the wall never moves what the reader already scrolled past', () => {
  const HOUR_MS = 3_600_000;
  const linear = () =>
    pool(200).map((item, index) => ({ ...item, explanation: { ...item.explanation, total: 1 - index * 0.005 } }));

  it('keeps every page’s prefix from one page to five on a cold wall', () => {
    // Second review of V2, B1: the pool was sized by pages × pageSize, so page 4 extended it
    // and reshuffled pages 1–3.
    const scored = linear();
    for (let seed = 1; seed <= 25; seed += 1) {
      let previous = draw(scored, seed, { pages: 1 });
      for (let pages = 2; pages <= 5; pages += 1) {
        const grown = draw(scored, seed, { pages });
        expect(ids(grown.slice(0, previous.length))).toEqual(ids(previous));
        previous = grown;
      }
    }
  });

  it('keeps the prefix after Refreshes have drained the pool', () => {
    const scored = linear();
    for (let seed = 1; seed <= 12; seed += 1) {
      const session = new Map<string, number>();
      let now = NOW;
      let current = new Set<string>();
      for (let press = 0; press < 3; press += 1) {
        const wall = draw(scored, seed * 10 + press, { now, session, current });
        for (const id of ids(wall)) session.set(id, now);
        current = new Set(ids(wall));
        now += 5 * 60_000;
      }
      const input = { now, session, current };
      let previous = draw(scored, seed, { ...input, pages: 1 });
      for (let pages = 2; pages <= 5; pages += 1) {
        const grown = draw(scored, seed, { ...input, pages });
        expect(ids(grown.slice(0, previous.length))).toEqual(ids(previous));
        previous = grown;
      }
    }
    void HOUR_MS;
  });

  it('keeps the wall identical when a dismissal lands while the pool is extended', () => {
    const scored = linear();
    const session = new Map<string, number>();
    const wall0 = draw(scored, 1, { now: NOW });
    for (const id of ids(wall0)) session.set(id, NOW);
    const wall1 = draw(scored, 2, { now: NOW + 60_000, session, current: new Set(ids(wall0)) });
    for (const id of ids(wall1)) session.set(id, NOW + 60_000);
    const input = { now: NOW + 120_000, session, current: new Set(ids(wall1)) };
    const wall = draw(scored, 3, input);
    const onWall = new Set(ids(wall));
    const offWall = scored.find((item) => !onWall.has(item.mediaItemId) && !session.has(item.mediaItemId))!;
    expect(ids(draw(scored, 3, { ...input, veto: new Set([offWall.mediaItemId]) }))).toEqual(ids(wall));
  });
});
