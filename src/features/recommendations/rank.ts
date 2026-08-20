/**
 * For You, V1. Deterministic, explainable, and not a language model.
 *
 * Founder decision, 2026-08-16: recommendations are hybrid and explainable, built
 * from canonical Bingd ranking-derived taste signals plus sensible TMDB candidate
 * sources. No LLM is in this path and none is wanted — a model asked to justify a
 * recommendation will justify any recommendation, which is the failure PRD §13 exists
 * to forbid.
 *
 * ---------------------------------------------------------------------------
 * Where this diverges from `docs/architecture/recommendations.md`, and why
 *
 * That document describes `recs-builder`: a scheduled Edge Function that writes
 * slates into `recommendation_generations` with server-composed `evidence`, and it is
 * explicit that "the client has no path to compose a reason of its own, because it is
 * never given the raw candidate pool". This module *is* the candidate pool, on the
 * device. That is a real departure and it is deliberate.
 *
 * The rule exists to stop **fabricated social proof** — "3 people with similar taste
 * loved this" asserted about people who did not. It is enforced server-side because
 * the client cannot be trusted with other users' rankings, and must not have them.
 *
 * V1 therefore uses **no other Bingd user's data**. Every input below is either the
 * viewer's own ranking, or catalogue metadata that is world-readable anyway:
 *
 *   - the viewer's own ranked titles and their derived scores (`rankings`, own-only);
 *   - TMDB's own association between titles (`media_cache` facet `similar`);
 *   - genres, language and popularity from `media_items`.
 *
 * "No other Bingd user's data" and not "no cross-user signal", which is what this said
 * first and is not true: TMDB's recommendations are themselves derived from what their
 * users did, and popularity is a crowd measure. Independent review was right to call
 * it. The distinction that matters is that both are *external, public, about titles
 * rather than about people, and identical for every viewer* — so neither can be
 * attributed to a person, and neither is something one Bingd account learns about
 * another.
 *
 * There is consequently no social claim to fabricate. Every sentence this module can
 * produce is of the form "because of something *you* did", and the structure it is
 * produced from is returned alongside it and is reproducible from the same inputs.
 * The moment a social family is added — `compatible_users` or `followed_users` from
 * that document — it must be built server-side, because at that point the client
 * would need other people's rankings to score it, and that is the thing the rule
 * protects.
 * ---------------------------------------------------------------------------
 */

/** Bumped when a weight or rule below changes, so a slate can be attributed. */
export const CONFIG_VERSION = 'foryou-v1-2026-08-16';

/**
 * A title the viewer ranked highly enough to reason from.
 *
 * Anchors are bounded and few (see `ANCHOR_LIMIT`) because each one costs a provider
 * request the first time it is used. "Use a bounded set of strong taste anchors" is
 * the decision; the alternative — a request per ranked title — is a slate that costs
 * four hundred TMDB calls for a user with four hundred rankings.
 */
export type Anchor = {
  mediaItemId: string;
  title: string;
  /** The viewer's own derived score, 0–10. */
  score: number;
  /** Ordered ids TMDB associates with this title, most relevant first. */
  similarIds: readonly string[];
};

export type Candidate = {
  mediaItemId: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  kind: 'movie' | 'series';
  genres: readonly string[];
  language: string | null;
  popularity: number | null;
};

/** How much the viewer's ranking history leans toward each genre and language. */
export type Taste = {
  /** 0–1, normalised so the strongest affinity is 1. */
  genres: ReadonlyMap<string, number>;
  languages: ReadonlyMap<string, number>;
  /** How many ranked titles it was built from. Below `CONFIDENT_AT` this is thin. */
  sampleSize: number;
};

/** Under this many ranked titles, taste is not yet worth asserting in a sentence. */
export const CONFIDENT_AT = 5;

/** How many anchors a slate reasons from. Each is one provider request, once, ever. */
export const ANCHOR_LIMIT = 6;

/**
 * The weights. They sum to 1, so a score is on 0–1 and two slates are comparable.
 *
 * Anchors dominate because they are the only signal that is about *this title and
 * this viewer* rather than about a category. Popularity is deliberately the smallest:
 * it is a prior that breaks ties between titles nothing else distinguishes, and a
 * larger weight would turn For You into a second Trending shelf — which the decision
 * calls out by name as the thing not to ship.
 */
export const WEIGHTS = {
  anchor: 0.6,
  genre: 0.18,
  language: 0.12,
  popularity: 0.1,
} as const;

/** Roughly the popularity of a global blockbuster on TMDB's scale. The prior
 *  saturates here rather than letting one outlier compress everything else. */
const POPULARITY_CEILING = 500;

/** A slate. Twenty is what `recommendations.md` §2 specifies and the wall shows. */
export const SLATE_SIZE = 20;

/**
 * The three ceilings, and what they are ceilings *on*.
 *
 * All three are absolute counts against the requested limit — at most four titles from
 * one anchor, at most two from one franchise, at most `ceil(limit × 0.4)` from one
 * primary genre — and **not** shares of whatever the wall ends up being. The
 * distinction is not pedantry: the ceilings are hard, so a narrow candidate pool
 * produces a short wall, and four of an eight-item wall is half of it while still
 * being the four the quota allowed.
 *
 * Independent review caught the documentation claiming the share reading while the
 * code enforced the count. The count is the enforceable one — a greedy pass cannot
 * know the final length while it is deciding — so the count is what everything now
 * says, and the three helpers below are exported so a caller can assert on the same
 * numbers the code uses.
 */
const MAX_GENRE_SHARE = 0.4;
const MAX_PER_ANCHOR = 4;
const MAX_PER_FRANCHISE = 2;

/**
 * At most this many slate entries may be attributed to the same anchor — **by any
 * attribution, not merely as lead**.
 *
 * The distinction is the whole of review 08f's open finding. `explanation.anchors`
 * lists every anchor whose association list contains the candidate, sorted by
 * contribution. Counting only `anchors[0]` bounded how often a favourite could be
 * *quoted* and left its total influence over a wall unbounded: a title carried mostly
 * by anchor A but attributed to B first counted against B alone, so one favourite
 * could sit behind twenty rows while appearing to lead four. A quota on how often
 * something is named is not a quota on how much it decides.
 */
export const maxPerAnchor = () => MAX_PER_ANCHOR;

/** At most this many slate entries may share a franchise, per `recommendations.md` §4. */
export const maxPerFranchise = () => MAX_PER_FRANCHISE;

/** At most this many may share a primary genre, for a wall of `limit`. */
export const maxPerGenre = (limit: number = SLATE_SIZE) =>
  Math.max(1, Math.ceil(limit * MAX_GENRE_SHARE));

// ---------------------------------------------------------------------------
// Franchise identity
// ---------------------------------------------------------------------------

/**
 * A named sequel marker with its number: `Part 2`, `Chapter Two`, `Vol. III`.
 *
 * **Named, and that is the whole rule.** A *bare* trailing number is not here and
 * never will be. Two rounds of independent review established why, each with a
 * counterexample the previous rule could not survive:
 *
 *   - stripping any trailing number made `Apollo 11`, `Apollo 13` and `Apollo 18` one
 *     franchise;
 *   - stripping one only when the unnumbered original was also present made `Room`,
 *     `Room 237` and `Room 203` one franchise, because an unrelated film supplied the
 *     stem by coincidence.
 *
 * A bare number is a sequel index in `Iron Man 2` and part of the name in `Apollo 13`,
 * and no rule reading titles alone can tell them apart — the second attempt reduced
 * the false positives without eliminating them, and a franchise ceiling that drops an
 * unrelated film is worse than one that misses a franchise. So `Iron Man 2` is a
 * documented **miss**. A named marker is not infallible either — see the leading-stem
 * collision under `franchiseKey` — but it means one thing wherever it appears, which a
 * bare number does not.
 *
 * The number itself is permissive — digits, roman numerals or a word — because after
 * `Part` or `Chapter` there is nothing else it could be.
 */
const NUMBERED_PART = /\s(?:part|chapter|volume|vol|episode)\s+(?:\d+|[ivx]+|one|two|three|four|five|six|seven|eight|nine|ten)$/;

/**
 * A franchise key derived from one title, or `null` when there is nothing to group on.
 *
 * **This is a proxy, and naming what it is not matters more than what it is.** The
 * real franchise identity is TMDB's `belongs_to_collection`, and V1 cannot have it:
 * that field appears only on a title's *detail* response, so keying on it would mean
 * one provider request per candidate — several hundred per slate — against an
 * architecture that deliberately bounds provider requests to six anchors. Storing it
 * would mean a column that is null for every catalogue row until something re-enriches
 * it, which is a cap that does not fire dressed as a cap that does.
 *
 * The key is the leading stem: everything before a subtitle separator, minus a leading
 * article, minus a named sequel marker.
 *
 *   Spider-Man: No Way Home   →  spider man
 *   Spider-Man: Far From Home →  spider man
 *   The Godfather Part II     →  godfather
 *   It Chapter Two            →  it
 *   Apollo 13                 →  apollo 13   (a bare number is part of the name)
 *
 * ### What it misses
 *
 *   - a numbered sequel — `Iron Man 2`, `Terminator 2` — for the reason above;
 *   - a shared universe under different names (Iron Man / Thor / Black Panther);
 *   - a renamed entry (The Dark Knight, in TMDB's Batman collection);
 *   - a reboot with a distinct title (Fast Five, in the Fast & Furious collection).
 *
 * All four are **under**-grouping: a franchise slips past the ceiling. That is the
 * direction to fail in, because over-grouping drops a real recommendation to protect
 * against a franchise the code invented, and the person never learns why.
 *
 * ### The one way it can over-group, stated rather than denied
 *
 * Two unrelated films whose **leading stems** are identical get one key. That covers
 * two films with the same title — `Heat` (1995) and `Heat` (2022) — and the weaker
 * case where one film's whole title is the part of another's that precedes its
 * subtitle. "Leading stem" and not "same name", because the second case is not the
 * same name and the subtitle split is what makes it collide.
 *
 * Nothing short of the provider's collection id separates either. The ceiling is two
 * of twenty, so this costs a row only when three or more collide. It is held as a test
 * so that it stays a known cost rather than becoming a surprise.
 */
export function franchiseKey(title: string): string | null {
  // Everything before the first subtitle separator: a colon, a dash with spaces
  // around it, or an em/en dash. `Spider-Man` keeps its hyphen because it has no
  // spaces around it, which is what distinguishes a compound name from a subtitle.
  const lead = title.split(/:|\s[-–—]\s|[–—]/)[0] ?? title;

  const stem = lead
    .normalize('NFKD')
    // Combining marks, so `Amelie` spelled either way is one franchise, not two.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an)\s+/, '');

  // `Part II` loses the whole marker. Losing only the `II` would leave `part` behind
  // to group every numbered sequel in the catalogue under one franchise.
  const key = stem.replace(NUMBERED_PART, '').trim();

  // A one-character stem is not an identity — it is a title the rules ate.
  return key.length >= 2 ? key : null;
}

// ---------------------------------------------------------------------------
// Taste
// ---------------------------------------------------------------------------

export type RankedSignal = {
  /** 0–10, the viewer's own derived score. */
  score: number;
  genres: readonly string[];
  language: string | null;
};

/**
 * Genre and language affinity from the viewer's own rankings.
 *
 * Weighted by score, so a film they loved says more about them than one they merely
 * finished — and normalised by the strongest signal, so the numbers mean "relative to
 * your own taste" rather than "relative to how much you have ranked". A user with
 * forty rankings and a user with six both get affinities on 0–1.
 *
 * Nothing is subtracted. A low-scored title contributes a *small* positive weight to
 * its genres rather than a negative one: with a handful of rankings, negative
 * affinity is one bad night out from excluding a genre entirely, and the recovery
 * from that is invisible to the user.
 */
export function tasteFrom(ranked: readonly RankedSignal[]): Taste {
  const genres = new Map<string, number>();
  const languages = new Map<string, number>();

  for (const entry of ranked) {
    // 0.1–1.0. Never zero: a title the viewer bothered to rank is evidence about
    // them even when the verdict was low.
    const weight = Math.max(0.1, Math.min(1, entry.score / 10));
    for (const genre of entry.genres) {
      genres.set(genre, (genres.get(genre) ?? 0) + weight);
    }
    if (entry.language) {
      languages.set(entry.language, (languages.get(entry.language) ?? 0) + weight);
    }
  }

  return {
    genres: normalise(genres),
    languages: normalise(languages),
    sampleSize: ranked.length,
  };
}

function normalise(counts: Map<string, number>): Map<string, number> {
  const max = Math.max(0, ...counts.values());
  if (max === 0) return new Map();
  return new Map([...counts].map(([key, value]) => [key, value / max]));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type AnchorHit = {
  mediaItemId: string;
  title: string;
  /** 1-based place in that anchor's similar list — "the 3rd thing TMDB associates". */
  position: number;
  contribution: number;
};

export type Explanation = {
  /** 0–1. */
  total: number;
  anchors: AnchorHit[];
  genre: { genre: string; affinity: number } | null;
  language: { code: string; affinity: number } | null;
  /** 0–1, the bounded popularity prior. */
  popularity: number;
  /** Which signal actually carried it. Drives the sentence and the debug view. */
  lead: 'anchors' | 'genre' | 'language' | 'popular';
};

export type Scored = Candidate & { explanation: Explanation };

/** Decay down an anchor's similar list. The fourth suggestion is worth half the first. */
const positionWeight = (index: number) => 1 / (1 + index / 4);

/**
 * One candidate against one viewer.
 *
 * The anchor term saturates rather than summing without bound: `x / (1 + x)` maps any
 * amount of agreement into 0–1, so a title that appears in six anchors' lists scores
 * above one that appears in two without being six times better. Unbounded sums are
 * how a recommender ends up with twenty titles from one franchise — the decision's
 * "twenty sequels because of one rating" failure, arrived at by arithmetic rather
 * than by intent.
 */
export function scoreCandidate(candidate: Candidate, anchors: readonly Anchor[], taste: Taste): Scored {
  const hits: AnchorHit[] = [];

  for (const anchor of anchors) {
    const index = anchor.similarIds.indexOf(candidate.mediaItemId);
    if (index < 0) continue;
    const contribution = (anchor.score / 10) * positionWeight(index);
    hits.push({
      mediaItemId: anchor.mediaItemId,
      title: anchor.title,
      position: index + 1,
      contribution,
    });
  }

  hits.sort((a, b) => b.contribution - a.contribution);

  const raw = hits.reduce((total, hit) => total + hit.contribution, 0);
  // Breadth over depth: two anchors agreeing is a stronger claim than one anchor
  // ranking it first, so distinct anchors add a little beyond their own weight.
  const breadth = 1 + 0.25 * Math.min(3, Math.max(0, hits.length - 1));
  const anchorSignal = saturate(raw * breadth);

  // The strongest genre match, not the average across the candidate's labels. A film
  // is recommended for what it is; averaging punishes a horror comedy for being
  // partly a comedy, which is not a judgement anybody made.
  let genre: Explanation['genre'] = null;
  for (const name of candidate.genres) {
    const affinity = taste.genres.get(name) ?? 0;
    if (affinity > (genre?.affinity ?? 0)) genre = { genre: name, affinity };
  }

  const languageAffinity = candidate.language ? (taste.languages.get(candidate.language) ?? 0) : 0;
  const language = candidate.language && languageAffinity > 0
    ? { code: candidate.language, affinity: languageAffinity }
    : null;

  const popularity = popularityPrior(candidate.popularity);

  const total =
    WEIGHTS.anchor * anchorSignal +
    WEIGHTS.genre * (genre?.affinity ?? 0) +
    WEIGHTS.language * languageAffinity +
    WEIGHTS.popularity * popularity;

  return {
    ...candidate,
    explanation: {
      total,
      anchors: hits,
      genre,
      language,
      popularity,
      lead: leadOf({
        anchor: WEIGHTS.anchor * anchorSignal,
        genre: WEIGHTS.genre * (genre?.affinity ?? 0),
        language: WEIGHTS.language * languageAffinity,
        popularity: WEIGHTS.popularity * popularity,
      }),
    },
  };
}

const saturate = (value: number) => value / (1 + value);

function popularityPrior(popularity: number | null): number {
  if (!popularity || popularity <= 0) return 0;
  return Math.min(1, Math.log10(1 + popularity) / Math.log10(1 + POPULARITY_CEILING));
}

/**
 * Which term contributed most, after weighting.
 *
 * This is what the sentence is allowed to say. Deriving it from the weighted terms
 * rather than choosing it by hand is what keeps the explanation honest: a title whose
 * score came from popularity cannot be described as "because you loved X", because
 * the arithmetic says otherwise.
 */
function leadOf(terms: {
  anchor: number;
  genre: number;
  language: number;
  popularity: number;
}): Explanation['lead'] {
  const ordered: [Explanation['lead'], number][] = [
    ['anchors', terms.anchor],
    ['genre', terms.genre],
    ['language', terms.language],
    ['popular', terms.popularity],
  ];
  ordered.sort((a, b) => b[1] - a[1]);
  const [lead, value] = ordered[0]!;
  // Everything at zero — no anchors, no taste, no popularity — is the cold-start
  // case, and calling it 'popular' is at least true of the source it came from.
  return value > 0 ? lead : 'popular';
}

// ---------------------------------------------------------------------------
// Diversity
// ---------------------------------------------------------------------------

/**
 * Greedy selection under three hard constraints, in score order.
 *
 * Greedy rather than an optimiser, for the reason `recommendations.md` §4 gives: when
 * a slate looks wrong you can replay the selection and see which constraint rejected
 * which title, which is not true of a solver.
 *
 * **A rejected title is dropped, and the slate may come back short.** That is the
 * whole of it, and it took three passes to get back to. The version before this one
 * readmitted rejected titles under relaxed ceilings and then under none at all, so
 * that the wall was always full — and the effect was that "no anchor above 20% of the
 * wall" was a claim the code could break and the tests happened not to catch. A cap
 * that yields when it is inconvenient is not a cap.
 *
 * ### The three ceilings, and which failure each one is for
 *
 * | Ceiling | The wall it prevents |
 * |---|---|
 * | Anchor, over **every** attribution | one favourite deciding the wall |
 * | Franchise | one series' sequels filling the wall |
 * | Primary genre | one genre filling the wall |
 *
 * The anchor ceiling counts a candidate against every anchor in `explanation.anchors`,
 * not against `anchors[0]` alone. Review 08f's open finding was that the lead-only
 * count bounded how often a favourite could be *named* and left its total influence
 * unbounded — a title carried mostly by A but attributed to B first spent B's quota
 * and none of A's. So a candidate that two anchors both point at spends a slot of
 * each, and the guarantee is the one the founder decision actually asks for: **no
 * single ranked title lies behind more than four of the twenty, by any route this
 * module can see.**
 *
 * That is strictly stronger and it is not free. A candidate whose second anchor is
 * full is dropped even though its lead has room, so a wall built from six anchors that
 * all point at the same titles is shorter than one built from six that disagree.
 * Which is the right shape: agreement between anchors is exactly the overfitting the
 * cap is for, and a short honest wall beats twenty rows of one taste reflected back.
 *
 * The franchise ceiling is `recommendations.md` §4's "≤ 2 per 20", implemented against
 * the title-derived proxy `franchiseKey` documents. Two, not zero: the decision says
 * to avoid a wall of sequels, not to ban the sequel of a film somebody loved, and a
 * viewer who adored the first two Dune films should still be shown the third.
 *
 * The cost throughout is a short wall for a viewer whose candidate pool is genuinely
 * narrow. In practice that is rare: the trending fallback supplies twenty candidates
 * with no anchor at all, and a candidate no anchor points at spends no anchor's quota.
 */
export function diversify(
  scored: readonly Scored[],
  limit: number = SLATE_SIZE,
  /** See {@link explore}. Zero — the default — is the old strict score order. */
  seed: number = 0,
): Scored[] {
  const byScore =
    seed === 0
      ? [...scored].sort((a, b) => b.explanation.total - a.explanation.total)
      : explore(scored, limit, seed);

  const perGenre = new Map<string, number>();
  const perAnchor = new Map<string, number>();
  const perFranchise = new Map<string, number>();
  const chosen: Scored[] = [];

  const atCeiling = (counts: Map<string, number>, key: string, ceiling: number) =>
    (counts.get(key) ?? 0) >= ceiling;
  const spend = (counts: Map<string, number>, key: string) =>
    counts.set(key, (counts.get(key) ?? 0) + 1);

  /** One greedy pass. A candidate that would break any ceiling is dropped. */
  const pass = (
    pool: readonly Scored[],
    genreCeiling: number,
    anchorCeiling: number,
    franchiseCeiling: number,
  ) => {
    for (const candidate of pool) {
      if (chosen.length >= limit) return;

      // The primary genre is TMDB's first, which is the one the provider considers
      // definitive. Counting every genre would make a three-genre film use up three
      // slots' worth of the ceiling and effectively ban broad titles.
      const primary = candidate.genres[0] ?? null;
      const franchise = franchiseKey(candidate.title);
      // Every anchor that points at this title, not merely the loudest one.
      const attributed = candidate.explanation.anchors.map((hit) => hit.mediaItemId);

      if (primary != null && atCeiling(perGenre, primary, genreCeiling)) continue;
      if (franchise != null && atCeiling(perFranchise, franchise, franchiseCeiling)) continue;
      if (attributed.some((id) => atCeiling(perAnchor, id, anchorCeiling))) continue;

      if (primary != null) spend(perGenre, primary);
      if (franchise != null) spend(perFranchise, franchise);
      for (const id of attributed) spend(perAnchor, id);
      chosen.push(candidate);
    }
  };

  // One pass, and the ceilings are hard.
  //
  // There were three: strict, then relaxed by half, then unrestricted to fill any
  // shortfall. Independent review killed it, correctly. A relaxed ceiling of six per
  // anchor on a wall of twenty is thirty per cent, and the documentation, the report
  // and the tests all said twenty — the synthetic fixtures simply never reached the
  // boundary, so the assertions passed while production could violate them. A cap
  // that yields when it is inconvenient is not a cap, and a claim the code can break
  // is worse than a weaker claim it cannot.
  pass(byScore, maxPerGenre(limit), maxPerAnchor(), maxPerFranchise());

  return chosen;
}

// ---------------------------------------------------------------------------
// Freshness: the same relevance, presented differently
// ---------------------------------------------------------------------------

/**
 * How many candidates deep the exploration pool goes, as a multiple of the wall.
 *
 * Three, so a wall of twenty is *sampled* from the best sixty.
 *
 * **This bound is where the relevance guarantee lives, and independent review 29 found
 * the guarantee had been written one word too strong.** It said nothing outside the pool
 * could be drawn. What is true is narrower and is the thing that actually matters:
 * **sampling cannot promote a title from outside the pool.** The greedy pass in
 * {@link diversify} still walks the tail in strict score order afterwards, so a
 * sufficiently constrained wall — one where the genre, franchise and anchor ceilings
 * reject most of the top sixty — can reach position 61 and beyond.
 *
 * That is not a freshness defect: **`diversify` has always been one greedy pass over
 * every scored candidate**, the ceilings are hard, and when they reject the head the
 * wall has always been filled from further down. Reaching the tail is a property of the
 * candidates and the caps, not of the seed.
 *
 * **What seeding does change is which titles get chosen, and how many**, which took
 * three review rounds to state correctly. The ceilings intersect and are spent in the
 * order they are met, so a different arrangement of the pool leaves different quota for
 * everything behind it.
 *
 * **There is exactly one guarantee, and it is the ordering one:**
 *
 *   > No draw promotes a title from outside the pool. Every pool member precedes every
 *   > tail member, for every seed.
 *
 * **Three** things that were claimed here and are **false**, each found by its own round:
 *
 *   - *the same titles are chosen* — 29b. Order spends the quotas, so the set moves.
 *   - *the wall never gets shorter* — 29c, with a counterexample this file now carries
 *     as a test: six candidates over two genres and two franchises at `limit: 5` give a
 *     wall of four in strict order and **three** under seed 76.
 *   - *the tail is reached under identical conditions* — 29c. Which pool members are
 *     rejected depends on the order they are met in, so how far down the wall has to
 *     reach depends on it too.
 *
 * The shortening is a real cost and is accepted rather than papered over. **It needs the
 * ceilings to be near-binding, not a pool that cannot fill the wall** — 29d disproved
 * that weaker excuse with a seven-candidate set that *does* fill a wall of five in
 * strict order and returns four under seed 76, in about 2% of seeds. That case is a
 * test too.
 *
 * What can be said, and is asserted rather than asserted-about: **on the five pool shapes
 * the suite tests, the length does not move.** `rank.test.ts` runs 60 and 200 candidates
 * over eighteen genres, a five-genre wall, a franchise-heavy wall, and 25 candidates for
 * a wall of 20, across 200 seeds each, and the wall is twenty every time. Five fixtures
 * are five fixtures rather than a proof about every pool, which is the strength 29e
 * asked for; the measurement lives in the suite at all because 29d could not reproduce
 * it from prose.
 *
 * Topping the wall back up would mean relaxing a ceiling, and a previous round killed
 * exactly that: a cap that yields when it is inconvenient is not a cap. Truncating the
 * input to the pool was also considered and rejected — it shortens the wall *more*, and
 * unconditionally.
 *
 * All four propositions are asserted in `rank.test.ts`, `what the exploration pool
 * bounds` — **including the two that are false**, so no later round can restore them. A
 * claim about relevance that no test exercises is how this came to be overstated twice.
 */
const FRESHNESS_POOL_MULTIPLE = 3;

/**
 * How hard the sampling pushes, as a fraction of the pool's own score spread.
 *
 * Relative rather than absolute, because a slate's scores are 0–1 but a real pool
 * occupies a small band inside that — an anchored wall runs about 0.33 down to 0.02, a
 * popularity-only one about 0.11 down to 0.07. A fixed jitter would be a total reshuffle
 * of the second and invisible on the first.
 *
 * **0.12 was measured against the real scorer rather than chosen.** Across 3,000 seeds
 * on a sixty-candidate pool, by how many anchors the reader has.
 *
 * **This table is a one-off calibration run and the suite does not reproduce it** —
 * review 29e was right to say so, and it is recorded here as the reason for the number
 * rather than as a maintained result. What the suite *does* hold, over 300 seeds in
 * `still leads with the best title when there genuinely is a best title`, are exactly
 * two bounds: the single best candidate leads **more than a third** of visits
 * (`> 100/300`), and a title from outside the top ten leads **less than a tenth**
 * (`< 30/300`). Those are the literal assertions — 29f caught this note saying "well
 * over" and "well under", which the numbers do not support — and they are deliberately
 * loose so a scorer tweak reports rather than flakes. The "roughly six hundred distinct
 * top-sixes" figure below is from the calibration run alone and nothing reproduces it.
 * Re-run the calibration before changing the constant; do not trust the table to have
 * aged.
 *
 * | temp | 1 anchor: lead in top 10 | 3 anchors | 6 anchors | lead outside top 20 | distinct top sixes |
 * |---|---|---|---|---|---|
 * | 0.10 | 100% | 98% | 82% | 0% | 307 |
 * | **0.12** | **99%** | **95%** | **78%** | **≤1%** | **604** |
 * | 0.15 | 96% | 92% | 73% | 3% | 1,209 |
 * | 0.20 | 86% | 85% | 67% | 11% | 2,299 |
 *
 * 0.25 was the first draft, measured against a hand-built pool with a steeper head than
 * this scorer produces, and it was far too hot — at 0.20 a title the reader's own
 * favourites point at is already buried outside the top twenty on a tenth of visits.
 * At 0.12 that is at most one visit in a hundred, and six hundred distinct top-sixes is
 * more variety than anybody refreshing a few times a session can exhaust.
 *
 * The founder's constraint is the binding one here: relevance stays primary, and
 * novelty does not get to cost it. Where the two traded off, this took relevance.
 *
 * On a **popularity-only** pool the same setting behaves close to uniform sampling
 * inside the pool, and that is correct rather than a defect: those scores differ by a
 * few thousandths, so no title is distinctly the best one and the honest answer is that
 * any of the sixty most popular could lead. Sampling proportional to score gives exactly
 * that — a clear favourite usually wins, and where there is no clear favourite there is
 * no favourite to protect.
 */
const FRESHNESS_TEMPERATURE = 0.12;

/**
 * A stable number in (0, 1) from a seed and an id.
 *
 * Deterministic on purpose: the same seed and the same candidate always give the same
 * draw, which is what makes a visit *stable*. A `Math.random()` per render would reshuffle
 * the wall on every re-render — the exact thing the brief forbids — and would be
 * untestable besides.
 *
 * FNV-1a with an avalanche finaliser. Not a security hash and nothing here needs one;
 * the finaliser is there because raw FNV leaves ids differing by one character sorted
 * next to each other, which would make the "reordering" a rotation of the same list.
 */
function unitRandom(seed: number, key: string): number {
  let hash = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  // Strictly inside the open interval: the Gumbel transform below is undefined at both
  // ends, and `hash >>> 0` can be exactly 0.
  return ((hash >>> 0) + 0.5) / 0x100000000;
}

/**
 * Score order, softened — the ordering an explicit Refresh produces.
 *
 * The founder's report was that For You showed essentially the same titles every visit,
 * and the audit agreed: `buildSlate` is a pure function of rankings and the provider
 * cache, so with neither changing it returned the same twenty in the same order for as
 * long as the account existed. Nothing was stale; there was simply only ever one answer.
 *
 * This is the standard re-ranking answer to that, and it is deliberately the *smallest*
 * one: **perturbed top-k over a bounded pool**, sometimes called Gumbel top-k, which is
 * weighted sampling without replacement expressed as a sort. Adding a Gumbel draw to a
 * score and taking the best is equivalent to sampling proportionally to the exponential
 * of that score — so a stronger title is genuinely more likely to lead, rather than
 * every title being equally likely as a shuffle would have it.
 *
 * Three properties, and each is one of the founder's constraints:
 *
 *   **Relevance stays primary.** Sampling happens only inside the top
 *   {@link FRESHNESS_POOL_MULTIPLE}× `limit` by score, so **no draw can promote a title
 *   from below the pool**. Everything below it keeps its strict score order and stays
 *   behind every pool title. That is the guarantee — and it is *not* a promise that the
 *   same titles are chosen, because the ceilings are spent in the order they are met.
 *   See {@link FRESHNESS_POOL_MULTIPLE} for what this bound does and does not promise.
 *
 *   **A visit is stable.** The seed is fixed for the session, so the same slate and the
 *   same seed give the same wall — on a re-render, after a bookmark, after a navigation.
 *   Only a new seed moves it.
 *
 *   **Refresh is not a shuffle.** Scores still decide; the draw only says how much a
 *   near-tie is allowed to matter.
 *
 * The three hard ceilings in {@link diversify} run over this order unchanged, so a
 * refreshed wall obeys the franchise, genre and anchor caps exactly as the strict one
 * does — the ordering is what varies, never the constraints.
 */
function explore(scored: readonly Scored[], limit: number, seed: number): Scored[] {
  const byScore = [...scored].sort((a, b) => b.explanation.total - a.explanation.total);

  const poolSize = Math.min(byScore.length, Math.max(limit, limit * FRESHNESS_POOL_MULTIPLE));
  const pool = byScore.slice(0, poolSize);
  const tail = byScore.slice(poolSize);

  const best = pool[0]?.explanation.total ?? 0;
  const worst = pool[pool.length - 1]?.explanation.total ?? 0;
  const spread = best - worst;
  // Every candidate scored identically — a popularity-only wall where nothing is
  // popular, say. There is no near-tie to break, so leave the order alone rather than
  // manufacturing one out of the hash.
  if (spread <= 0) return byScore;

  const shuffled = pool
    .map((candidate) => {
      const uniform = unitRandom(seed, candidate.mediaItemId);
      // The Gumbel transform. Unbounded in principle, which is what lets an outsider
      // occasionally lead; bounded in practice by the pool it is drawn from.
      const gumbel = -Math.log(-Math.log(uniform));
      return { candidate, key: candidate.explanation.total + FRESHNESS_TEMPERATURE * spread * gumbel };
    })
    .sort((a, b) => b.key - a.key)
    .map((entry) => entry.candidate);

  return [...shuffled, ...tail];
}

// ---------------------------------------------------------------------------
// The whole pipeline
// ---------------------------------------------------------------------------

export type SlateInput = {
  candidates: readonly Candidate[];
  anchors: readonly Anchor[];
  taste: Taste;
  /** Everything already in the viewer's collection. Excluded outright. */
  exclude: ReadonlySet<string>;
  limit?: number;
};

/**
 * Eligibility, then scoring, then diversity — in that order, on purpose.
 *
 * Eligibility first is the ordering `recommendations.md` §2 insists on: a title that
 * can never be shown must not survive by scoring highly. Here that means the
 * viewer's own collection, which the decision says is excluded by default —
 * recommending someone a film they logged last week is the single fastest way to
 * make a slate look broken.
 *
 * A watchlisted title is *not* excluded. The decision is explicit that those stay and
 * are marked Saved: wanting to see something is not having seen it, and a wall that
 * hid everything you saved would quietly punish saving.
 */
export function buildSlate({
  candidates,
  anchors,
  taste,
  exclude,
  limit,
  seed,
}: SlateInput & { seed?: number }): Scored[] {
  return diversify(scoreSlate({ candidates, anchors, taste, exclude }), limit ?? SLATE_SIZE, seed);
}

/**
 * Eligibility and scoring, stopping short of diversity.
 *
 * The two halves are split because they answer to different clocks. Everything here is
 * a function of the catalogue and the viewer's rankings, so it is what the query caches;
 * {@link diversify} is presentation, and For You re-runs it whenever the reader asks for
 * a fresh arrangement. Keeping them in one function meant a Refresh had to refetch the
 * candidates to reorder them, which is a network round trip to shuffle a list that was
 * already in memory.
 *
 * {@link buildSlate} remains the whole pipeline for every caller that wants one answer —
 * the quality report, and the tests that assert on the ceilings.
 */
export function scoreSlate({ candidates, anchors, taste, exclude }: SlateInput): Scored[] {
  const seen = new Set<string>();
  const eligible: Candidate[] = [];

  for (const candidate of candidates) {
    if (exclude.has(candidate.mediaItemId)) continue;
    // A candidate can arrive from several anchors and from the popularity fallback
    // at once. Scoring it twice would put the same poster on the wall twice.
    if (seen.has(candidate.mediaItemId)) continue;
    seen.add(candidate.mediaItemId);
    eligible.push(candidate);
  }

  // An anchor must never be recommended back to the person it came from. It is in
  // their collection, so `exclude` catches it — this is the second lock on a door
  // whose failure would be the most obviously stupid thing the feature could do.
  const anchorIds = new Set(anchors.map((anchor) => anchor.mediaItemId));

  return eligible
    .filter((candidate) => !anchorIds.has(candidate.mediaItemId))
    .map((candidate) => scoreCandidate(candidate, anchors, taste));
}

// ---------------------------------------------------------------------------
// Saying why
// ---------------------------------------------------------------------------

/**
 * The sentence, derived from the structure rather than chosen alongside it.
 *
 * `lead` is whichever weighted term actually carried the score, so this cannot claim
 * "because you loved X" about a title that scored on popularity. Where the leading
 * signal has nothing quotable — a genre the viewer has barely ranked, a taste built
 * from two films — it falls back to the honest weaker claim rather than dressing the
 * title up. `recommendations.md` §5: a curated or content reason is never dressed as
 * social, and the same discipline applies one level down.
 */
export function headlineFor(
  explanation: Explanation,
  taste: Taste,
  languageLabel: (code: string) => string,
): string {
  if (explanation.lead === 'anchors' && explanation.anchors.length > 0) {
    const [first, second] = explanation.anchors;
    if (second && explanation.anchors.length >= 2) {
      return `Because you loved ${first!.title} and ${second.title}`;
    }
    return `Because you loved ${first!.title}`;
  }

  if (explanation.lead === 'genre' && explanation.genre && taste.sampleSize >= CONFIDENT_AT) {
    return `More ${explanation.genre.genre.toLowerCase()}, which you rank highly`;
  }

  if (explanation.lead === 'language' && explanation.language && taste.sampleSize >= CONFIDENT_AT) {
    return `More from ${languageLabel(explanation.language.code)}`;
  }

  // Named for what it is. "Recommended for you" over a popularity ranking is exactly
  // the unfalsifiable label PRD §13 forbids.
  return 'Popular right now';
}
