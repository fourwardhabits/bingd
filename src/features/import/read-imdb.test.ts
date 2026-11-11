import { strToU8, zipSync } from 'fflate';

import {
  IMDB_HEADER,
  IMDB_SYNTHETIC_CSV,
  imdbSyntheticBytes,
} from './__fixtures__/imdb-synthetic';
import { readImdbCsv } from './read-imdb';

const NOW = new Date('2026-11-11T12:00:00Z');
const read = (csv: string) => readImdbCsv(imdbSyntheticBytes(csv), { now: NOW });

describe('readImdbCsv', () => {
  it('previews the synthetic export, ready to send', () => {
    const result = read(IMDB_SYNTHETIC_CSV);
    if (!result.ok) throw new Error(result.reason);
    expect(result.preview.provider).toBe('imdb');
    expect(result.preview.rows).toHaveLength(12);
    expect(result.preview.pages).toHaveLength(1);
  });

  it('says a ZIP is a ZIP: the Letterboxd export picked on the IMDb screen', () => {
    const zip = zipSync({ 'watched.csv': strToU8('Date,Name,Year\n') });
    expect(readImdbCsv(zip)).toEqual({ ok: false, reason: 'is_zip' });
  });

  it('refuses a CSV that is not an IMDb ratings export', () => {
    expect(
      read('Date,Name,Year,Letterboxd URI\n2020-01-01,Heat,1995,https://boxd.it/x\n'),
    ).toEqual({
      ok: false,
      reason: 'not_imdb',
    });
  });

  it('refuses an IMDb watchlist export, which is not history', () => {
    const watchlist =
      'Position,Const,Created,Modified,Description,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors,Your Rating,Date Rated\n' +
      '1,tt9100001,2024-01-01,2024-01-01,,Wanted,Wanted,https://x,Movie,7,100,2001,Drama,1,,,,\n';
    expect(read(watchlist)).toEqual({ ok: false, reason: 'imdb_list' });
  });

  it('says a real export with nothing in it is empty', () => {
    expect(read(`${IMDB_HEADER}\n`)).toEqual({ ok: false, reason: 'empty' });
  });

  it('says a file of only episodes has nothing bingd can bring in', () => {
    const csv = `${IMDB_HEADER}\ntt9200001,8,2020-01-01,Pilot,,https://x,TV Episode,7,40,2010,Drama,1,,\n`;
    expect(read(csv)).toEqual({ ok: false, reason: 'nothing_supported' });
  });

  it('reads binary noise as not IMDb rather than throwing', () => {
    expect(readImdbCsv(new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x02]))).toEqual({
      ok: false,
      reason: 'not_imdb',
    });
  });
});
