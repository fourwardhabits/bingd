import type { RankedEntry } from '@/features/collection/use-collection';

import { seriesAlreadyMet, seriesUnitWeights, socialSeriesFrom } from './anchors';
import { genreAffinity, languageAffinity, profileFrom } from './profile';
import { tasteFrom } from './rank';
import { likedFrom, profileEntriesFrom } from './use-for-you';

/**
 * **Shows and seasons as distinct signals** (TV show & season ranking, founder brief §7,
 * 2026-11-14).
 *
 * A whole show's ranking informs recommendations beside its seasons and is never treated
 * as a season, and no rating is inferred from one level for the other. A series is not
 * overweighted because many of its seasons are ranked: every observation is kept, and the
 * rows of one series share one unit of influence.
 */

const entry = (over: Partial<RankedEntry>): RankedEntry => ({
  mediaItemId: 'x',
  title: 'X',
  year: 2020,
  posterPath: null,
  genres: ['Drama'],
  runtimeMinutes: null,
  kind: 'season',
  seriesTitle: null,
  seriesId: null,
  language: 'en',
  bucket: 'loved',
  position: 1,
  category: 'tv_seasons',
  rankedAt: null,
  ...over,
});

const season = (
  id: string,
  seriesId: string,
  position: number,
  over: Partial<RankedEntry> = {},
) => entry({ mediaItemId: id, seriesId, seriesTitle: seriesId, position, ...over });
const show = (id: string, position: number, over: Partial<RankedEntry> = {}) =>
  entry({
    mediaItemId: id,
    title: id,
    kind: 'series',
    category: 'tv_shows',
    position,
    ...over,
  });

describe('one unit of influence per series', () => {
  it('splits a series between its ranked seasons and its show ranking, and leaves films at 1', () => {
    const weights = seriesUnitWeights([
      season('s1', 'shameless', 1),
      season('s2', 'shameless', 2),
      season('s3', 'shameless', 3),
      show('shameless', 1),
      show('severance', 2),
      entry({ mediaItemId: 'heat', kind: 'movie', category: 'movies' }),
    ]);
    expect(weights.get('s1')).toBeCloseTo(0.25);
    expect(weights.get('shameless')).toBeCloseTo(0.25);
    expect(weights.get('severance')).toBe(1);
    expect(weights.get('heat')).toBe(1);
  });

  it('lets a series with ten ranked seasons pull no harder than a show ranked once', () => {
    const tenSeasons = Array.from({ length: 10 }, (_, n) =>
      season(`s${n}`, 'long', n + 1, { genres: ['Comedy'] }),
    );
    const one = show('short', 1, { genres: ['Thriller'] });
    const signals = [...tenSeasons, one];
    const weights = seriesUnitWeights(signals);
    const taste = tasteFrom(
      signals.map((e) => ({
        score: 10,
        genres: e.genres,
        language: e.language,
        weight: weights.get(e.mediaItemId) ?? 1,
      })),
    );
    expect(taste.genres.get('Comedy')).toBeCloseTo(taste.genres.get('Thriller') ?? 0);
    // Every observation is still counted as evidence.
    expect(taste.sampleSize).toBe(11);
  });
});

describe('a whole show on the TV wall', () => {
  it('anchors on a loved show itself, once, beside a show anchored through its seasons', () => {
    const liked = likedFrom(
      [season('s1', 'bear', 1), season('s2', 'bear', 2), show('severance', 1)],
      'tv',
    );
    expect(liked.map((anchor) => anchor.mediaItemId).sort()).toEqual(['bear', 'severance']);
  });

  it('scores a show anchor against shows, never against the seasons beside it', () => {
    // Four loved seasons and one loved show. Pooled, the show would be scored in a band of
    // five; on its own it is a band of one and scores the high.
    const liked = likedFrom(
      [
        season('s1', 'a', 1),
        season('s2', 'b', 2),
        season('s3', 'c', 3),
        season('s4', 'd', 4),
        show('solo', 1),
      ],
      'tv',
    );
    expect(liked.find((anchor) => anchor.mediaItemId === 'solo')?.score).toBe(10);
  });

  it('counts a followee’s ranked show, once, beside their seasons of it', () => {
    expect(
      socialSeriesFrom(
        ['s1', 'show-a', 's2', 'show-b'],
        [
          { id: 's1', kind: 'season', parent_id: 'show-a' },
          { id: 'show-a', kind: 'series', parent_id: null },
          { id: 's2', kind: 'season', parent_id: 'show-c' },
          { id: 'show-b', kind: 'series', parent_id: null },
        ],
      ),
    ).toEqual(['show-a', 'show-c', 'show-b']);
  });

  it('treats a show the reader logged or ranked as met', () => {
    const met = seriesAlreadyMet(
      [{ kind: 'series', mediaItemId: 'logged-show' }],
      [season('s1', 'from-season', 1)],
    );
    expect([...met].sort()).toEqual(['from-season', 'logged-show']);
  });
});

/**
 * **The V2 profile reads whole shows too** (rec/v2-reconcile, 2026-11-13).
 *
 * Engine V2's behavioural profile was built from films and seasons only, so a reader whose
 * TV taste was ranked show by show had none of it. It now reads the same three pools as V1,
 * with the same `seriesUnitWeights`, so a show ranked whole and its seasons share one unit.
 */
describe('a whole show in the V2 profile', () => {
  it('reads a whole-show ranking as taste evidence', () => {
    const profile = profileFrom(
      profileEntriesFrom([], [], [], [show('kdrama', 1, { genres: ['Romance'], language: 'ko' })]),
    );
    expect(profile.sampleSize).toBe(1);
    expect(languageAffinity(profile, 'ko')).toBeGreaterThan(languageAffinity(profileFrom([]), 'ko'));
    expect(genreAffinity(profile, 'Romance')).toBeGreaterThan(genreAffinity(profileFrom([]), 'Romance'));
  });

  it('weighs a series exactly as V1 does: its seasons and its show ranking share one unit', () => {
    const seasons = [season('s1', 'bear', 1), season('s2', 'bear', 2)];
    const shows = [show('bear', 1), show('severance', 2)];
    const entries = profileEntriesFrom([], seasons, [], shows);
    const v1 = seriesUnitWeights([...seasons, ...shows]);
    for (const e of entries) expect(e.weight).toBeCloseTo(v1.get(e.mediaItemId) ?? 1);
    expect(entries.find((e) => e.mediaItemId === 'bear')?.weight).toBeCloseTo(1 / 3);
    expect(entries.find((e) => e.mediaItemId === 'severance')?.weight).toBe(1);
  });

  it('does not double-count a show ranked whole and by season', () => {
    // One series, loved whole and in two seasons, in Korean; one film, loved, in French.
    // Each is one unit of evidence, so the two languages end level.
    const loved = { bucket: 'loved' as const };
    const profile = profileFrom(
      profileEntriesFrom(
        [entry({ mediaItemId: 'film', kind: 'movie', category: 'movies', language: 'fr', ...loved })],
        [season('s1', 'show', 1, { language: 'ko' }), season('s2', 'show', 2, { language: 'ko' })],
        [],
        [show('show', 1, { language: 'ko' })],
      ),
    );
    expect(profile.languages.get('ko')?.interest).toBeCloseTo(profile.languages.get('fr')?.interest ?? 0);
  });

  it('lets ten logged seasons of one show say no more than one logged show', () => {
    const logged = Array.from({ length: 10 }, (_, n) => ({
      mediaItemId: `l${n}`,
      title: 'Long',
      year: 2020,
      posterPath: null,
      genres: ['Comedy'],
      runtimeMinutes: null,
      kind: 'season' as const,
      seriesTitle: 'long',
      seriesId: 'long',
      language: 'ja',
      bucket: null,
      watchedOn: null,
      addedAt: null,
    }));
    const one = { ...logged[0]!, mediaItemId: 'other', kind: 'series' as const, seriesId: null, language: 'de' };
    const profile = profileFrom(profileEntriesFrom([], [], [...logged, one]));
    expect(profile.languages.get('ja')?.interest).toBeCloseTo(profile.languages.get('de')?.interest ?? 0);
    expect(profile.evidenceCount).toBe(11);
  });

  it('keeps a ranked title out of the logged evidence, so it is counted once', () => {
    const ranked = [show('severance', 1)];
    const logged = [
      {
        mediaItemId: 'severance',
        title: 'Severance',
        year: 2022,
        posterPath: null,
        genres: ['Drama'],
        runtimeMinutes: null,
        kind: 'series' as const,
        seriesTitle: null,
        language: 'en',
        bucket: null,
        watchedOn: null,
        addedAt: null,
      },
    ];
    expect(profileEntriesFrom([], [], logged, ranked).map((e) => e.mediaItemId)).toEqual(['severance']);
  });
});
