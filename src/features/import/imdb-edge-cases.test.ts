import { IMDB_HEADER, imdbSyntheticBytes, largeImdbCsv } from './__fixtures__/imdb-synthetic';
import { normaliseImdb } from './imdb';
import { buildImdbOutcomes } from './outcomes';
import {
  imdbStagingRows,
  MAX_JOB_ROWS,
  MAX_PAGE_BYTES,
  MAX_PAGE_ROWS,
  pageBytes,
} from './payload';
import { readImdbCsv } from './read-imdb';

/**
 * The files people actually pick, at the edges: what the reader keeps, what it drops and
 * counts, and that nothing in one row can fail the file. And the property the server's
 * idempotency rests on: the same file reads to the same rows, every time.
 *
 * The server half of "the same file twice adds nothing" and "Letterboxd and IMDb are one
 * collection row" is `supabase/tests/import-imdb.test.mjs` (the same file twice; two Consts
 * one title; Letterboxd then IMDb; IMDb then Letterboxd).
 */

const NOW = new Date('2026-11-13T12:00:00Z');

/** One IMDb ratings row: all 14 columns, in IMDb's order, any of them overridable. */
const line = (over: Partial<Record<string, string>> = {}) => {
  const cells: Record<string, string> = {
    Const: 'tt9100001',
    'Your Rating': '8',
    'Date Rated': '2024-01-01',
    Title: 'Plain Film',
    'Original Title': 'Plain Film',
    URL: 'https://www.imdb.com/title/tt9100001/',
    'Title Type': 'Movie',
    'IMDb Rating': '7.0',
    'Runtime (mins)': '100',
    Year: '2001',
    Genres: 'Drama',
    'Num Votes': '10',
    'Release Date': '2001-01-01',
    Directors: '',
    ...over,
  };
  return IMDB_HEADER.split(',')
    .map((column) => cells[column] ?? '')
    .join(',');
};

const csv = (...rows: string[]) => [IMDB_HEADER, ...rows].join('\n');

const read = (text: string) => {
  const result = normaliseImdb(text, { now: NOW });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.normalised;
};

describe('a malformed row costs that row, never the file', () => {
  it('drops a row with no Const, and counts it', () => {
    const { titles, counts } = read(csv(line({ Const: '' }), line({ Const: 'tt9100002' })));
    expect(titles.map((t) => t.imdbId)).toEqual(['tt9100002']);
    expect(counts.invalidIds).toBe(1);
  });

  it('keeps a title whose year is nonsense, without a year', () => {
    const { titles } = read(
      csv(
        line({ Const: 'tt9100001', Year: '20O1' }),
        line({ Const: 'tt9100002', Year: '1066' }),
        line({ Const: 'tt9100003', Year: '2099' }),
        line({ Const: 'tt9100004', Year: '' }),
      ),
    );
    expect(titles.map((t) => t.year)).toEqual([null, null, null, null]);
  });

  it('drops a row with an extra column and a row with a missing one: either may be shifted', () => {
    const { titles, counts } = read(
      csv(
        `${line({ Const: 'tt9100001' })},surplus`,
        line({ Const: 'tt9100002' }).split(',').slice(0, -2).join(','),
        line({ Const: 'tt9100003' }),
      ),
    );
    expect(titles.map((t) => t.imdbId)).toEqual(['tt9100003']);
    expect(counts.malformed).toBe(2);
  });

  it('reads a BOM and CRLF as a spreadsheet re-save writes them', () => {
    const text = `﻿${[IMDB_HEADER, line()].join('\r\n')}\r\n`;
    const { titles } = read(text);
    expect(titles).toHaveLength(1);
    expect(titles[0]).toMatchObject({ imdbId: 'tt9100001', name: 'Plain Film', year: 2001 });
  });

  it('keeps commas and quotes inside a quoted title', () => {
    const { titles } = read(csv(line({ Title: '"One, Two and ""Three"""' })));
    expect(titles[0]?.name).toBe('One, Two and "Three"');
  });

  it('folds duplicate tt ids into the first, so the server is sent each once', () => {
    const { titles, counts } = read(
      csv(
        line({ Const: 'tt9100001', Title: 'First' }),
        line({ Const: 'tt9100001', Title: 'Second' }),
        line({ Const: 'tt9100001', Title: 'Third' }),
      ),
    );
    expect(titles.map((t) => t.name)).toEqual(['First']);
    expect(counts.duplicates).toBe(2);
    const staged = imdbStagingRows(read(csv(line(), line(), line())));
    expect(new Set(staged.map((r) => r.correlation)).size).toBe(staged.length);
  });
});

describe('a file that is not a file of history', () => {
  it('says an empty file is not an IMDb export', () => {
    expect(readImdbCsv(new Uint8Array(0), { now: NOW })).toEqual({
      ok: false,
      reason: 'not_imdb',
    });
  });

  it('says a header with no rows is a real, empty export', () => {
    expect(readImdbCsv(imdbSyntheticBytes(`${IMDB_HEADER}\r\n`), { now: NOW })).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it('refuses a CSV from somewhere else, Letterboxd included', () => {
    for (const text of [
      'Date,Name,Year,Letterboxd URI\n2024-01-01,Heat,1995,https://boxd.it/x\n',
      'title,year\nHeat,1995\n',
    ]) {
      expect(readImdbCsv(imdbSyntheticBytes(text), { now: NOW })).toEqual({
        ok: false,
        reason: 'not_imdb',
      });
    }
  });
});

describe('a very large file', () => {
  it('reads fifty thousand rows, in bounded pages, as the server will take them', () => {
    // MAX_JOB_ROWS exactly: the largest file the client will send.
    const result = readImdbCsv(imdbSyntheticBytes(largeImdbCsv(MAX_JOB_ROWS)), { now: NOW });
    if (!result.ok) throw new Error(result.reason);
    expect(result.preview.rows).toHaveLength(MAX_JOB_ROWS);
    for (const page of result.preview.pages) {
      expect(page.length).toBeLessThanOrEqual(MAX_PAGE_ROWS);
      expect(pageBytes(page)).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    }
  }, 30_000);

  it('refuses one row more, before anything is sent', () => {
    expect(
      readImdbCsv(imdbSyntheticBytes(largeImdbCsv(MAX_JOB_ROWS + 1)), { now: NOW }),
    ).toEqual({ ok: false, reason: 'too_many_films' });
  }, 30_000);

  it('builds a 5,000-show summary list without an accidental quadratic', () => {
    const titles = read(largeImdbCsv(50_000)).titles;
    const started = Date.now();
    const sections = buildImdbOutcomes({
      counts: { unmatched: 0, unsupported: 5_000, unsupported_tv: 5_000 },
      session: titles,
      unresolved: { state: 'ready', rows: [] },
    });
    expect(sections[0]?.titles).toHaveLength(5_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 30_000);
});

describe('the same file twice', () => {
  it('reads to identical rows and pages, so a re-post is free and a re-import adds nothing', () => {
    // `import_rows_once` is keyed on (job, kind, correlation), and the correlation is the
    // tt id; the server dedupes the collection on (user, title). Both rest on this.
    const bytes = imdbSyntheticBytes();
    const first = readImdbCsv(bytes, { now: NOW });
    const second = readImdbCsv(imdbSyntheticBytes(), { now: NOW });
    if (!first.ok || !second.ok) throw new Error('fixture did not read');
    expect(second.preview.pages).toEqual(first.preview.pages);
    expect(first.preview.rows.map((r) => r.correlation)).toEqual(
      first.preview.rows.map((r) => r.imdbId),
    );
  });

  it('never sends a watch date or a rating for anything but a movie, whichever time it is', () => {
    const result = readImdbCsv(imdbSyntheticBytes(), { now: NOW });
    if (!result.ok) throw new Error(result.reason);
    for (const row of result.preview.rows) {
      expect(row).not.toHaveProperty('watchedOn');
      expect(row).not.toHaveProperty('dateRated');
      if ('imdbRating' in row)
        expect(['tvseries', 'tvminiseries', 'tvepisode']).not.toContain(row.titleType);
    }
  });
});
