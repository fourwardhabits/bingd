import { selectAnchors, meaningfulLanguages, MAX_LANGUAGE_ANCHORS, type LikedTitle } from './anchors';
import { coverageFill, MAX_PER_FACET, MIN_PER_FACET } from './coverage';
import {
  BUCKETED_CONFIDENCE,
  LOGGED_CONFIDENCE,
  NEUTRAL,
  eraAffinity,
  evidenceOf,
  genreAffinity,
  languageAffinity,
  profileFrom,
  sourceDecades,
  sourceLanguages,
  type ProfileEntry,
} from './profile';
import {
  COLLABORATIVE_FULL,
  COLLABORATIVE_NAMED_AT,
  ENGINES,
  engineFrom,
  headlineFor,
  scoreCandidate,
  scoreCandidateV2,
  scoreSlate,
  tasteFrom,
  type Anchor,
  type Candidate,
} from './rank';

/**
 * Engine V2, A1: the behavioural profile, the catalogue fill, the V2 scorer, and
 * language-aware anchors (founder spec 2026-11-10, §3).
 *
 * Every fixture here is synthetic and small on purpose. These pin *properties* — a
 * minority language can be as strong as the majority, exposure is not era preference,
 * negative evidence lowers without excluding — not calibrated numbers. Whether V2 is
 * better for real readers is A3's question, and is not answered by anything in this file.
 */

let seq = 0;
const entry = (overrides: Partial<ProfileEntry>): ProfileEntry => ({
  mediaItemId: `t-${seq++}`,
  score: 7,
  bucket: 'loved',
  language: 'en',
  year: 2015,
  kind: 'movie',
  genres: ['Drama'],
  ...overrides,
});
const many = (count: number, overrides: Partial<ProfileEntry>) =>
  Array.from({ length: count }, () => entry(overrides));

const candidate = (overrides: Partial<Candidate>): Candidate => ({
  mediaItemId: `c-${seq++}`,
  title: 'Candidate',
  year: 2016,
  posterPath: null,
  kind: 'movie',
  genres: ['Drama'],
  language: 'en',
  popularity: 100,
  ...overrides,
});

describe('evidence per title', () => {
  it('trusts a ranking fully, a bucket less, and a plain log least and without opinion', () => {
    expect(evidenceOf({ score: 9, bucket: 'loved' })).toEqual({ confidence: 1, valence: 0.8 });
    const bucketed = evidenceOf({ score: null, bucket: 'not_for_me' });
    expect(bucketed.confidence).toBe(BUCKETED_CONFIDENCE);
    expect(bucketed.valence).toBeLessThan(-0.5);
    expect(evidenceOf({ score: null, bucket: null })).toEqual({ confidence: LOGGED_CONFIDENCE, valence: null });
  });
});

describe('language, inferred from behaviour', () => {
  it('is neutral with no evidence, for every language including English', () => {
    const profile = profileFrom([]);
    expect(languageAffinity(profile, 'en')).toBe(NEUTRAL.language);
    expect(languageAffinity(profile, 'ja')).toBe(NEUTRAL.language);
    expect(languageAffinity(profile, null)).toBe(NEUTRAL.language);
  });

  it('lets four loved Japanese films match forty English ones of mixed opinion', () => {
    const profile = profileFrom([
      ...many(20, { language: 'en', score: 8.5 }),
      ...many(20, { language: 'en', score: 4, bucket: 'fine' }),
      ...many(4, { language: 'ja', score: 9 }),
    ]);
    expect(languageAffinity(profile, 'ja')).toBeGreaterThan(languageAffinity(profile, 'en'));
    expect(sourceLanguages(profile)).toContain('ja');
  });

  it('assumes nothing about English for a reader who watches none', () => {
    const profile = profileFrom(many(12, { language: 'ko', score: 8 }));
    expect(languageAffinity(profile, 'en')).toBe(NEUTRAL.language);
    expect(sourceLanguages(profile)).toEqual(['ko']);
  });

  it('holds several strong languages at once', () => {
    const profile = profileFrom([
      ...many(6, { language: 'ja', score: 9 }),
      ...many(6, { language: 'ko', score: 9 }),
      ...many(6, { language: 'hi', score: 9 }),
      ...many(30, { language: 'en', score: 6, bucket: 'fine' }),
    ]);
    const sources = sourceLanguages(profile);
    for (const code of ['ja', 'ko', 'hi']) expect(sources).toContain(code);
  });

  it('weighs a watched-but-unranked language below a ranked one, and above the unknown', () => {
    const profile = profileFrom([
      ...many(6, { language: 'ja', score: 9 }),
      ...many(6, { language: 'fr', score: null, bucket: null }),
    ]);
    const ja = languageAffinity(profile, 'ja');
    const fr = languageAffinity(profile, 'fr');
    expect(fr).toBeLessThan(ja);
    expect(fr).toBeGreaterThan(NEUTRAL.language);
  });

  it('sinks a language the reader keeps disliking, without excluding it', () => {
    const profile = profileFrom([
      ...many(10, { language: 'en', score: 8 }),
      ...many(8, { language: 'de', score: 1.5, bucket: 'not_for_me' }),
    ]);
    const de = languageAffinity(profile, 'de');
    expect(de).toBeLessThan(NEUTRAL.language);
    expect(de).toBeGreaterThan(0);
    expect(sourceLanguages(profile)).not.toContain('de');
  });

  it('counts a title once, keeping the first occurrence', () => {
    const ranked = entry({ mediaItemId: 'same', language: 'ja', score: 9.5 });
    const logged = { ...ranked, score: null, bucket: null };
    const profile = profileFrom([ranked, logged]);
    expect(profile.evidenceCount).toBe(1);
    expect(profile.sampleSize).toBe(1);
  });
});

describe('genre, with negative evidence', () => {
  it('pulls a repeatedly disliked genre below neutral and a loved one above', () => {
    const profile = profileFrom([
      ...many(8, { genres: ['Horror'], score: 1.5, bucket: 'not_for_me' }),
      ...many(8, { genres: ['Comedy'], score: 9 }),
    ]);
    expect(genreAffinity(profile, 'Horror')).toBeLessThan(NEUTRAL.genre);
    expect(genreAffinity(profile, 'Comedy')).toBeGreaterThan(0.6);
    expect(genreAffinity(profile, 'Western')).toBe(NEUTRAL.genre);
  });
});

describe('era: preference relative to exposure, per medium', () => {
  it('does not mistake watching mostly recent titles for preferring them', () => {
    const profile = profileFrom([
      ...many(30, { year: 2018, score: 7 }),
      ...many(30, { year: 2018, score: 3, bucket: 'fine' }),
    ]);
    expect(Math.abs(eraAffinity(profile, 'movie', 2018) - NEUTRAL.era)).toBeLessThan(0.02);
    expect(sourceDecades(profile, 'movie')).toEqual([]);
  });

  it('lifts a decade liked more than the reader likes things in general', () => {
    const profile = profileFrom([
      ...many(30, { year: 2018, score: 5, bucket: 'fine' }),
      ...many(6, { year: 1974, score: 9.5 }),
    ]);
    expect(eraAffinity(profile, 'movie', 1975)).toBeGreaterThan(NEUTRAL.era + 0.1);
    expect(sourceDecades(profile, 'movie')[0]).toBe(1970);
    // Smoothed: the neighbouring decade borrows some of it, and less.
    const neighbour = eraAffinity(profile, 'movie', 1985);
    expect(neighbour).toBeGreaterThan(NEUTRAL.era);
    expect(neighbour).toBeLessThan(eraAffinity(profile, 'movie', 1975));
  });

  it('never pushes a classic down for being old', () => {
    const profile = profileFrom(many(40, { year: 2020, score: 8 }));
    expect(eraAffinity(profile, 'movie', 1952)).toBe(NEUTRAL.era);
    expect(eraAffinity(profile, 'movie', null)).toBe(NEUTRAL.era);
  });

  it('keeps films and television apart', () => {
    const profile = profileFrom([
      ...many(20, { year: 2018, score: 5, bucket: 'fine' }),
      ...many(6, { year: 1994, score: 9.5, kind: 'movie' }),
    ]);
    expect(eraAffinity(profile, 'movie', 1994)).toBeGreaterThan(NEUTRAL.era);
    expect(eraAffinity(profile, 'series', 1994)).toBe(NEUTRAL.era);
  });
});

describe('the catalogue fills a shortfall and nothing more', () => {
  const profile = profileFrom([
    ...many(20, { language: 'en', score: 8 }),
    ...many(4, { language: 'ja', score: 9 }),
  ]);
  const request = { kind: 'movie' as const, languages: ['ja', 'en'], decades: [] };
  const japanese = (count: number) => Array.from({ length: count }, () => candidate({ language: 'ja' }));
  const englishPool = Array.from({ length: 40 }, () => candidate({ language: 'en' }));

  it('brings a minority language up to its floor when the lists held none', () => {
    const added = coverageFill(englishPool, [...japanese(30)], profile, request);
    // Japanese is about a sixth of this reader's positive evidence: at least the floor, and
    // no more than its share of the pool.
    expect(added.length).toBeGreaterThanOrEqual(MIN_PER_FACET);
    expect(added.length).toBeLessThanOrEqual(Math.ceil(0.25 * englishPool.length));
    // English is already over its share, so none of it is padding.
    expect(added.every((row) => row.language === 'ja')).toBe(true);
  });

  it('adds nothing for a language the pool already covers', () => {
    const pool = [...englishPool, ...japanese(12)];
    expect(coverageFill(pool, japanese(10), profile, request)).toEqual([]);
  });

  it('does not count titles the slate will drop as coverage', () => {
    // The anchor lists held twelve Japanese films — enough to cover the facet — all already
    // in the reader's collection.
    const logged = japanese(12);
    const pool = [...englishPool, ...logged];
    const ineligible = new Set(logged.map((row) => row.mediaItemId));
    const added = coverageFill(pool, japanese(30), profile, request, ineligible);
    expect(added.length).toBeGreaterThanOrEqual(MIN_PER_FACET);
    expect(added.some((row) => ineligible.has(row.mediaItemId))).toBe(false);
    // And the same pool with nothing ineligible is already covered.
    expect(coverageFill(pool, japanese(30), profile, request)).toEqual([]);
  });

  it('never adds an ineligible catalogue row', () => {
    const owned = candidate({ language: 'ja' });
    const added = coverageFill(englishPool, [owned, ...japanese(10)], profile, request, new Set([owned.mediaItemId]));
    expect(added.map((row) => row.mediaItemId)).not.toContain(owned.mediaItemId);
  });

  it('never adds a title already in the pool, or one that serves no facet', () => {
    const existing = candidate({ language: 'ja' });
    const added = coverageFill([existing, ...englishPool], [existing, candidate({ language: 'it' })], profile, request);
    expect(added).toEqual([]);
  });

  it('caps a facet however dominant it is', () => {
    const solo = profileFrom(many(30, { language: 'ja', score: 9 }));
    const added = coverageFill(
      Array.from({ length: 100 }, () => candidate({ language: 'en' })),
      japanese(60),
      solo,
      { kind: 'movie', languages: ['ja'], decades: [] },
    );
    expect(added).toHaveLength(MAX_PER_FACET);
  });

  it('fills a liked decade, classics included', () => {
    const seventies = profileFrom([
      ...many(30, { year: 2018, score: 5, bucket: 'fine' }),
      ...many(6, { year: 1974, score: 9.5 }),
    ]);
    const rows = Array.from({ length: 10 }, () => candidate({ year: 1976 }));
    const added = coverageFill(englishPool, rows, seventies, { kind: 'movie', languages: [], decades: [1970] });
    // Six of thirty-six films are from the 1970s, so its share of forty is seven.
    expect(added).toHaveLength(Math.ceil((6 / 36) * englishPool.length));
  });
});

describe('the V2 scorer', () => {
  const anchors: Anchor[] = [{ mediaItemId: 'a1', title: 'Heat', score: 9.5, similarIds: ['near'] }];

  it('has versioned engines whose weights sum to one', () => {
    for (const { version, weights } of Object.values(ENGINES)) {
      expect(version).toMatch(/^foryou-/);
      const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
      expect(total).toBeCloseTo(1, 10);
    }
    expect(ENGINES.v1.weights.era).toBe(0);
    expect(ENGINES.v1.weights.collaborative).toBe(0);
    expect(ENGINES.v2_metadata.weights.collaborative).toBe(0);
    expect(ENGINES.v2_hybrid.weights.collaborative).toBeGreaterThan(0);
  });

  it('reads an unknown engine as v1', () => {
    expect(engineFrom('v2_metadata')).toBe('v2_metadata');
    expect(engineFrom('v9')).toBe('v1');
    expect(engineFrom(null)).toBe('v1');
    expect(engineFrom(undefined)).toBe('v1');
    expect(engineFrom('toString')).toBe('v1');
    expect(engineFrom('__proto__')).toBe('v1');
  });

  it('leaves V1 exactly as it was when no engine is given', () => {
    const taste = tasteFrom([{ score: 9, genres: ['Drama'], language: 'en' }]);
    const candidates = [candidate({ mediaItemId: 'near' }), candidate({ language: 'ja' })];
    const exclude = new Set<string>();
    const v1 = scoreSlate({ candidates, anchors, taste, exclude });
    expect(v1).toEqual(candidates.map((c) => scoreCandidate(c, anchors, taste)));
    const profile = profileFrom([entry({ language: 'ja', score: 9 })]);
    expect(scoreSlate({ candidates, anchors, taste, exclude, engine: 'v1', profile })).toEqual(v1);
  });

  it('scores an unfamiliar language as neutral, and never claims it as the reason', () => {
    const profile = profileFrom(many(12, { language: 'en', score: 8 }));
    const scored = scoreCandidateV2(candidate({ language: 'te' }), [], profile, ENGINES.v2_metadata);
    expect(scored.explanation.language).toBeNull();
    expect(scored.explanation.lead).not.toBe('language');
    expect(scored.explanation.engine).toBe(ENGINES.v2_metadata.version);
  });

  it('ranks a loved minority language above the unknown, all else equal', () => {
    const profile = profileFrom([...many(20, { language: 'en', score: 6, bucket: 'fine' }), ...many(4, { language: 'ja', score: 9 })]);
    const ja = scoreCandidateV2(candidate({ language: 'ja' }), [], profile, ENGINES.v2_metadata);
    const te = scoreCandidateV2(candidate({ language: 'te' }), [], profile, ENGINES.v2_metadata);
    expect(ja.explanation.total).toBeGreaterThan(te.explanation.total);
  });

  it('lowers a disliked genre without excluding the title', () => {
    const profile = profileFrom([
      ...many(8, { genres: ['Horror'], score: 1.5, bucket: 'not_for_me' }),
      ...many(8, { genres: ['Comedy'], score: 9 }),
    ]);
    const horror = candidate({ genres: ['Horror'] });
    const western = candidate({ genres: ['Western'] });
    const slate = scoreSlate({
      candidates: [horror, western],
      anchors: [],
      taste: tasteFrom([]),
      exclude: new Set(),
      engine: 'v2_metadata',
      profile,
    });
    expect(slate).toHaveLength(2);
    const [h, w] = slate;
    expect(h!.explanation.total).toBeLessThan(w!.explanation.total);
  });

  it('lets a disliked genre lower a title that also carries a neutral or a loved one', () => {
    const profile = profileFrom([
      ...many(8, { genres: ['Horror'], score: 1.5, bucket: 'not_for_me' }),
      ...many(8, { genres: ['Drama'], score: 9 }),
    ]);
    const score = (genres: string[]) =>
      scoreCandidateV2(candidate({ genres }), [], profile, ENGINES.v2_metadata).explanation.total;
    // A Horror-Thriller is below a Western, which carries no evidence at all.
    expect(score(['Horror', 'Thriller'])).toBeLessThan(score(['Western']));
    // A loved genre still lifts a title that also carries a disliked one, but by less.
    expect(score(['Drama', 'Horror'])).toBeLessThan(score(['Drama']));
    expect(score(['Drama', 'Horror'])).toBeGreaterThan(score(['Horror']));
    // An unknown second genre costs nothing.
    expect(score(['Drama', 'Western'])).toBeCloseTo(score(['Drama']), 10);
  });

  it('can lead with era, and only says so with enough rankings', () => {
    const profile = profileFrom([
      ...many(30, { year: 2018, score: 5, bucket: 'fine', genres: [] }),
      ...many(6, { year: 1974, score: 9.5, genres: [] }),
    ]);
    const scored = scoreCandidateV2(
      candidate({ year: 1976, genres: [], language: null, popularity: 0 }),
      [],
      profile,
      ENGINES.v2_metadata,
    );
    expect(scored.explanation.lead).toBe('era');
    expect(scored.explanation.era?.decade).toBe(1970);
    const taste = { ...tasteFrom([]), sampleSize: 36 };
    const label = (code: string) => code;
    expect(headlineFor(scored.explanation, taste, label)).toBe('More from the 1970s, which you rank highly');
    expect(headlineFor(scored.explanation, { ...taste, sampleSize: 2 }, label)).toBe('Popular right now');
  });

  it('keeps the anchor term identical to V1', () => {
    const profile = profileFrom([]);
    const near = candidate({ mediaItemId: 'near' });
    const v2 = scoreCandidateV2(near, anchors, profile, ENGINES.v2_metadata);
    const v1 = scoreCandidate(near, anchors, tasteFrom([]));
    expect(v2.explanation.anchors).toEqual(v1.explanation.anchors);
    expect(v2.explanation.lead).toBe('anchors');
  });
});

describe('the hybrid scorer: collaborative evidence (A2)', () => {
  const profile = profileFrom(many(12, { language: 'en', score: 8 }));
  const cohort = (support: number, endorsers = 4) => ({ support, endorsers });

  it('lifts a title the reader\'s taste neighbours loved, all else equal', () => {
    const loved = scoreCandidateV2(candidate({ collaborative: cohort(0.4) }), [], profile, ENGINES.v2_hybrid);
    const plain = scoreCandidateV2(candidate({}), [], profile, ENGINES.v2_hybrid);
    expect(loved.explanation.total).toBeGreaterThan(plain.explanation.total);
    expect(loved.explanation.collaborative).toEqual(cohort(0.4));
    expect(plain.explanation.collaborative).toBeNull();
  });

  it('ignores the evidence under every engine that does not weigh it', () => {
    const withIt = candidate({ collaborative: cohort(0.9) });
    const without = { ...withIt, collaborative: undefined };
    const metadata = scoreCandidateV2(withIt, [], profile, ENGINES.v2_metadata);
    expect(metadata.explanation.total).toBe(scoreCandidateV2(without, [], profile, ENGINES.v2_metadata).explanation.total);
    expect(metadata.explanation.collaborative).toBeNull();
    const taste = tasteFrom([{ score: 8, genres: ['Drama'], language: 'en' }]);
    expect(scoreCandidate(withIt, [], taste).explanation.total).toBe(
      scoreCandidate(without, [], taste).explanation.total,
    );
  });

  it('saturates: a cohort beyond full support adds nothing more', () => {
    const full = scoreCandidateV2(candidate({ collaborative: cohort(COLLABORATIVE_FULL) }), [], profile, ENGINES.v2_hybrid);
    const more = scoreCandidateV2(candidate({ collaborative: cohort(0.95) }), [], profile, ENGINES.v2_hybrid);
    expect(more.explanation.total).toBeCloseTo(full.explanation.total, 10);
  });

  it('never outweighs a strong anchor on its own', () => {
    const anchors: Anchor[] = [{ mediaItemId: 'a', title: 'Heat', score: 9.5, similarIds: ['near'] }];
    const near = scoreCandidateV2(candidate({ mediaItemId: 'near' }), anchors, profile, ENGINES.v2_hybrid);
    const cohortOnly = scoreCandidateV2(candidate({ collaborative: cohort(0.95, 30) }), anchors, profile, ENGINES.v2_hybrid);
    expect(near.explanation.total).toBeGreaterThan(cohortOnly.explanation.total);
  });

  it('names the cohort only with enough endorsers and enough rankings, and never a person', () => {
    const lead = (endorsers: number) =>
      scoreCandidateV2(
        candidate({ genres: [], language: null, popularity: 0, collaborative: cohort(0.5, endorsers) }),
        [],
        profileFrom([]),
        ENGINES.v2_hybrid,
      ).explanation;
    const label = (code: string) => code;
    const taste = { ...tasteFrom([]), sampleSize: 20 };
    expect(lead(COLLABORATIVE_NAMED_AT).lead).toBe('collaborative');
    expect(headlineFor(lead(COLLABORATIVE_NAMED_AT), taste, label)).toBe('Loved by people with taste like yours');
    expect(headlineFor(lead(COLLABORATIVE_NAMED_AT - 1), taste, label)).toBe('Popular right now');
    expect(headlineFor(lead(COLLABORATIVE_NAMED_AT), { ...taste, sampleSize: 2 }, label)).toBe('Popular right now');
  });
});

describe('anchors that cover the liked languages', () => {
  const liked = (count: number, language: string, from = 0): LikedTitle[] =>
    Array.from({ length: count }, (_, index) => ({
      mediaItemId: `${language}-${from + index}`,
      title: `${language} ${index}`,
      score: 9.9 - (from + index) * 0.05,
      genres: ['Drama'],
      language,
    }));
  const band = [...liked(40, 'en'), ...liked(3, 'ja', 40), ...liked(2, 'ko', 43)];

  it('names a language once two liked titles carry it, with no share rule', () => {
    expect([...meaningfulLanguages(band).keys()]).toEqual(['en', 'ja', 'ko']);
    expect(meaningfulLanguages(liked(1, 'fr')).size).toBe(0);
  });

  it('spends an anchor on each liked minority language when asked to', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const chosen = selectAnchors(band, { seed, languages: true });
      const languages = new Set(chosen.map((title) => title.language));
      expect(languages.has('ja')).toBe(true);
      expect(languages.has('ko')).toBe(true);
    }
  });

  it('is exactly the V1 selection when not asked', () => {
    for (const seed of [1, 2, 3]) {
      const plain = band.map(({ language: _language, ...rest }) => rest);
      expect(selectAnchors(band, { seed }).map((t) => t.mediaItemId)).toEqual(
        selectAnchors(plain, { seed }).map((t) => t.mediaItemId),
      );
    }
  });

  it('spends at most its share of the budget on language coverage', () => {
    const polyglot = [
      ...liked(20, 'en'),
      ...['ja', 'ko', 'fr', 'de', 'it', 'es'].flatMap((code, index) => liked(2, code, 20 + index * 2)),
    ];
    // Budget five: the two stable anchors, then language coverage, then nothing left to
    // rotate — so every minority title chosen was chosen by coverage.
    const chosen = selectAnchors(polyglot, { seed: 7, budget: 5, languages: true });
    expect(chosen.filter((title) => title.language !== 'en')).toHaveLength(MAX_LANGUAGE_ANCHORS);
  });
});
