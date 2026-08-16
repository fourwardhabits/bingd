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

/** No single genre may exceed this share of a slate. */
const MAX_GENRE_SHARE = 0.4;

/** Nor may a single anchor contribute more than this many titles. */
const MAX_PER_ANCHOR = 4;

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
 * Greedy selection under two hard constraints, in score order.
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
 * The cost is a short wall for a viewer whose candidate pool is genuinely narrow. In
 * practice that is rare: the trending fallback supplies twenty candidates with no
 * anchor at all, and a candidate with no lead anchor counts against no anchor's
 * ceiling.
 */
export function diversify(scored: readonly Scored[], limit: number = SLATE_SIZE): Scored[] {
  const byScore = [...scored].sort((a, b) => b.explanation.total - a.explanation.total);

  const perGenre = new Map<string, number>();
  const perAnchor = new Map<string, number>();
  const chosen: Scored[] = [];

  /** One greedy pass. A candidate that would break either ceiling is dropped. */
  const pass = (pool: readonly Scored[], genreCeiling: number, anchorCeiling: number) => {
    for (const candidate of pool) {
      if (chosen.length >= limit) return;

      // The primary genre is TMDB's first, which is the one the provider considers
      // definitive. Counting every genre would make a three-genre film use up three
      // slots' worth of the ceiling and effectively ban broad titles.
      const primary = candidate.genres[0] ?? null;
      const leadAnchor = candidate.explanation.anchors[0]?.mediaItemId ?? null;

      const genreFull = primary != null && (perGenre.get(primary) ?? 0) >= genreCeiling;
      const anchorFull = leadAnchor != null && (perAnchor.get(leadAnchor) ?? 0) >= anchorCeiling;

      if (genreFull || anchorFull) continue;

      if (primary != null) perGenre.set(primary, (perGenre.get(primary) ?? 0) + 1);
      if (leadAnchor != null) perAnchor.set(leadAnchor, (perAnchor.get(leadAnchor) ?? 0) + 1);
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
  //
  // The cost is that a viewer whose candidate pool is genuinely narrow gets a shorter
  // wall. That is the honest outcome and in practice a rare one: the trending
  // fallback contributes twenty candidates with no anchor at all, and a candidate
  // with no lead anchor counts against no anchor's ceiling.
  pass(byScore, Math.max(1, Math.ceil(limit * MAX_GENRE_SHARE)), MAX_PER_ANCHOR);

  return chosen;
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
export function buildSlate({ candidates, anchors, taste, exclude, limit }: SlateInput): Scored[] {
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

  return diversify(
    eligible
      .filter((candidate) => !anchorIds.has(candidate.mediaItemId))
      .map((candidate) => scoreCandidate(candidate, anchors, taste)),
    limit ?? SLATE_SIZE,
  );
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
