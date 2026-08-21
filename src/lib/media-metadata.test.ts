import {
  effectiveGenres,
  effectiveLanguage,
  parentOf,
  resolveMetadata,
  type MetadataSubject,
} from './media-metadata';

/**
 * A season is part of its show, and the catalogue does not say so.
 *
 * `tmdb_upsert_seasons` writes neither `genres` nor `original_language`, and the seeded
 * catalogue has neither on any of its 1,432 seasons — TMDB publishes both on the series.
 * So every rule in the app that asked a media item for its genre was, in practice, a
 * rule about films. These tests pin the inheritance that fixed it, and — just as
 * importantly — pin the two places it must *not* reach.
 */

const movie = (over: Partial<MetadataSubject> = {}): MetadataSubject => ({
  kind: 'movie',
  genres: ['Action'],
  language: 'en',
  ...over,
});

const season = (over: Partial<MetadataSubject> = {}): MetadataSubject => ({
  kind: 'season',
  genres: [],
  language: null,
  parent: { genres: ['Drama', 'Thriller'], language: 'ja' },
  ...over,
});

describe('a movie', () => {
  it('uses its own genres', () => {
    expect(effectiveGenres(movie({ genres: ['Horror', 'Mystery'] }))).toEqual([
      'Horror',
      'Mystery',
    ]);
  });

  it('uses its own original language', () => {
    expect(effectiveLanguage(movie({ language: 'ko' }))).toBe('ko');
  });

  it('never borrows from a parent, even if one is somehow attached', () => {
    // A film has no parent in this catalogue. If one ever appeared — a bad join, a
    // future compilation record — inheriting from it would be inventing a fact.
    const orphaned = movie({ genres: [], language: null, parent: { genres: ['Comedy'], language: 'fr' } });
    expect(effectiveGenres(orphaned)).toEqual([]);
    expect(effectiveLanguage(orphaned)).toBeNull();
  });
});

describe('a season', () => {
  it('inherits its series genres when it has none', () => {
    expect(effectiveGenres(season())).toEqual(['Drama', 'Thriller']);
  });

  it('inherits its series original language when it has none', () => {
    expect(effectiveLanguage(season())).toBe('ja');
  });

  it('prefers its own metadata where it genuinely has some', () => {
    // Own-first, not parent-first: an anthology season enriched separately is the more
    // specific truth about that season.
    const anthology = season({ genres: ['Comedy'], language: 'fr' });
    expect(effectiveGenres(anthology)).toEqual(['Comedy']);
    expect(effectiveLanguage(anthology)).toBe('fr');
  });

  it('treats an empty array and a blank string as having nothing of its own', () => {
    // Which is what the catalogue actually stores. `genres: []` is the common case and
    // must fall through rather than count as an answer.
    expect(effectiveGenres(season({ genres: [] }))).toEqual(['Drama', 'Thriller']);
    expect(effectiveGenres(season({ genres: ['', '  '] }))).toEqual(['Drama', 'Thriller']);
    expect(effectiveLanguage(season({ language: '   ' }))).toBe('ja');
  });
});

describe('missing metadata is missing', () => {
  it('does not guess when a season has no parent', () => {
    const orphan = season({ parent: null });
    expect(effectiveGenres(orphan)).toEqual([]);
    expect(effectiveLanguage(orphan)).toBeNull();
  });

  it('does not guess when the parent carries nothing either', () => {
    const empty = season({ parent: { genres: [], language: null } });
    expect(effectiveGenres(empty)).toEqual([]);
    expect(effectiveLanguage(empty)).toBeNull();
  });

  it('never infers anything from a title', () => {
    // Stated as a test because it is the tempting shortcut: "Season 1 of a horror show"
    // is not a signal, and a genre guessed from words would be wrong in a way nobody
    // could correct.
    const named = season({ parent: null });
    expect(effectiveGenres(named)).toEqual([]);
  });
});

describe('resolving a PostgREST row', () => {
  it('unwraps the embed PostgREST types as an array', () => {
    expect(parentOf([{ title: 'The Last of Us' }])?.title).toBe('The Last of Us');
    expect(parentOf({ title: 'The Last of Us' })?.title).toBe('The Last of Us');
    expect(parentOf(null)).toBeNull();
  });

  it('carries the series name out with the metadata, so a row can be named', () => {
    const resolved = resolveMetadata({
      kind: 'season',
      genres: null,
      original_language: null,
      parent: { title: 'The Last of Us', genres: ['Drama'], original_language: 'en' },
    });
    expect(resolved).toEqual({
      genres: ['Drama'],
      language: 'en',
      // Selected by nobody in this fixture, which is the ordinary case: a caller that
      // does not ask for the column gets the same answer as one whose title has no
      // rating. Absent and unrated are not distinguished, and nothing needs them to be.
      certification: null,
      seriesTitle: 'The Last of Us',
    });
  });

  it('gives a movie no series title and its own metadata', () => {
    expect(
      resolveMetadata({ kind: 'movie', genres: ['Comedy'], original_language: 'en', parent: null }),
    ).toEqual({ genres: ['Comedy'], language: 'en', certification: null, seriesTitle: null });
  });

  it('resolves a certification the same own-then-parent way the genres go', () => {
    // The reason the field exists. TMDB publishes a rating on the series and never on
    // a season, so a feed row about `Severance, S2` had nothing to print until the
    // parent was consulted — and the parent was already being embedded for its title.
    expect(
      resolveMetadata({
        kind: 'season',
        certification: null,
        parent: { title: 'Severance', certification: 'TV-MA' },
      }).certification,
    ).toBe('TV-MA');

    // Own-first, so an anthology season rated on its own beats the show's.
    expect(
      resolveMetadata({
        kind: 'season',
        certification: 'TV-14',
        parent: { title: 'Severance', certification: 'TV-MA' },
      }).certification,
    ).toBe('TV-14');

    // A movie never falls through: it has no parent to fall through to.
    expect(
      resolveMetadata({ kind: 'movie', certification: null, parent: null }).certification,
    ).toBeNull();
  });
});
