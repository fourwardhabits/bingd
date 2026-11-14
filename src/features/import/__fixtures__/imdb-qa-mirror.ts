/**
 * A SYNTHETIC 7-row mirror of the founder's IMDb QA file (IMP1113-UI, H1).
 *
 * The founder's QA CSV is somebody's real history and stays on the founder's machine; it is
 * never committed (`README.md`). This file has its SHAPE, by Title Type and by what the
 * server did with each row, and nothing else of it: every title is invented and every id is
 * a fabricated `tt91…`. The header is IMDb's real 14-column ratings schema (`IMDB_HEADER`).
 *
 *   tt9100001  Movie        new                          -> watched, then already
 *   tt9100002  Movie        new                          -> watched, then already
 *   tt9100003  Movie        new                          -> watched, then already
 *   tt9100004  Movie        already ranked in bingd      -> kept, both runs
 *   tt9100005  TV Series    recognised, not added        -> unsupported_tv
 *   tt9100006  TV Episode   bingd tracks no episodes     -> unsupported_episode
 *   tt9100007  Short        no confident match           -> unmatched
 *
 * `QA_MIRROR_FIRST` and `QA_MIRROR_REIMPORT` are the counts `_import_settle` reports for this
 * file against an account where tt9100004 is ranked: the first import, then the same file
 * again. `QA_MIRROR_BUCKETS` says which results bucket each row lands in on each run, so a
 * test can hold the model against the file row by row.
 */
import { IMDB_HEADER } from './imdb-synthetic';

const rows = [
  'tt9100001,8,2024-02-01,Lantern Harbour,Lantern Harbour,https://www.imdb.com/title/tt9100001/,Movie,7.1,104,2014,Drama,4100,2014-03-03,Ana Invented',
  'tt9100002,7,2024-02-02,Paper Comet,Paper Comet,https://www.imdb.com/title/tt9100002/,Movie,6.8,97,2019,"Comedy, Drama",2900,2019-07-07,Ben Madeup',
  'tt9100003,9,2024-02-03,The Quiet Orchard,The Quiet Orchard,https://www.imdb.com/title/tt9100003/,Movie,7.9,118,2008,Drama,8800,2008-10-10,Cai Fiction',
  'tt9100004,6,2024-02-04,Iron Meadow,Iron Meadow,https://www.imdb.com/title/tt9100004/,Movie,6.2,101,2011,Western,1500,2011-05-05,Dee Pretend',
  'tt9100005,8,2024-02-05,Northbound Signal,Northbound Signal,https://www.imdb.com/title/tt9100005/,TV Series,8.0,50,2016,"Drama, Mystery",12000,2016-01-01,',
  'tt9100006,8,2024-02-06,Northbound Signal: Departure,Northbound Signal: Departure,https://www.imdb.com/title/tt9100006/,TV Episode,8.2,49,2016,"Drama, Mystery",900,2016-01-01,Eve Unreal',
  'tt9100007,7,2024-02-07,A Small Hour,A Small Hour,https://www.imdb.com/title/tt9100007/,Short,7.4,14,2020,Animation,200,2020-02-02,Fay Placeholder',
];

export const IMDB_QA_MIRROR_CSV = `${[IMDB_HEADER, ...rows].join('\n')}\n`;

/** First import: three movies new, one already ranked, the show recognised, one unmatched. */
export const QA_MIRROR_FIRST = {
  watched: 3,
  kept: 1,
  unsupported_tv: 1,
  unsupported_episode: 1,
  unsupported: 2,
  unmatched: 1,
} as const;

/** The same file again: the three are now an earlier import's, nothing else changes. */
export const QA_MIRROR_REIMPORT = {
  watched: 0,
  already: 3,
  kept: 1,
  unsupported_tv: 1,
  unsupported_episode: 1,
  unsupported: 2,
  unmatched: 1,
} as const;

/** The unmatched row, as `import_rows` keeps it after settle: name and year only. */
export const QA_MIRROR_UNRESOLVED = [{ name: 'A Small Hour', year: 2020 }] as const;

export type QaBucket =
  | 'newlyAdded'
  | 'previouslyImported'
  | 'alreadyPresent'
  | 'matchedExcluded'
  | 'unsupportedEpisode'
  | 'unsupportedOther'
  | 'unmatched'
  | 'duplicate'
  | 'failed';

/** Where each of the seven rows lands in `resultModel`, on each run. */
export const QA_MIRROR_BUCKETS: readonly {
  readonly imdbId: string;
  readonly first: QaBucket;
  readonly reimport: QaBucket;
}[] = [
  { imdbId: 'tt9100001', first: 'newlyAdded', reimport: 'previouslyImported' },
  { imdbId: 'tt9100002', first: 'newlyAdded', reimport: 'previouslyImported' },
  { imdbId: 'tt9100003', first: 'newlyAdded', reimport: 'previouslyImported' },
  { imdbId: 'tt9100004', first: 'alreadyPresent', reimport: 'alreadyPresent' },
  { imdbId: 'tt9100005', first: 'matchedExcluded', reimport: 'matchedExcluded' },
  { imdbId: 'tt9100006', first: 'unsupportedEpisode', reimport: 'unsupportedEpisode' },
  { imdbId: 'tt9100007', first: 'unmatched', reimport: 'unmatched' },
];
