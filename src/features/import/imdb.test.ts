import {
  IMDB_HEADER,
  IMDB_SYNTHETIC_CSV,
  imdbSyntheticBytes,
  largeImdbCsv,
} from './__fixtures__/imdb-synthetic';
import { imdbKind, imdbTitleType, normaliseImdb, recogniseImdb } from './imdb';
import { imdbStagingRows, MAX_PAGE_BYTES, MAX_PAGE_ROWS, pageBytes } from './payload';
import { readImdbCsv } from './read-imdb';

const NOW = new Date('2026-11-11T12:00:00Z');

const normalised = (csv: string) => {
  const result = normaliseImdb(csv, { now: NOW });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.normalised;
};

const byId = (csv: string) => new Map(normalised(csv).titles.map((t) => [t.imdbId, t]));

describe('recognising the file', () => {
  it('accepts the exact ratings columns', () => {
    expect(recogniseImdb(IMDB_HEADER.split(','))).toBe('ratings');
  });

  it('refuses a list or watchlist export rather than reading it as history', () => {
    const list = [
      'Position',
      'Const',
      'Created',
      'Modified',
      'Description',
      'Title',
      'URL',
      'Title Type',
      'IMDb Rating',
      'Year',
    ];
    expect(recogniseImdb(list)).toBe('imdb_list');
    // Newer list exports also carry the person's own rating; still a list.
    expect(recogniseImdb([...list, 'Your Rating', 'Date Rated'])).toBe('imdb_list');
  });

  it('refuses a Letterboxd CSV and anything else', () => {
    expect(recogniseImdb(['Date', 'Name', 'Year', 'Letterboxd URI', 'Rating'])).toBe(
      'not_imdb',
    );
    expect(recogniseImdb([])).toBe('not_imdb');
  });

  it('refuses a ratings-shaped file missing Your Rating', () => {
    expect(recogniseImdb(['Const', 'Title', 'Title Type', 'Year'])).toBe('not_imdb');
  });
});

describe('the synthetic export', () => {
  const titles = byId(IMDB_SYNTHETIC_CSV);
  const { counts } = normalised(IMDB_SYNTHETIC_CSV);

  it('strips the BOM, so the first column is Const and every row is read', () => {
    expect(titles.has('tt9000001')).toBe(true);
  });

  it('keeps commas and doubled quotes inside a quoted title', () => {
    expect(titles.get('tt9000001')!.name).toBe('The Lantern, the "Keeper" and the Sea');
    expect(titles.get('tt9000001')!.originalTitle).toBe('La Lanterne');
  });

  it('classifies every Title Type the founder sample holds', () => {
    expect(titles.get('tt9000001')!.kind).toBe('movie');
    expect(titles.get('tt9000002')!.kind).toBe('series');
    expect(titles.get('tt9000003')!.kind).toBe('series');
    expect(titles.get('tt9000004')!.kind).toBeNull();
    expect(titles.get('tt9000004')!.titleType).toBe('tvepisode');
    expect(titles.get('tt9000005')!.kind).toBe('movie');
    expect(titles.get('tt9000006')!.kind).toBe('movie');
    expect(titles.get('tt9000007')!.kind).toBe('movie');
    expect(titles.get('tt9000008')!.kind).toBe('movie');
    expect(titles.get('tt9000009')!.kind).toBeNull();
  });

  it('counts what it found, in the units the preview shows', () => {
    expect(counts).toEqual({
      titles: 12,
      // Lantern, Short, Video, TV Movie, TV Special, Fog, Too Loud
      movies: 7,
      tvShows: 3,
      episodes: 1,
      otherUnsupported: 1,
      // Every movie and show but Too Loud (11 is not a rating). The episode's and the
      // game's ratings are dropped, because nothing can use them.
      rated: 9,
      malformed: 2,
      invalidIds: 1,
      invalidRatings: 1,
      duplicates: 1,
      damaged: false,
    });
  });

  it('folds a duplicate Const into one title', () => {
    expect([...titles.keys()].filter((id) => id === 'tt9000001')).toHaveLength(1);
  });

  it('keeps a title with no year, and a title with no optional fields', () => {
    expect(titles.get('tt9000010')).toMatchObject({
      year: null,
      originalTitle: null,
      rating: 4,
    });
    expect(titles.get('tt9000014')).toMatchObject({ year: null, kind: 'series' });
  });

  it('keeps a title whose rating is invalid, unrated, rather than rounding it', () => {
    expect(titles.get('tt9000011')!.rating).toBeNull();
  });

  it('never reads Date Rated, the community IMDb Rating, or anything else', () => {
    for (const title of titles.values()) {
      expect(Object.keys(title).sort()).toEqual(
        ['imdbId', 'kind', 'name', 'originalTitle', 'rating', 'titleType', 'year'].sort(),
      );
    }
  });
});

describe('rows that cannot be read', () => {
  const csv = (...lines: string[]) => [IMDB_HEADER, ...lines].join('\n');
  const row = (constId: string, rating: string, title: string, type = 'Movie', year = '2001') =>
    `${constId},${rating},2020-01-01,${title},,https://x,${type},7,90,${year},Drama,1,,`;

  it('rejects ids that are not tt ids', () => {
    for (const bad of ['tt12', 'nm1234567', 'TT1234567', 'tt1234567x', '1234567']) {
      expect(normalised(csv(row(bad, '8', 'Film'))).counts.invalidIds).toBe(1);
    }
  });

  it('rejects ratings that are not whole numbers from one to ten, keeping the title', () => {
    for (const bad of ['0', '11', '7.5', '-3', 'ten']) {
      const { counts, titles } = normalised(csv(row('tt1234567', bad, 'Film')));
      expect(counts.invalidRatings).toBe(1);
      expect(titles[0]!.rating).toBeNull();
    }
  });

  it('treats an out-of-range or non-numeric year as missing', () => {
    expect(
      normalised(csv(row('tt1234567', '8', 'Film', 'Movie', '1700'))).titles[0]!.year,
    ).toBeNull();
    expect(
      normalised(csv(row('tt1234567', '8', 'Film', 'Movie', '2999'))).titles[0]!.year,
    ).toBeNull();
    expect(
      normalised(csv(row('tt1234567', '8', 'Film', 'Movie', '2008–2013'))).titles[0]!.year,
    ).toBeNull();
  });

  it('flags a file that ends inside an open quote', () => {
    expect(normalised(csv(row('tt1234567', '8', '"Unclosed'))).counts.damaged).toBe(true);
  });

  it('reads a later rating into a duplicate whose first row had none', () => {
    const { titles } = normalised(
      csv(row('tt1234567', '', 'Film'), row('tt1234567', '6', 'Film')),
    );
    expect(titles).toHaveLength(1);
    expect(titles[0]!.rating).toBe(6);
  });
});

describe('what crosses the wire', () => {
  const rows = imdbStagingRows(normalised(IMDB_SYNTHETIC_CSV));

  it('sends the id, title, year, type and own rating, and never the rest', () => {
    const lantern = rows.find((r) => r.imdbId === 'tt9000001')!;
    expect(lantern).toEqual({
      kind: 'watched',
      correlation: 'tt9000001',
      name: 'The Lantern, the "Keeper" and the Sea',
      originalTitle: 'La Lanterne',
      year: 1998,
      imdbId: 'tt9000001',
      titleType: 'movie',
      imdbRating: 9,
    });
  });

  it('sends no rating for a title bingd cannot place', () => {
    expect(rows.find((r) => r.imdbId === 'tt9000004')).not.toHaveProperty('imdbRating');
    expect(rows.find((r) => r.imdbId === 'tt9000009')).not.toHaveProperty('imdbRating');
  });

  it('omits an original title equal to the title', () => {
    expect(rows.find((r) => r.imdbId === 'tt9000002')).not.toHaveProperty('originalTitle');
  });
});

describe('a large export', () => {
  it('reads ten thousand titles into pages inside both server bounds', () => {
    const started = Date.now();
    const result = readImdbCsv(imdbSyntheticBytes(largeImdbCsv(10_000)), { now: NOW });
    const elapsed = Date.now() - started;
    if (!result.ok) throw new Error(result.reason);
    expect(result.preview.normalised.counts.movies).toBe(9_000);
    expect(result.preview.normalised.counts.tvShows).toBe(1_000);
    for (const page of result.preview.pages) {
      expect(page.length).toBeLessThanOrEqual(MAX_PAGE_ROWS);
      expect(pageBytes(page)).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    }
    // Not a benchmark; a guard against an accidentally quadratic parse.
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe('the type rule', () => {
  it('agrees with the server on every folded type', () => {
    expect(imdbKind(imdbTitleType('tvMiniSeries'))).toBe('series');
    expect(imdbKind(imdbTitleType('TV Short'))).toBe('movie');
    expect(imdbKind(imdbTitleType('Podcast Episode'))).toBeNull();
    expect(imdbTitleType('???')).toBe('other');
  });
});
