/**
 * A SYNTHETIC IMDb ratings export. Nothing here is anybody's history.
 *
 * The header is IMDb's real 14-column ratings schema, in IMDb's order. Every row is
 * invented: the titles are made up, the `tt9…` ids are fabricated, and the ratings and dates
 * are arbitrary. It exists because the one real sample the founder has belongs to somebody
 * else and must never be committed (spec §3).
 *
 * What it covers, by row:
 *
 *   tt9000001  Movie, with a comma and a quote in a quoted title, and an Original Title
 *   tt9000002  TV Series
 *   tt9000003  TV Mini Series
 *   tt9000004  TV Episode                                       -> unsupported
 *   tt9000005  Short
 *   tt9000006  Video
 *   tt9000007  TV Movie
 *   tt9000008  TV Special
 *   tt9000009  Video Game                                       -> unsupported
 *   tt9000010  Movie with no Year and no optional fields
 *   tt9000001  a DUPLICATE Const                                -> folded into the first
 *   tt9000011  Movie whose rating is 11                         -> kept, unrated
 *   nm0000001  a name id, not a title id                        -> invalid id
 *   tt9000012  a ragged row (an unquoted comma shifted it)      -> malformed
 *   tt9000013  Movie with an empty Title                        -> malformed
 *   tt9000014  TV Series with no Year (a show IMDb has undated)
 *
 * CRLF line endings and a UTF-8 BOM, as a spreadsheet re-save produces.
 */
export const IMDB_HEADER =
  'Const,Your Rating,Date Rated,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors';

const rows = [
  'tt9000001,9,2024-03-01,"The Lantern, the ""Keeper"" and the Sea","La Lanterne",https://www.imdb.com/title/tt9000001/,Movie,7.8,121,1998,"Drama, Mystery",120345,1998-05-14,"Ada Example, Bo Sample"',
  'tt9000002,8,2023-11-20,Harbour Lights,Harbour Lights,https://www.imdb.com/title/tt9000002/,TV Series,8.4,52,2011,"Crime, Drama",88000,2011-02-02,',
  'tt9000003,10,2023-11-21,Seven Winters,Seven Winters,https://www.imdb.com/title/tt9000003/,TV Mini Series,9.0,60,2019,Drama,45000,2019-04-04,',
  'tt9000004,7,2023-11-22,Harbour Lights: Pilot,Harbour Lights: Pilot,https://www.imdb.com/title/tt9000004/,TV Episode,8.1,55,2011,"Crime, Drama",5000,2011-02-02,Cy Placeholder',
  'tt9000005,6,2022-01-05,Paper Birds,Paper Birds,https://www.imdb.com/title/tt9000005/,Short,7.0,12,2015,Animation,900,2015-06-01,Di Invented',
  'tt9000006,5,2022-01-06,Live at the Old Mill,Live at the Old Mill,https://www.imdb.com/title/tt9000006/,Video,6.5,95,2008,Music,300,2008-09-09,Ed Madeup',
  'tt9000007,7,2022-01-07,A Quiet Christmas,A Quiet Christmas,https://www.imdb.com/title/tt9000007/,TV Movie,6.1,88,2016,"Drama, Family",2500,2016-12-20,Flo Fiction',
  'tt9000008,8,2022-01-08,The Midnight Revue,The Midnight Revue,https://www.imdb.com/title/tt9000008/,TV Special,7.3,70,2020,Comedy,1200,2020-12-31,Gus Pretend',
  'tt9000009,9,2022-01-09,Starfall Quest,Starfall Quest,https://www.imdb.com/title/tt9000009/,Video Game,8.8,,2021,Adventure,15000,2021-03-03,',
  'tt9000010,4,2021-05-05,Untitled Fog Project,,https://www.imdb.com/title/tt9000010/,Movie,,,,,,,',
  'tt9000001,9,2024-03-02,"The Lantern, the ""Keeper"" and the Sea","La Lanterne",https://www.imdb.com/title/tt9000001/,Movie,7.8,121,1998,"Drama, Mystery",120345,1998-05-14,"Ada Example, Bo Sample"',
  'tt9000011,11,2021-05-06,Too Loud,Too Loud,https://www.imdb.com/title/tt9000011/,Movie,5.0,90,2003,Comedy,700,2003-08-08,Hal Unreal',
  'nm0000001,8,2021-05-07,Somebody,Somebody,https://www.imdb.com/name/nm0000001/,Movie,7.0,100,2000,Drama,100,2000-01-01,',
  'tt9000012,8,2021-05-08,Shifted, Row,Shifted Row,https://www.imdb.com/title/tt9000012/,Movie,7.0,100,2000,Drama,100,2000-01-01,',
  'tt9000013,8,2021-05-09,,,https://www.imdb.com/title/tt9000013/,Movie,7.0,100,2000,Drama,100,2000-01-01,',
  'tt9000014,7,2021-05-10,The Long Valley,The Long Valley,https://www.imdb.com/title/tt9000014/,TV Series,7.7,45,,Western,3000,,',
];

export const IMDB_SYNTHETIC_CSV = `﻿${[IMDB_HEADER, ...rows].join('\r\n')}\r\n`;

/** As bytes, the way the picker hands them over. */
export const imdbSyntheticBytes = (csv: string = IMDB_SYNTHETIC_CSV): Uint8Array =>
  new TextEncoder().encode(csv);

/** A large synthetic export: `n` invented movies and one show in ten. */
export function largeImdbCsv(n: number): string {
  const out = [IMDB_HEADER];
  for (let i = 0; i < n; i += 1) {
    const id = `tt${String(90000000 + i)}`;
    const show = i % 10 === 0;
    out.push(
      `${id},${(i % 10) + 1},2020-01-01,"Synthetic Title ${i}, Part ${i % 7}",,https://www.imdb.com/title/${id}/,${show ? 'TV Series' : 'Movie'},7.0,100,${1950 + (i % 70)},Drama,10,,`,
    );
  }
  return out.join('\n');
}
