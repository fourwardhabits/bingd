/**
 * An IMDb ratings export, reduced to the only facts bingd is allowed to keep.
 *
 * The provider-specific half of the IMDb import (founder spec 2026-11-10). Everything that
 * is not about IMDb's file — the CSV reader, the page bounds, the upload, the job — is
 * shared with Letterboxd and lives where it always did.
 *
 * ---------------------------------------------------------------------------
 * THE FILE
 *
 * One CSV, not a ZIP. Columns, as IMDb writes them:
 *
 *   Const, Your Rating, Date Rated, Title, Original Title, URL, Title Type, IMDb Rating,
 *   Runtime (mins), Year, Genres, Num Votes, Release Date, Directors
 *
 * Five are read: `Const`, `Your Rating`, `Title`, `Original Title`, `Title Type`, `Year`.
 * The rest are never read, and three of them are traps:
 *
 * TRAP 1 — `Date Rated` IS NOT A WATCH DATE. It is when the person pressed a star on IMDb,
 * which can be years after (or, for a title rated from a list, nothing to do with) when
 * they saw it. It is never read, so it cannot become `watched_on`.
 *
 * TRAP 2 — `IMDb Rating` IS NOT THEIR RATING. It is the community average. Their own 1-10
 * is `Your Rating`, and even that is provenance only: it is never a bucket, a position or
 * a score (founder, 2026-11-10, the same rule a Letterboxd star has followed since
 * 2026-09-21). An 8/10 does not become 8.0.
 *
 * TRAP 3 — IT IS A RATINGS EXPORT, NOT A BACKUP. A title in it was rated, and rating a
 * title is the evidence it was watched; nothing in it says what the person *wants* to
 * watch. A watchlist or list export has the same columns plus `Position`, and is refused
 * here rather than read as history (`imdb_list`). Importing it is a later, separate step.
 *
 * ---------------------------------------------------------------------------
 * TYPES ARE EVIDENCE
 *
 * `Title Type` says what IMDb calls the title. It decides which kind of canonical title the
 * server may resolve the row to (`imdbKind`, mirrored by `_import_imdb_kind`), and nothing
 * else: a title TMDB files differently is left unmatched rather than reclassified. Types
 * bingd has no collection destination for — an episode, a game, a music video — are sent
 * with no rating, so the summary can count them, and are never matched.
 */

import { strFromU8 } from 'fflate';

import { cell, parseCsv, type CsvRow } from './csv';

/** The columns a ratings export must have for this reader to trust it. */
export const IMDB_REQUIRED_COLUMNS = [
  'Const',
  'Your Rating',
  'Title',
  'Title Type',
  'Year',
] as const;

/**
 * Folded IMDb types. Mirrors `_import_imdb_title_type` (SQL) and `imdbTitleType`
 * (`match.mjs`): letters only, lower case, `other` when unknown. IMDb has written both
 * "TV Mini Series" and "tvMiniSeries" over the years.
 */
export type ImdbTitleType =
  | 'movie'
  | 'tvmovie'
  | 'video'
  | 'short'
  | 'tvshort'
  | 'tvspecial'
  | 'tvseries'
  | 'tvminiseries'
  | 'tvepisode'
  | 'videogame'
  | 'musicvideo'
  | 'podcastseries'
  | 'podcastepisode'
  | 'other';

const TYPES = new Set<ImdbTitleType>([
  'movie',
  'tvmovie',
  'video',
  'short',
  'tvshort',
  'tvspecial',
  'tvseries',
  'tvminiseries',
  'tvepisode',
  'videogame',
  'musicvideo',
  'podcastseries',
  'podcastepisode',
]);

export function imdbTitleType(raw: string | null): ImdbTitleType {
  const folded = (raw ?? '').replace(/[^A-Za-z]/g, '').toLowerCase() as ImdbTitleType;
  return TYPES.has(folded) ? folded : 'other';
}

/** Which canonical kind a type may resolve to, or null when bingd has no destination. */
export function imdbKind(type: ImdbTitleType): 'movie' | 'series' | null {
  switch (type) {
    case 'movie':
    case 'tvmovie':
    case 'video':
    case 'short':
    case 'tvshort':
    case 'tvspecial':
      return 'movie';
    case 'tvseries':
    case 'tvminiseries':
      return 'series';
    default:
      return null;
  }
}

/** One title the export names, with what the import may keep about it. */
export type ImdbTitle = {
  /** IMDb's `Const`, `tt` and seven to ten digits. The row's identity within this file. */
  readonly imdbId: string;
  /** Verbatim `Title`. May be localised to the account's language. */
  readonly name: string;
  /** `Original Title`, only when it differs from `Title`. Matching evidence only. */
  readonly originalTitle: string | null;
  readonly year: number | null;
  readonly titleType: ImdbTitleType;
  readonly kind: 'movie' | 'series' | null;
  /** `Your Rating`, 1-10, or null. Provenance only. Kept for movies only. */
  readonly rating: number | null;
};

export type ImdbCounts = {
  /** Every distinct title read. */
  readonly titles: number;
  /** Titles that may become a bingd movie: films, TV movies, videos, shorts, specials. */
  readonly movies: number;
  /** TV series and mini-series. Matched to the canonical show; see `use-import` copy. */
  readonly tvShows: number;
  /** Single episodes. bingd has no destination for one. */
  readonly episodes: number;
  /** Any other type bingd has no destination for (games, music videos, podcasts, unknown). */
  readonly otherUnsupported: number;
  /** Movies carrying a valid `Your Rating`: the ratings that will be kept. */
  readonly rated: number;
  /** Rows with no usable title, or a field count that does not match the header. */
  readonly malformed: number;
  /** Rows whose `Const` is not an IMDb title id. */
  readonly invalidIds: number;
  /** Rows whose `Your Rating` was present and not a whole number from 1 to 10. Kept, unrated. */
  readonly invalidRatings: number;
  /** Repeated `Const`s, folded into the first. */
  readonly duplicates: number;
  /** The file ended inside an open quote, so the counts are lower bounds. */
  readonly damaged: boolean;
};

export type ImdbNormalised = {
  readonly titles: readonly ImdbTitle[];
  readonly counts: ImdbCounts;
};

export type ImdbReadFailure = 'not_imdb' | 'imdb_list';

const CONST_RE = /^tt\d{7,10}$/;
const YEAR_RE = /^\d{4}$/;
const RATING_RE = /^(?:[1-9]|10)$/;
const MIN_YEAR = 1870;
const MAX_NAME = 200;

/** Whether a header row is an IMDb ratings export, an IMDb list/watchlist, or neither. */
export function recogniseImdb(headers: readonly string[]): 'ratings' | ImdbReadFailure {
  const has = (name: string) => headers.includes(name);
  if (!has('Const') || !has('Title') || !has('Title Type')) return 'not_imdb';
  // A list or watchlist export: same title columns, plus its own ordering.
  if (has('Position')) return 'imdb_list';
  return IMDB_REQUIRED_COLUMNS.every(has) ? 'ratings' : 'not_imdb';
}

/** Bytes to text. UTF-8, as IMDb writes it; a byte-order mark is left for `parseCsv`. */
export function decodeCsv(bytes: Uint8Array): string {
  return strFromU8(bytes);
}

const readYear = (raw: string | null, maxYear: number): number | null => {
  if (raw === null || !YEAR_RE.test(raw)) return null;
  const year = Number(raw);
  return year >= MIN_YEAR && year <= maxYear ? year : null;
};

export type ImdbNormaliseResult =
  | { readonly ok: true; readonly normalised: ImdbNormalised }
  | { readonly ok: false; readonly reason: ImdbReadFailure };

/**
 * Reduces the export's text to the titles bingd may keep.
 *
 * A malformed row costs that row and is counted; nothing in one row can fail the file.
 */
export function normaliseImdb(
  text: string,
  { now = new Date() }: { now?: Date } = {},
): ImdbNormaliseResult {
  const doc = parseCsv(text);
  const shape = recogniseImdb(doc.headers);
  if (shape !== 'ratings') return { ok: false, reason: shape };

  const maxYear = now.getFullYear() + 5;
  const byId = new Map<string, ImdbTitle>();
  let malformed = 0;
  let invalidIds = 0;
  let invalidRatings = 0;
  let duplicates = 0;

  const read = (row: CsvRow) => {
    // A ragged row's columns may be shifted, so `Year` could hold half a title. Dropped and
    // counted rather than imported as a confident wrong fact (the Letterboxd rule).
    if (row.ragged) {
      malformed += 1;
      return;
    }
    const name = cell(row, 'Title');
    if (name === null || name.length > MAX_NAME) {
      malformed += 1;
      return;
    }
    const imdbId = cell(row, 'Const');
    if (imdbId === null || !CONST_RE.test(imdbId)) {
      invalidIds += 1;
      return;
    }

    const titleType = imdbTitleType(cell(row, 'Title Type'));
    const kind = imdbKind(titleType);
    const rawRating = cell(row, 'Your Rating');
    const validRating = rawRating !== null && RATING_RE.test(rawRating);
    if (rawRating !== null && !validRating) invalidRatings += 1;
    // Only a movie's rating has somewhere to live (`imported_titles`, on the collection row).
    // A show is recognised and not added, and an episode is not matched, so their ratings
    // are not kept or sent at all (independent review, 2026-11-11).
    const rating = validRating && kind === 'movie' ? Number(rawRating) : null;

    const existing = byId.get(imdbId);
    if (existing) {
      duplicates += 1;
      // The first row wins, except that a later rating fills an empty one.
      if (existing.rating === null && rating !== null)
        byId.set(imdbId, { ...existing, rating });
      return;
    }

    const original = cell(row, 'Original Title');
    byId.set(imdbId, {
      imdbId,
      name,
      originalTitle:
        original !== null && original.length <= MAX_NAME && original !== name ? original : null,
      year: readYear(cell(row, 'Year'), maxYear),
      titleType,
      kind,
      rating,
    });
  };

  for (const row of doc.rows) read(row);

  const titles = [...byId.values()];
  const of = (test: (title: ImdbTitle) => boolean) => titles.filter(test).length;

  return {
    ok: true,
    normalised: {
      titles,
      counts: {
        titles: titles.length,
        movies: of((t) => t.kind === 'movie'),
        tvShows: of((t) => t.kind === 'series'),
        episodes: of((t) => t.titleType === 'tvepisode'),
        otherUnsupported: of((t) => t.kind === null && t.titleType !== 'tvepisode'),
        rated: of((t) => t.rating !== null),
        malformed,
        invalidIds,
        invalidRatings,
        duplicates,
        damaged: doc.unterminated,
      },
    },
  };
}
