import {
  ANIME_GENRE,
  activeFilterCount,
  applyFilters,
  decadeOf,
  emptyFilters,
  facetOptions,
  isAnime,
  isFiltered,
  shuffle,
  sortItems,
  sortOptionsFor,
  type CollectionItem,
} from './filters';
import { resolveMetadata } from '@/lib/media-metadata';
import { genreRanksFor } from './genre-rank';
import { heroRankFor } from './hero-rank';

const item = (over: Partial<CollectionItem> = {}): CollectionItem => ({
  mediaItemId: 'a',
  title: 'Heat',
  seriesTitle: null,
  kind: 'movie',
  year: 1995,
  posterPath: null,
  genres: ['Crime'],
  language: 'en',
  runtimeMinutes: 170,
  score: 8.5,
  bucket: 'loved',
  watchedOn: '2026-01-02',
  ...over,
});

const ids = (rows: CollectionItem[]) => rows.map((row) => row.mediaItemId);

describe('one facet at a time', () => {
  const rows = [
    item({ mediaItemId: 'crime', genres: ['Crime', 'Drama'] }),
    item({ mediaItemId: 'comedy', genres: ['Comedy'] }),
    item({ mediaItemId: 'horror', genres: ['Horror'] }),
  ];

  it('ORs within a facet, because checkbox groups mean "any of"', () => {
    const rows2 = applyFilters(rows, { ...emptyFilters(), genres: ['Comedy', 'Horror'] });
    expect(ids(rows2)).toEqual(['comedy', 'horror']);
  });

  it('matches a title carrying any one of its several genres', () => {
    expect(ids(applyFilters(rows, { ...emptyFilters(), genres: ['Drama'] }))).toEqual(['crime']);
  });

  it('returns everything when nothing is selected', () => {
    expect(applyFilters(rows, emptyFilters())).toHaveLength(3);
  });
});

describe('several facets together', () => {
  const rows = [
    item({ mediaItemId: 'a', genres: ['Drama'], language: 'en', year: 2021, bucket: 'loved' }),
    item({ mediaItemId: 'b', genres: ['Drama'], language: 'ja', year: 2021, bucket: 'fine' }),
    item({ mediaItemId: 'c', genres: ['Comedy'], language: 'en', year: 1998, bucket: 'loved' }),
  ];

  it('ANDs between facets', () => {
    const filtered = applyFilters(rows, {
      ...emptyFilters(),
      genres: ['Drama'],
      languages: ['en'],
    });
    expect(ids(filtered)).toEqual(['a']);
  });

  it('combines decade and bucket', () => {
    const filtered = applyFilters(rows, {
      ...emptyFilters(),
      decades: ['2020s'],
      buckets: ['fine'],
    });
    expect(ids(filtered)).toEqual(['b']);
  });

  it('returns nothing when the combination matches nothing, rather than falling back', () => {
    const filtered = applyFilters(rows, {
      ...emptyFilters(),
      genres: ['Comedy'],
      decades: ['2020s'],
    });
    expect(filtered).toEqual([]);
  });

  it('clears back to everything', () => {
    expect(applyFilters(rows, emptyFilters())).toHaveLength(3);
    expect(isFiltered(emptyFilters())).toBe(false);
    // Anime is a genre, so Drama + Anime is one facet and counts once. It counted
    // twice while it was a facet of its own, under a section headed Type.
    expect(
      activeFilterCount({ ...emptyFilters(), genres: ['Drama', ANIME_GENRE] }),
    ).toBe(1);
    expect(
      activeFilterCount({ ...emptyFilters(), genres: ['Drama'], languages: ['ja'] }),
    ).toBe(2);
  });
});

describe('missing metadata', () => {
  it('excludes a title with no language when filtering by language', () => {
    const rows = [item({ mediaItemId: 'known' }), item({ mediaItemId: 'unknown', language: null })];
    expect(ids(applyFilters(rows, { ...emptyFilters(), languages: ['en'] }))).toEqual(['known']);
  });

  it('excludes a title with no year when filtering by decade', () => {
    const rows = [item({ mediaItemId: 'dated' }), item({ mediaItemId: 'undated', year: null })];
    expect(ids(applyFilters(rows, { ...emptyFilters(), decades: ['1990s'] }))).toEqual(['dated']);
  });

  it('excludes an unranked title when filtering by bucket', () => {
    const rows = [item({ mediaItemId: 'ranked' }), item({ mediaItemId: 'not', bucket: null })];
    expect(ids(applyFilters(rows, { ...emptyFilters(), buckets: ['loved'] }))).toEqual(['ranked']);
  });

  it('survives a title with no genres at all', () => {
    const rows = [item({ mediaItemId: 'bare', genres: [] })];
    expect(applyFilters(rows, { ...emptyFilters(), genres: ['Drama'] })).toEqual([]);
    expect(applyFilters(rows, emptyFilters())).toHaveLength(1);
  });
});

describe('anime as a facet, not a medium', () => {
  it('is Japanese and animated together', () => {
    expect(isAnime({ language: 'ja', genres: ['Animation'] })).toBe(true);
  });

  it('is not every Japanese film', () => {
    expect(isAnime({ language: 'ja', genres: ['Drama'] })).toBe(false);
  });

  it('is not every animated film', () => {
    expect(isAnime({ language: 'en', genres: ['Animation'] })).toBe(false);
  });

  it('matches the Wikidata genre vocabulary as well as TMDB’s', () => {
    // Seeded rows say "animated film" where TMDB says "Animation".
    expect(isAnime({ language: 'ja', genres: ['animated film'] })).toBe(true);
  });

  it('layers over both movies and seasons, and is never a medium of its own', () => {
    // **Movies and TV are the only media types.** Anime is a facet over them: the medium
    // comes from the tab outside the sheet, so Movies + Anime is anime films and
    // TV + Anime is anime seasons, and nothing in `applyFilters` knows which it is
    // looking at. Both halves are asserted here on one call because that is the shape
    // the screens use.
    const rows = [
      item({ mediaItemId: 'film', kind: 'movie', language: 'ja', genres: ['Animation'] }),
      item({ mediaItemId: 'season', kind: 'season', language: 'ja', genres: ['Animation'] }),
      item({ mediaItemId: 'other', kind: 'movie', language: 'en', genres: ['Animation'] }),
    ];

    const anime = applyFilters(rows, { ...emptyFilters(), genres: [ANIME_GENRE] });
    expect(ids(anime)).toEqual(['film', 'season']);
    // Movies + Anime, as the Collection tab composes it.
    expect(ids(anime.filter((row) => row.kind === 'movie'))).toEqual(['film']);
    // TV + Anime, likewise.
    expect(ids(anime.filter((row) => row.kind === 'season'))).toEqual(['season']);
  });

  it('is not all Animation, which is the whole point of the definition', () => {
    // Widening to every animated title would sweep in Pixar and Disney, which is the
    // failure the language half exists to prevent. `isAnime` is untouched by the move
    // out of Type and this is what says so.
    const rows = [
      item({ mediaItemId: 'ja-animated', language: 'ja', genres: ['Animation'] }),
      item({ mediaItemId: 'pixar', language: 'en', genres: ['Animation', 'Family'] }),
      item({ mediaItemId: 'ja-live', language: 'ja', genres: ['Drama'] }),
    ];

    expect(ids(applyFilters(rows, { ...emptyFilters(), genres: [ANIME_GENRE] }))).toEqual([
      'ja-animated',
    ]);
    expect(isAnime(rows[1]!)).toBe(false);
    expect(isAnime(rows[2]!)).toBe(false);
  });

  it('unions with its neighbours, because that is what a genre does', () => {
    // The one behaviour the move changed. As a separate facet it was AND-ed with the
    // genres — Anime + Comedy meant anime comedies. Inside the Genre facet it is OR-ed
    // like every other entry, because one checkbox behaving as an intersection while
    // its neighbours behave as a union is a rule nobody can see.
    const rows = [
      item({ mediaItemId: 'anime', language: 'ja', genres: ['Animation'] }),
      item({ mediaItemId: 'comedy', language: 'en', genres: ['Comedy'] }),
      item({ mediaItemId: 'neither', language: 'en', genres: ['Drama'] }),
    ];

    expect(ids(applyFilters(rows, { ...emptyFilters(), genres: [ANIME_GENRE, 'Comedy'] }))).toEqual([
      'anime',
      'comedy',
    ]);
  });
});

describe('filtering by a person', () => {
  const rows = [item({ mediaItemId: 'a' }), item({ mediaItemId: 'b' })];
  const cast = new Map([['a', new Set(['6193'])]]);

  it('keeps only the titles that credit them', () => {
    expect(ids(applyFilters(rows, { ...emptyFilters(), personId: '6193' }, cast))).toEqual(['a']);
  });

  it('excludes a title whose credits were never cached, rather than guessing', () => {
    // "Not in the cast" and "we have never looked" are different facts, and only
    // one of them is knowable.
    expect(applyFilters(rows, { ...emptyFilters(), personId: '6193' }, new Map())).toEqual([]);
  });
});

describe('the options offered', () => {
  const rows = [
    item({ genres: ['Drama', 'Crime'], language: 'en', year: 2021 }),
    item({ genres: ['Drama'], language: 'ja', year: 1985 }),
  ];

  it('offers only what the collection actually contains', () => {
    const options = facetOptions(rows);
    expect(options.genres.map((g) => g.value)).toEqual(['Crime', 'Drama']);
    expect(options.languages.map((l) => l.value).sort()).toEqual(['en', 'ja']);
  });

  it('keeps the count beside the option it belongs to, not beside its neighbour', () => {
    // The ordering change is where a count and a label come apart, and a filter that
    // says "Crime 2" and returns one film is worse than one that is unsorted.
    const options = facetOptions(rows);
    expect(options.genres).toEqual([
      { value: 'Crime', count: 1 },
      { value: 'Drama', count: 2 },
    ]);
  });

  it('orders genres alphabetically rather than by count', () => {
    // Founder, 2026-08-30. By count, the position of an option moved every time
    // something was logged, so a reader had to re-scan a section to find an entry they
    // already knew was in it. Crime has one title here and Drama has two.
    const options = facetOptions([
      item({ genres: ['Western'], language: 'en' }),
      item({ genres: ['Action', 'Western'], language: 'en' }),
      item({ genres: ['Action', 'Western'], language: 'en' }),
      item({ genres: ['Comedy', 'Western'], language: 'en' }),
    ]);
    expect(options.genres.map((g) => g.value)).toEqual(['Action', 'Comedy', 'Western']);
    // Western is first by count and last by name, which is what makes this a real test.
    expect(options.genres.at(-1)).toEqual({ value: 'Western', count: 4 });
  });

  it('places Anime alphabetically among the genres, like any other entry', () => {
    // It is a genre now, so it takes part in the alphabet rather than being pinned
    // anywhere. Between Action and Comedy, and after Animation where both exist.
    const options = facetOptions([
      item({ mediaItemId: 'a', genres: ['Western'], language: 'en' }),
      item({ mediaItemId: 'b', genres: ['Action'], language: 'en' }),
      item({ mediaItemId: 'c', genres: ['Anime'], language: 'ja' }),
      item({ mediaItemId: 'd', genres: ['Animation'], language: 'en' }),
      item({ mediaItemId: 'e', genres: ['Comedy'], language: 'en' }),
    ]);
    expect(options.genres.map((g) => g.value)).toEqual([
      'Action',
      'Animation',
      'Anime',
      'Comedy',
      'Western',
    ]);
  });

  it('orders languages by the English word the sheet draws, not by the ISO code', () => {
    // `el` sorts under E and Greek under G. The reader is looking at the word, so
    // the word is what decides — and the sheet's own fallback for an unknown code is
    // repeated in the sort key, so a label and its position cannot disagree.
    const options = facetOptions([
      item({ mediaItemId: 'a', language: 'ja', genres: ['Drama'] }),
      item({ mediaItemId: 'b', language: 'el', genres: ['Drama'] }),
      item({ mediaItemId: 'c', language: 'en', genres: ['Drama'] }),
      item({ mediaItemId: 'd', language: 'ko', genres: ['Drama'] }),
    ]);
    // English, Greek, Japanese, Korean.
    expect(options.languages.map((l) => l.value)).toEqual(['en', 'el', 'ja', 'ko']);
  });

  it('keeps decades in calendar order, oldest first', () => {
    // A decade list that reorders itself as the collection grows is unreadable, and
    // ascending since 2026-08-30: a decade list is a timeline and a timeline starts at
    // the beginning (founder).
    expect(facetOptions(rows).decades.map((d) => d.value)).toEqual(['earlier', '2020s']);

    const spread = facetOptions([
      item({ mediaItemId: 'a', year: 2021, genres: ['Drama'], language: 'en' }),
      item({ mediaItemId: 'b', year: 1975, genres: ['Drama'], language: 'en' }),
      item({ mediaItemId: 'c', year: 2015, genres: ['Drama'], language: 'en' }),
      item({ mediaItemId: 'd', year: 1994, genres: ['Drama'], language: 'en' }),
      item({ mediaItemId: 'e', year: 2003, genres: ['Drama'], language: 'en' }),
    ]);
    expect(spread.decades.map((d) => d.value)).toEqual([
      'earlier',
      '1990s',
      '2000s',
      '2010s',
      '2020s',
    ]);
  });

  it('gives the same order twice for the same rows, whatever order they arrive in', () => {
    // The founder checks this by eye across two visits to the sheet. The comparison is
    // deliberately not `localeCompare` — see `compareLabels` — so Hermes, Node and a
    // browser cannot disagree about it.
    const forwards = [
      item({ mediaItemId: 'a', genres: ['Drama', 'Crime'], language: 'en', year: 2021 }),
      item({ mediaItemId: 'b', genres: ['Action'], language: 'ja', year: 1985 }),
    ];
    const backwards = [...forwards].reverse();
    expect(facetOptions(forwards)).toEqual(facetOptions(backwards));
  });

  it('offers Anime among the genres, and only when there is any', () => {
    // It is an option in the Genre list now rather than a section of its own headed
    // Type, so this is where it has to appear — and a collection with no anime in it
    // must not offer it, exactly as an absent genre is not offered.
    expect(facetOptions(rows).genres.map((g) => g.value)).not.toContain(ANIME_GENRE);

    const withAnime = facetOptions([
      item({ language: 'ja', genres: ['Animation'] }),
      item({ language: 'en', genres: ['Comedy'] }),
    ]);
    expect(withAnime.genres).toContainEqual({ value: ANIME_GENRE, count: 1 });
  });

  it('counts Anime by the predicate, never by a label on a row', () => {
    // A row carrying a literal "Anime" label would otherwise contribute a count the
    // filter's own predicate disagrees with, and an option whose number does not match
    // what selecting it returns is worse than an option that is missing.
    const mislabelled = item({ mediaItemId: 'mislabelled', language: 'en', genres: ['Anime'] });
    const real = item({ mediaItemId: 'real', language: 'ja', genres: ['Animation'] });

    const options = facetOptions([mislabelled, real]);
    expect(options.genres).toContainEqual({ value: ANIME_GENRE, count: 1 });
    expect(ids(applyFilters([mislabelled, real], { ...emptyFilters(), genres: [ANIME_GENRE] }))).toEqual(
      ['real'],
    );
  });
});

describe('decades', () => {
  it.each([
    [2026, '2020s'],
    [2020, '2020s'],
    [2019, '2010s'],
    [2000, '2000s'],
    [1990, '1990s'],
    [1989, 'earlier'],
  ])('puts %s in %s', (year, decade) => {
    expect(decadeOf(year)).toBe(decade);
  });

  it('has no decade for an undated title', () => {
    expect(decadeOf(null)).toBeNull();
  });
});

describe('sorting', () => {
  const rows = [
    item({ mediaItemId: 'mid', title: 'Beta', score: 5, year: 2005, watchedOn: '2026-02-01' }),
    item({ mediaItemId: 'high', title: 'Alpha', score: 9, year: 2021, watchedOn: '2026-01-01' }),
    item({ mediaItemId: 'none', title: 'Zeta', score: null, year: 1990, watchedOn: null }),
  ];

  it('orders by score, high first, with unranked last', () => {
    expect(ids(sortItems(rows, 'score-desc'))).toEqual(['high', 'mid', 'none']);
  });

  it('orders by score, low first, still with unranked last', () => {
    // Unranked sinks in *both* directions: it has no score to be low.
    expect(ids(sortItems(rows, 'score-asc'))).toEqual(['mid', 'high', 'none']);
  });

  it('orders by watch date, undated last', () => {
    expect(ids(sortItems(rows, 'recent'))).toEqual(['mid', 'high', 'none']);
  });

  it('orders by year both ways', () => {
    expect(ids(sortItems(rows, 'year-desc'))).toEqual(['high', 'mid', 'none']);
    expect(ids(sortItems(rows, 'year-asc'))).toEqual(['none', 'mid', 'high']);
  });

  it('orders A–Z on what the reader sees', () => {
    expect(ids(sortItems(rows, 'az'))).toEqual(['high', 'mid', 'none']);
  });

  it('sorts a season under its show, not under "Season"', () => {
    const seasons = [
      item({ mediaItemId: 'z', title: 'Season 1', seriesTitle: 'Zodiac' }),
      item({ mediaItemId: 'a', title: 'Season 9', seriesTitle: 'Alpha House' }),
    ];
    expect(ids(sortItems(seasons, 'az'))).toEqual(['a', 'z']);
  });

  it('does not mutate the array it was given', () => {
    const original = [...rows];
    sortItems(rows, 'az');
    expect(rows).toEqual(original);
  });
});

describe('shuffle stability', () => {
  const rows = Array.from({ length: 20 }, (_, i) => item({ mediaItemId: `m${i}` }));

  it('gives the same order for the same seed, every time', () => {
    // The defect the brief names: an order that changes on every render or
    // refetch. Same seed, same rows, same order.
    expect(ids(sortItems(rows, 'shuffle', 7))).toEqual(ids(sortItems(rows, 'shuffle', 7)));
  });

  it('gives a different order for a different seed', () => {
    expect(ids(sortItems(rows, 'shuffle', 1))).not.toEqual(ids(sortItems(rows, 'shuffle', 2)));
  });

  it('keeps every title, losing and duplicating none', () => {
    const shuffled = ids(sortItems(rows, 'shuffle', 3));
    expect(shuffled.sort()).toEqual(ids(rows).sort());
  });

  it('is a no-op on an empty or single-item collection', () => {
    expect(shuffle([], 5)).toEqual([]);
    expect(shuffle(['only'], 5)).toEqual(['only']);
  });
});

describe('which sorts are offered', () => {
  it('hides score and watch-date orders on a watchlist, where both are always null', () => {
    const keys = sortOptionsFor('watchlist').map((option) => option.key);
    expect(keys).not.toContain('score-desc');
    expect(keys).not.toContain('recent');
    expect(keys).toContain('shuffle');
  });

  it('offers them on a watched list', () => {
    const keys = sortOptionsFor('watched').map((option) => option.key);
    expect(keys).toContain('score-desc');
    expect(keys).toContain('recent');
  });
});

/**
 * **One title, one genre list, on every surface that names one.**
 *
 * The founder's report was a divergence rather than a single wrong label: the collection
 * filter had offered Anime since 2026-08-29 and the title page still printed TMDB's
 * `Animation`, so filtering to Anime and opening a result contradicted the filter that
 * found it. Fixing the pill alone would have moved the seam rather than closed it —
 * Animation would still have matched the same title, the counts would still have been
 * computed one way and the labels drawn another, and the genre ranks under a reveal
 * would still have said Animation.
 *
 * So these start from `resolveMetadata` — the shared read every genre-bearing query
 * goes through — and follow one anime title into the filter, into the counts, and into
 * the two ranking surfaces. What is being asserted is **agreement**, not any one label.
 */
describe('the same genre downstream of the shared resolver', () => {
  /** A collection row exactly as `use-collection` builds one, resolver included. */
  const resolved = (
    mediaItemId: string,
    raw: string[],
    language: string | null,
    over: Partial<CollectionItem> = {},
  ): CollectionItem => {
    const meta = resolveMetadata({
      kind: 'movie',
      genres: raw,
      original_language: language,
      parent: null,
    });
    return item({ mediaItemId, genres: meta.genres, language: meta.language, ...over });
  };

  const cowboyBebop = resolved('bebop', ['Animation', 'Action'], 'ja');
  const toyStory = resolved('toy-story', ['Animation', 'Family'], 'en');
  const ikiru = resolved('ikiru', ['Drama'], 'ja');

  it('gives the title page Anime where the filter offers Anime', () => {
    // The pill and the filter entry are now the same string from the same resolver, so
    // there is nothing left to keep in step by hand.
    expect(cowboyBebop.genres).toContain(ANIME_GENRE);
    expect(cowboyBebop.genres).not.toContain('Animation');
    expect(toyStory.genres).toEqual(['Animation', 'Family']);
    expect(ikiru.genres).toEqual(['Drama']);
  });

  it('returns exactly the titles the Anime count promised', () => {
    // An option whose number does not match what selecting it returns is worse than an
    // option that is missing, and this is the pair that could come apart: the count is
    // computed by the predicate and the results by the label.
    const rows = [cowboyBebop, toyStory, ikiru];
    const option = facetOptions(rows).genres.find((g) => g.value === ANIME_GENRE);

    expect(option?.count).toBe(1);
    expect(
      applyFilters(rows, { ...emptyFilters(), genres: [ANIME_GENRE] }).map((r) => r.mediaItemId),
    ).toEqual(['bebop']);
    expect(option?.count).toBe(
      applyFilters(rows, { ...emptyFilters(), genres: [ANIME_GENRE] }).length,
    );
  });

  it('reserves Animation for animated titles that are not anime', () => {
    // The other half of the partition, and the founder's explicit pin. Filtering to
    // Animation must no longer return the anime it used to.
    const rows = [cowboyBebop, toyStory, ikiru];
    expect(
      applyFilters(rows, { ...emptyFilters(), genres: ['Animation'] }).map((r) => r.mediaItemId),
    ).toEqual(['toy-story']);

    const option = facetOptions(rows).genres.find((g) => g.value === 'Animation');
    expect(option?.count).toBe(1);
  });

  it('never offers a title under both labels', () => {
    // The visible symptom the founder photographed: `Animation · Anime` on one row.
    for (const row of [cowboyBebop, toyStory, ikiru]) {
      const both = row.genres.includes('Animation') && row.genres.includes(ANIME_GENRE);
      expect(both).toBe(false);
    }
  });

  it('labels a genre rank Anime, because it ranks over the same list', () => {
    // `genreRanksFor` reads `genres` off the ranked rows, which come through the same
    // resolver — so a reveal that said "#2 Animation" under a title page that said
    // Anime is not a second place to fix, it is the same list read twice.
    const ranked = Array.from({ length: 6 }, (_, index) =>
      resolved(index === 1 ? 'bebop' : `anime-${index}`, ['Animation', 'Action'], 'ja'),
    ).map((row, index) => ({
      mediaItemId: row.mediaItemId,
      position: index + 1,
      genres: row.genres,
    }));

    const ranks = genreRanksFor('bebop', ranked, 5);
    expect(ranks.map((r) => r.genre)).toContain(ANIME_GENRE);
    expect(ranks.map((r) => r.genre)).not.toContain('Animation');
  });

  it('puts Anime in the hero line for a top-ten genre placement', () => {
    // The title page's own "#3 in ..." line, which is the last genre-bearing surface
    // and the one a reader meets after tapping a filter result.
    const ranked = [
      ...Array.from({ length: 12 }, (_, index) => ({
        mediaItemId: `filler-${index}`,
        position: index + 1,
        genres: ['Drama'],
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        mediaItemId: index === 2 ? 'bebop' : `anime-${index}`,
        position: 13 + index,
        // Animation alone, so Anime is the only genre that qualifies: `heroRankFor`
        // breaks a tie on the genre name ascending, and Action would win it.
        genres: resolved(`x-${index}`, ['Animation'], 'ja').genres,
      })),
    ];

    expect(heroRankFor('bebop', ranked, 'movies')?.label).toBe(`#3 in ${ANIME_GENRE}`);
  });
});
