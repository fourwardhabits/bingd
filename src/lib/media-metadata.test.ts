import {
  ANIME_GENRE,
  effectiveGenres,
  effectiveLanguage,
  isAnimeSubject,
  parentOf,
  productGenres,
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

/**
 * **Anime is the product genre for a Japanese animated title** (founder, 2026-08-30).
 *
 * The state this corrects: Anime became an entry in the collection's Genre filter on
 * 2026-08-29, and the title page went on printing TMDB's raw `Animation` — so one
 * title was two things depending on which screen you were on, and a reader who filtered
 * to Anime and opened a result was told it was Animation.
 *
 * The predicate is unchanged and deliberately conservative: **Japanese original language
 * AND an animation genre**. It is not "all Animation", not "all Japanese titles", and
 * not "made in Japan" — three different sets, one of which is anime. What changed is
 * that the rule lives here, where every genre-bearing read passes through it, instead of
 * inside the filter model where exactly one surface could reach it.
 */
describe('the Anime product genre', () => {
  const anime = (over: Partial<MetadataSubject> = {}): MetadataSubject => ({
    kind: 'movie',
    genres: ['Animation', 'Action', 'Adventure'],
    language: 'ja',
    ...over,
  });

  it('replaces Animation with Anime and keeps everything else', () => {
    // The founder's decision of 2026-08-30: Anime leads. Most surfaces draw two genres
    // and no more, so a label at the end of a five-genre list is one usually not drawn at
    // all. The rest keep the order the provider published them in.
    expect(productGenres(anime())).toEqual([ANIME_GENRE, 'Action', 'Adventure']);
  });

  it('never exposes both labels for the same title', () => {
    const genres = productGenres(anime());
    expect(genres).toContain(ANIME_GENRE);
    expect(genres).not.toContain('Animation');
  });

  it('leaves a non-anime animated title as Animation', () => {
    // Every Pixar and Disney film. Widening Anime to all Animation is the mistake the
    // predicate exists to refuse, and this is the row that would be swept in.
    expect(productGenres(anime({ language: 'en', genres: ['Animation', 'Family'] }))).toEqual([
      'Animation',
      'Family',
    ]);
  });

  it('leaves Japanese live action alone', () => {
    // Language is half the predicate and never the whole of it. A Kurosawa film is not
    // anime and must not gain the label by being Japanese.
    expect(productGenres(anime({ genres: ['Drama', 'History'] }))).toEqual(['Drama', 'History']);
    expect(isAnimeSubject(anime({ genres: ['Drama'] }))).toBe(false);
  });

  it('reads both of the catalogue vocabularies the app actually holds', () => {
    // The alpha catalogue is Wikidata-seeded and spells it `animated film`; an enriched
    // row carries TMDB's `Animation`. Both are in the same column at the same time.
    expect(productGenres(anime({ genres: ['animated film', 'drama film'] }))).toEqual([
      ANIME_GENRE,
      'drama film',
    ]);
  });

  it('adds no second Anime to a row that already carries the word', () => {
    // A row labelled Anime by a provider must not come back with it twice, and the
    // normalisation has to be idempotent for the same reason: several surfaces resolve
    // a title more than once on its way to the screen.
    const once = productGenres(anime({ genres: ['Anime', 'Action'] }));
    expect(once).toEqual([ANIME_GENRE, 'Action']);
    expect(productGenres({ kind: 'movie', language: 'ja', genres: once })).toEqual(once);
  });

  it('gives a season the answer its show has, so the two agree', () => {
    // A season carries no genres and no language at all — TMDB publishes both on the
    // series — so without inheritance an anime season is not anime, which is exactly
    // the class of bug `effectiveGenres` was written for.
    const season: MetadataSubject = {
      kind: 'season',
      genres: null,
      language: null,
      parent: { genres: ['Animation', 'Action'], language: 'ja' },
    };
    expect(isAnimeSubject(season)).toBe(true);
    expect(productGenres(season)).toEqual([ANIME_GENRE, 'Action']);
  });

  it('says nothing about a title with no genres at all', () => {
    expect(productGenres({ kind: 'movie', genres: [], language: 'ja' })).toEqual([]);
    expect(productGenres({ kind: 'movie', genres: null, language: null })).toEqual([]);
  });

  it('leaves the raw metadata untouched, because the catalogue is a cache', () => {
    // The reason this is a read-time layer rather than a migration: re-enrichment
    // overwrites `media_items.genres`, so a product opinion written into a provider
    // column is one `catalogue:enrich` away from being reverted.
    const subject = anime();
    productGenres(subject);
    expect(effectiveGenres(subject)).toEqual(['Animation', 'Action', 'Adventure']);
    expect(subject.genres).toEqual(['Animation', 'Action', 'Adventure']);
  });

  it('is what the shared resolver returns, so every surface gets the same list', () => {
    // `resolveMetadata` is the one adapter the title page, the collection, the awards
    // breakdown and the feed all read through. Normalising there is what makes the
    // answer the same on all of them rather than the same on the ones somebody
    // remembered.
    expect(
      resolveMetadata({
        kind: 'movie',
        genres: ['Animation', 'Action'],
        original_language: 'ja',
        parent: null,
      }),
    ).toEqual({
      genres: [ANIME_GENRE, 'Action'],
      language: 'ja',
      certification: null,
      seriesTitle: null,
    });

    // And the language is untouched by any of it — `ja` is still `ja`.
    expect(effectiveLanguage(anime())).toBe('ja');
  });
});
