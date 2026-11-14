import { BAND_RANGE, type Bucket } from '@/features/collection/score';

/**
 * The reader's behavioural preferences, for Engine V2 (founder spec 2026-11-10, A1).
 *
 * Everything here is inferred from the reader's **own** history — rankings, buckets and
 * plain logs — and nothing is asked. There is no language setting and no onboarding
 * question, by decision; a profile is what the reader did.
 *
 * ---------------------------------------------------------------------------
 * WHAT V1 GOT WRONG, AND WHY THE SHAPE BELOW
 *
 * `tasteFrom` (rank.ts) sums `max(0.1, score/10)` per facet and divides by the largest.
 * Three consequences, each of which this module exists to remove:
 *
 *   1. **Volume decides, so the majority language owns the scale.** Forty English films
 *      and four Japanese ones the reader loved more give Japanese 0.1 of English's
 *      affinity. Because TMDB and the catalogue skew English, almost everybody's majority
 *      is English, and every other language reads as noise. Here interest is a
 *      *saturating* function of evidence: four strong titles in a language are enough to
 *      say the reader is interested in it, whatever else they watch, so several languages
 *      can be high at once.
 *   2. **Every ranking is positive.** A disliked title adds a little to its genre. Here a
 *      title carries a valence from its band, so Not-for-me evidence pulls a facet *below*
 *      neutral — bounded, never to an exclusion.
 *   3. **Only rankings count.** A title logged and never ranked said nothing. Here it is
 *      interest at lower confidence and no opinion.
 *
 * And one thing V1 never had: **era**, split by medium, as preference *relative to
 * exposure*. Everybody watches mostly recent titles, so a decade's share of a history is
 * exposure, not taste. Era affinity moves only when a decade is liked at a different rate
 * from the reader's own average, and is neutral otherwise — so a classic is never pushed
 * down for being old, and a reader who loves the 1970s more than they love anything else
 * gets the 1970s.
 *
 * ---------------------------------------------------------------------------
 * EVIDENCE PER TITLE
 *
 * | What the reader did | Confidence | Valence (−1…+1) |
 * |---|---|---|
 * | Ranked | 1 | `(score − 5) / 5` from the 0–10 score |
 * | Bucketed, not ranked (imports) | {@link BUCKETED_CONFIDENCE} | the band's midpoint, same mapping |
 * | Logged only | {@link LOGGED_CONFIDENCE} | none — interest without opinion |
 *
 * The valences come from `BAND_RANGE`, not from a table here, so a band edit moves them
 * with it: a midpoint 8.5 Liked is +0.7, a 5.2 Fine is about 0, a 1.7 Not-for-me −0.66.
 */

export type ProfileEntry = {
  mediaItemId: string;
  /** The reader's 0–10 score when ranked; null when only logged or bucketed. */
  score: number | null;
  bucket: Bucket | null;
  language: string | null;
  year: number | null;
  /** Movies and TV are profiled separately for era. A season counts as TV. */
  kind: 'movie' | 'series' | 'season';
  genres: readonly string[];
  /**
   * The share of one unit of evidence this observation carries (default 1). **Each series is
   * one unit of taste** (WS5, 2026-11-14): the ranked seasons and the whole-show ranking of
   * one series divide one unit between them (`seriesUnitWeights`, `anchors.ts`), exactly as
   * V1's `tasteFrom` weighs them, so a show ranked whole and its seasons are not counted
   * twice and a long show cannot outvote everything else. Scales the title's confidence.
   */
  weight?: number;
};

type FacetStats = {
  /** Σ confidence over every title carrying the facet: interest. */
  exposure: number;
  /** Σ confidence over titles with an opinion: the denominator of the mean. */
  opinion: number;
  /** Σ confidence × valence over titles with an opinion. */
  valence: number;
  /** Titles carrying it, for explanations and tests. */
  titles: number;
};

export type FacetAffinity = {
  /** 0–1. {@link NEUTRAL} for a facet with no evidence. */
  affinity: number;
  /** 0–1: how much evidence stands behind it, before opinion. */
  interest: number;
  /** −1…+1, shrunk toward the reader's own mean. */
  mean: number;
  titles: number;
};

export type Profile = {
  languages: ReadonlyMap<string, FacetAffinity>;
  genres: ReadonlyMap<string, FacetAffinity>;
  /** Decade (1970, 1980, …) → affinity, per medium. */
  eras: { movie: ReadonlyMap<number, FacetAffinity>; series: ReadonlyMap<number, FacetAffinity> };
  /** The reader's mean valence over every title they have an opinion on. */
  mean: number;
  /** Ranked titles, the same count `Taste.sampleSize` carries. */
  sampleSize: number;
  /** Titles with any evidence at all, ranked or not. */
  evidenceCount: number;
};

/** A bucketed import is an opinion without the comparisons that place it. */
export const BUCKETED_CONFIDENCE = 0.6;

/**
 * A title the reader logged and never ranked or bucketed.
 *
 * About a third of a ranking: watching something is a real statement of interest in its
 * language, genre and era, and no statement at all about whether they liked it.
 */
export const LOGGED_CONFIDENCE = 0.35;

/**
 * The affinity of a facet nobody has evidence about, by kind.
 *
 * Language and genre: 0.3, below the 0.5 a facet with plain "fine" evidence reaches, so
 * evidence of interest lifts a facet and evidence of dislike sinks it, and a language the
 * reader has never touched sits between the two. It is not zero, so a title in an unknown
 * language is never scored as though the reader had rejected it — discovery outside the
 * known languages stays possible.
 *
 * Era: 0.5 exactly, because era moves only on *relative* preference (see the header).
 */
export const NEUTRAL = { language: 0.3, genre: 0.3, era: 0.5 } as const;

/**
 * Titles of evidence at which interest reaches 1 − 1/e (63%).
 *
 * Three for a language or genre: four liked Japanese films put Japanese at 74% interest,
 * which is the "a few strong titles are enough" property; ten put it at 96%. Four for a
 * decade, which is narrower evidence (one director's run fills a decade quickly).
 */
const SATURATION = { language: 3, genre: 3, era: 4 } as const;

/** Pseudo-titles at the reader's own mean that every facet mean is shrunk toward. */
const PRIOR_TITLES = 2;

/** How much an adjacent decade lends to its neighbour. Era evidence is sparse. */
const ERA_NEIGHBOUR = 0.5;

/** A decade liked this much above the reader's own mean is full-strength era preference. */
const ERA_LIFT_SCALE = 0.5;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** −1…+1 from a 0–10 score. Five is the scale's middle, not anybody's average. */
export const valenceOf = (score: number) => clamp((score - 5) / 5, -1, 1);

const BAND_MIDPOINT_VALENCE: Record<Bucket, number> = {
  loved: valenceOf((BAND_RANGE.loved.high + BAND_RANGE.loved.low) / 2),
  fine: valenceOf((BAND_RANGE.fine.high + BAND_RANGE.fine.low) / 2),
  not_for_me: valenceOf((BAND_RANGE.not_for_me.high + BAND_RANGE.not_for_me.low) / 2),
};

/** Confidence and valence for one title, per the table in the header. */
export function evidenceOf(entry: Pick<ProfileEntry, 'score' | 'bucket'>): {
  confidence: number;
  valence: number | null;
} {
  if (entry.score != null) return { confidence: 1, valence: valenceOf(entry.score) };
  if (entry.bucket) return { confidence: BUCKETED_CONFIDENCE, valence: BAND_MIDPOINT_VALENCE[entry.bucket] };
  return { confidence: LOGGED_CONFIDENCE, valence: null };
}

export const decadeOf = (year: number | null): number | null =>
  year == null || !Number.isFinite(year) ? null : Math.floor(year / 10) * 10;

const emptyStats = (): FacetStats => ({ exposure: 0, opinion: 0, valence: 0, titles: 0 });

function add<K>(map: Map<K, FacetStats>, key: K, confidence: number, valence: number | null) {
  const stats = map.get(key) ?? emptyStats();
  stats.exposure += confidence;
  stats.titles += 1;
  if (valence != null) {
    stats.opinion += confidence;
    stats.valence += confidence * valence;
  }
  map.set(key, stats);
}

/** Shrunk mean valence: the facet's own opinions plus {@link PRIOR_TITLES} at the reader's mean. */
const shrunkMean = (stats: FacetStats, readerMean: number) =>
  clamp((stats.valence + PRIOR_TITLES * readerMean) / (stats.opinion + PRIOR_TITLES), -1, 1);

const interestOf = (exposure: number, saturation: number) => 1 - Math.exp(-exposure / saturation);

/**
 * Absolute-opinion affinity, for language and genre.
 *
 * `neutral + interest × (positivity − neutral)`: with no evidence a facet is neutral; with
 * a lot it is the reader's (shrunk) opinion of it on 0–1. Interest is what lets a minority
 * language reach the same affinity as the majority one once it has a few titles behind it.
 */
function absoluteAffinity(stats: FacetStats, readerMean: number, neutral: number, saturation: number): FacetAffinity {
  const interest = interestOf(stats.exposure, saturation);
  const mean = shrunkMean(stats, readerMean);
  const positivity = (mean + 1) / 2;
  return {
    affinity: clamp(neutral + interest * (positivity - neutral), 0, 1),
    interest,
    mean,
    titles: stats.titles,
  };
}

/**
 * Relative-opinion affinity, for era: how much better this decade is liked than the reader
 * likes things in general, gated by how much evidence there is. Exposure alone never moves it.
 */
function relativeAffinity(stats: FacetStats, readerMean: number): FacetAffinity {
  const interest = interestOf(stats.exposure, SATURATION.era);
  const mean = shrunkMean(stats, readerMean);
  const lift = clamp((mean - readerMean) / ERA_LIFT_SCALE, -1, 1);
  return {
    affinity: clamp(NEUTRAL.era + 0.5 * interest * lift, 0, 1),
    interest,
    mean,
    titles: stats.titles,
  };
}

function smoothDecades(raw: Map<number, FacetStats>): Map<number, FacetStats> {
  const smoothed = new Map<number, FacetStats>();
  for (const [decade, stats] of raw) {
    for (const [target, share] of [
      [decade, 1],
      [decade - 10, ERA_NEIGHBOUR],
      [decade + 10, ERA_NEIGHBOUR],
    ] as const) {
      const into = smoothed.get(target) ?? emptyStats();
      into.exposure += stats.exposure * share;
      into.opinion += stats.opinion * share;
      into.valence += stats.valence * share;
      if (share === 1) into.titles += stats.titles;
      smoothed.set(target, into);
    }
  }
  return smoothed;
}

/**
 * One profile from the reader's ranked and logged titles.
 *
 * `entries` may contain the same title twice (a ranked title is usually also a logged
 * one); the first occurrence wins, so pass ranked entries before logged ones.
 */
export function profileFrom(entries: readonly ProfileEntry[]): Profile {
  const seen = new Set<string>();
  const languages = new Map<string, FacetStats>();
  const genres = new Map<string, FacetStats>();
  const decades = { movie: new Map<number, FacetStats>(), series: new Map<number, FacetStats>() };

  let opinion = 0;
  let valenceTotal = 0;
  let ranked = 0;

  const kept: { entry: ProfileEntry; confidence: number; valence: number | null }[] = [];
  for (const entry of entries) {
    if (seen.has(entry.mediaItemId)) continue;
    seen.add(entry.mediaItemId);
    const evidence = evidenceOf(entry);
    const confidence = evidence.confidence * (entry.weight ?? 1);
    const { valence } = evidence;
    if (entry.score != null) ranked += 1;
    if (valence != null) {
      opinion += confidence;
      valenceTotal += confidence * valence;
    }
    kept.push({ entry, confidence, valence });
  }

  const readerMean = opinion > 0 ? valenceTotal / opinion : 0;

  for (const { entry, confidence, valence } of kept) {
    if (entry.language) add(languages, entry.language, confidence, valence);
    // A multi-genre title is one title of evidence for each of its genres, as in V1.
    for (const genre of new Set(entry.genres)) add(genres, genre, confidence, valence);
    const decade = decadeOf(entry.year);
    if (decade != null) add(entry.kind === 'movie' ? decades.movie : decades.series, decade, confidence, valence);
  }

  const mapValues = <K>(source: Map<K, FacetStats>, fn: (stats: FacetStats) => FacetAffinity) =>
    new Map([...source].map(([key, stats]) => [key, fn(stats)] as const));

  return {
    languages: mapValues(languages, (stats) => absoluteAffinity(stats, readerMean, NEUTRAL.language, SATURATION.language)),
    genres: mapValues(genres, (stats) => absoluteAffinity(stats, readerMean, NEUTRAL.genre, SATURATION.genre)),
    eras: {
      movie: mapValues(smoothDecades(decades.movie), (stats) => relativeAffinity(stats, readerMean)),
      series: mapValues(smoothDecades(decades.series), (stats) => relativeAffinity(stats, readerMean)),
    },
    mean: readerMean,
    sampleSize: ranked,
    evidenceCount: kept.length,
  };
}

/** A facet's affinity, or its neutral value when the reader has no evidence about it. */
export const languageAffinity = (profile: Profile, code: string | null) =>
  (code ? profile.languages.get(code)?.affinity : undefined) ?? NEUTRAL.language;

export const genreAffinity = (profile: Profile, genre: string) =>
  profile.genres.get(genre)?.affinity ?? NEUTRAL.genre;

export const eraAffinity = (profile: Profile, kind: 'movie' | 'series', year: number | null) => {
  const decade = decadeOf(year);
  if (decade == null) return NEUTRAL.era;
  return profile.eras[kind].get(decade)?.affinity ?? NEUTRAL.era;
};

/** At most this many languages are asked of the catalogue source per slate. */
export const MAX_SOURCE_LANGUAGES = 5;

/** A language is worth a catalogue quota once its affinity clears neutral by this much. */
const SOURCE_LANGUAGE_MARGIN = 0.15;

/**
 * Which languages to ask the catalogue for, strongest first, with a quota each.
 *
 * Quotas are **equal**, not proportional to volume. Proportional quotas are the English
 * bias again by another route: forty English titles to four Japanese would give Japanese a
 * tenth of the slots, and the reader would still be shown English. Ordering by affinity
 * decides which languages are asked at all; once asked, each gets the same room, and the
 * scorer decides what wins.
 */
export function sourceLanguages(profile: Profile, limit = MAX_SOURCE_LANGUAGES): string[] {
  return [...profile.languages]
    .filter(([, facet]) => facet.affinity >= NEUTRAL.language + SOURCE_LANGUAGE_MARGIN)
    .sort((a, b) => b[1].affinity - a[1].affinity || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([code]) => code);
}

/** At most this many decades get their own catalogue slice. */
export const MAX_SOURCE_DECADES = 2;

/**
 * Decades the reader likes *more than they like things generally*, strongest first.
 *
 * Positive lift only: a decade the reader merely watches a lot of already dominates every
 * popularity-ordered source, which is the exposure-is-not-preference point again.
 */
export function sourceDecades(profile: Profile, kind: 'movie' | 'series', limit = MAX_SOURCE_DECADES): number[] {
  return [...profile.eras[kind]]
    .filter(([, facet]) => facet.affinity > NEUTRAL.era + 0.05 && facet.titles > 0)
    .sort((a, b) => b[1].affinity - a[1].affinity || a[0] - b[0])
    .slice(0, limit)
    .map(([decade]) => decade);
}
