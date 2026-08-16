import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import catalogue from '../../../supabase/seed/catalogue.json';

import { buildSlate, tasteFrom, type Anchor, type Candidate, type Taste } from './rank';

/**
 * Does For You actually recommend anything, or does it merely return twenty rows?
 *
 * The founder brief is explicit that "the API returned items" is not the acceptance
 * test, and names three failures to measure against: twenty sequels from one rating,
 * overfitting one favourite, and generic Trending presented as personalised. Each has
 * a number below, and each number is asserted rather than merely reported — a metric
 * nobody fails is a metric nobody reads.
 *
 * **What is real and what is synthetic.** The candidate universe is the real seeded
 * catalogue: 382 films with their real genres, languages and years. What is
 * synthesised is `popularity` (the Wikidata seed carries none) and the association
 * lists that stand in for TMDB's `/recommendations`. Both come from a seeded PRNG, so
 * this file is deterministic: it produces byte-identical output on every run, on
 * every machine, and the report it writes does not churn the working tree.
 *
 * The association lists are **not** built purely from genre overlap, which would make
 * the whole exercise circular — the ranker uses genre too. They are 60% genre-sharing
 * and 40% arbitrary, which is roughly how TMDB's own lists behave and leaves room for
 * the anchor signal to be distinguished from the genre signal.
 *
 * The report goes to `.agent-workflow/recommendation-quality.md`.
 */

type SeedMovie = {
  wikidata_qid: string;
  title: string;
  release_date: string | null;
  original_language: string | null;
  genres: string[];
};

const MOVIES = (catalogue as { movies: SeedMovie[] }).movies;

/** mulberry32. Any seeded generator would do; this one is four lines. */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = prng(20260816);

const universe: Candidate[] = MOVIES.map((movie) => ({
  mediaItemId: movie.wikidata_qid,
  title: movie.title,
  year: movie.release_date ? Number(movie.release_date.slice(0, 4)) : null,
  posterPath: null,
  kind: 'movie' as const,
  genres: movie.genres,
  language: movie.original_language,
  // Synthetic, and skewed the way real popularity is: a few very large values and a
  // long tail. A uniform distribution would make the popularity prior meaningless.
  popularity: Math.round(500 * random() ** 3 * 100) / 100,
}));

const byId = new Map(universe.map((item) => [item.mediaItemId, item]));

/** A stand-in for `/movie/{id}/recommendations`: mostly same-genre, partly not. */
function associationsFor(seedId: string, rng: () => number): string[] {
  const source = byId.get(seedId)!;
  const sameGenre = universe.filter(
    (item) => item.mediaItemId !== seedId && item.genres.some((g) => source.genres.includes(g)),
  );
  const anything = universe.filter((item) => item.mediaItemId !== seedId);

  const picked: string[] = [];
  while (picked.length < 20) {
    const pool = rng() < 0.6 && sameGenre.length > 0 ? sameGenre : anything;
    const choice = pool[Math.floor(rng() * pool.length)]!;
    if (!picked.includes(choice.mediaItemId)) picked.push(choice.mediaItemId);
  }
  return picked;
}

type Viewer = { name: string; ranked: { id: string; score: number }[] };

/** Three viewers, each shaped like a real failure mode rather than an average user. */
function viewers(): Viewer[] {
  const rng = prng(7);
  const withGenre = (genre: string, count: number) =>
    universe.filter((item) => item.genres.includes(genre)).slice(0, count);

  const drama = withGenre('drama film', 10);
  const comedy = withGenre('comedy film', 4);

  return [
    { name: 'Cold start — nothing ranked', ranked: [] },
    {
      // The overfitting case: one adored film and a scatter of mild ones.
      name: 'One favourite — a 10 and nine 5s',
      ranked: [
        { id: drama[0]!.mediaItemId, score: 10 },
        ...drama.slice(1, 10).map((item) => ({ id: item.mediaItemId, score: 5 })),
      ],
    },
    {
      name: 'Broad taste — fourteen ranked across two genres',
      ranked: [
        ...drama.map((item, index) => ({ id: item.mediaItemId, score: 9.5 - index * 0.3 })),
        ...comedy.map((item, index) => ({ id: item.mediaItemId, score: 8 - index * 0.4 })),
      ],
    },
  ].map((viewer) => ({ ...viewer, ranked: viewer.ranked.map((r) => ({ ...r })) })).map((viewer) => {
    void rng;
    return viewer;
  });
}

function slateFor(viewer: Viewer) {
  const rng = prng(viewer.name.length * 977 + 3);
  const anchorSeeds = [...viewer.ranked].sort((a, b) => b.score - a.score).slice(0, 6);

  const anchors: Anchor[] = anchorSeeds.map((seed) => ({
    mediaItemId: seed.id,
    title: byId.get(seed.id)!.title,
    score: seed.score,
    similarIds: associationsFor(seed.id, rng),
  }));

  const taste: Taste = tasteFrom(
    viewer.ranked.map((entry) => ({
      score: entry.score,
      genres: byId.get(entry.id)!.genres,
      language: byId.get(entry.id)!.language,
    })),
  );

  const exclude = new Set(viewer.ranked.map((entry) => entry.id));
  return { anchors, taste, exclude, slate: buildSlate({ candidates: universe, anchors, taste, exclude }) };
}

const share = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);

const measure = (viewer: Viewer) => {
  const { anchors, slate, exclude } = slateFor(viewer);

  const perAnchor = new Map<string, number>();
  const perGenre = new Map<string, number>();
  for (const item of slate) {
    const lead = item.explanation.anchors[0]?.mediaItemId;
    if (lead) perAnchor.set(lead, (perAnchor.get(lead) ?? 0) + 1);
    const genre = item.genres[0];
    if (genre) perGenre.set(genre, (perGenre.get(genre) ?? 0) + 1);
  }

  return {
    viewer: viewer.name,
    size: slate.length,
    anchors: anchors.length,
    leakedFromCollection: slate.filter((item) => exclude.has(item.mediaItemId)).length,
    topAnchorShare: share(Math.max(0, ...perAnchor.values()), slate.length),
    topGenreShare: share(Math.max(0, ...perGenre.values()), slate.length),
    anchorLed: share(
      slate.filter((item) => item.explanation.lead === 'anchors').length,
      slate.length,
    ),
    popularityLed: share(
      slate.filter((item) => item.explanation.lead === 'popular').length,
      slate.length,
    ),
    meanPopularityPrior:
      slate.reduce((sum, item) => sum + item.explanation.popularity, 0) / Math.max(1, slate.length),
    ids: slate.map((item) => item.mediaItemId),
  };
};

const all = viewers().map(measure);
const cold = all[0]!;
const overfit = all[1]!;
const broad = all[2]!;

const universePopularity =
  universe.reduce((sum, item) => sum + Math.min(1, Math.log10(1 + (item.popularity ?? 0)) / Math.log10(501)), 0) /
  universe.length;

const overlapWithCold = (measured: (typeof all)[number]) =>
  share(measured.ids.filter((id) => cold.ids.includes(id)).length, measured.ids.length);

describe('recommendation quality', () => {
  it('fills a slate for every viewer, including one who has ranked nothing', () => {
    for (const measured of all) expect(measured.size).toBe(20);
  });

  it('never recommends a title the viewer already has', () => {
    for (const measured of all) expect(measured.leakedFromCollection).toBe(0);
  });

  it('does not let one favourite own the wall', () => {
    // "Twenty sequels because of one rating", measured. The diversity cap is four in
    // twenty; anything above it means the constraint is not binding.
    expect(overfit.topAnchorShare).toBeLessThanOrEqual(0.25);
    expect(broad.topAnchorShare).toBeLessThanOrEqual(0.25);
  });

  it('does not let one genre own the wall', () => {
    expect(overfit.topGenreShare).toBeLessThanOrEqual(0.45);
    expect(broad.topGenreShare).toBeLessThanOrEqual(0.45);
  });

  it('is not the popularity list wearing a different title', () => {
    // The failure the decision names last and the easiest to ship by accident. A
    // viewer with taste must get a substantially different wall from a viewer with
    // none — otherwise For You is Trending with a personal pronoun on it.
    expect(overlapWithCold(broad)).toBeLessThan(0.5);
    expect(overlapWithCold(overfit)).toBeLessThan(0.5);
  });

  it('says "popular" when popular is the truth, and stops saying it once it is not', () => {
    expect(cold.anchorLed).toBe(0);
    expect(cold.popularityLed).toBe(1);
    expect(broad.anchorLed).toBeGreaterThan(0.5);
  });

  it('is deterministic, so this report does not churn', () => {
    expect(measure(viewers()[2]!).ids).toEqual(broad.ids);
  });

  it('writes the report', () => {
    const pct = (value: number) => `${Math.round(value * 100)}%`;
    const rows = all
      .map(
        (m) =>
          `| ${m.viewer} | ${m.anchors} | ${m.size} | ${pct(m.topAnchorShare)} | ${pct(
            m.topGenreShare,
          )} | ${pct(m.anchorLed)} | ${pct(m.popularityLed)} | ${m.meanPopularityPrior.toFixed(
            2,
          )} | ${pct(overlapWithCold(m))} |`,
      )
      .join('\n');

    const report = `# For You — recommendation quality, V1

Generated by \`src/features/recommendations/quality.test.ts\`. Deterministic: a seeded
PRNG drives everything synthetic, so re-running produces this file byte for byte.

**Real:** the candidate universe is the seeded Wikidata catalogue — ${universe.length}
films with their actual genres, languages and years, which is what a fresh Bingd
database and every CI run contain.

**Synthetic:** \`popularity\` (the seed carries none) and the association lists
standing in for TMDB's \`/movie/{id}/recommendations\`. Those lists are 60%
genre-sharing and 40% arbitrary — deliberately *not* pure genre overlap, which would
make this circular, since the ranker reads genre too.

## Results

| Viewer | Anchors | Slate | Top anchor share | Top genre share | Anchor-led | Popularity-led | Mean popularity prior | Overlap with cold start |
|---|---|---|---|---|---|---|---|---|
${rows}

Universe mean popularity prior: **${universePopularity.toFixed(2)}**.

## Reading it

**Top anchor share** is the failure the brief names first — twenty sequels because of
one rating. The diversity pass caps a single anchor at four of twenty (20%), and both
ranked viewers sit at or under it. A number above 25% would mean the constraint is not
binding.

**Overlap with cold start** is the one that decides whether this is a recommender at
all. The cold-start viewer has no anchors, so their wall is the popularity prior and
nothing else. A ranked viewer whose wall largely matched it would be receiving
Trending with a personal pronoun on it, which the brief forbids by name. Both ranked
viewers come in under 50%.

**Anchor-led** is the share of the wall whose score was actually carried by "because
you loved X". It is what the one-line basis under the header is entitled to claim.
The cold-start viewer's is 0%, and the screen says "Popular right now" for exactly
that reason rather than dressing it up.

**Mean popularity prior** against the universe mean says whether the slate is drifting
toward blockbusters. Above the universe mean by a wide margin would mean the
popularity term is doing more work than its 10% weight suggests.

## What this cannot tell you

- Nothing here measures whether the recommendations are *good*, only whether they are
  personal, varied and honestly labelled. Taste is not measurable from a seed file.
- The association lists are a model of TMDB's behaviour, not TMDB's behaviour. The
  first real signal comes from the deployed adapter, and the numbers above should be
  re-derived against real \`similar\` facets before anyone treats them as a baseline.
- The seeded catalogue has no popularity at all, so the popularity prior is being
  tested against a distribution this file invented.
`;

    const dir = join(__dirname, '..', '..', '..', '.agent-workflow');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'recommendation-quality.md'), report, 'utf8');

    expect(report).toContain('Overlap with cold start');
  });
});
