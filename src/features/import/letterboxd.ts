/**
 * A Letterboxd export, reduced to the only facts bingd is allowed to keep.
 *
 * Everything in this file is a locked product decision made executable. The decisions are
 * in `docs`-land; the traps are here, and each one is a thing the founder's real export
 * proved rather than a thing somebody guessed.
 *
 * ---------------------------------------------------------------------------
 * TRAP 1 — `Date` IS NOT A WATCH DATE, AND IT CAN BE TOMORROW
 *
 * Every row of `watched.csv` and `ratings.csv` carries a `Date`. It is when the row was
 * created on Letterboxd, not when the film was seen: in the real export *Shrek* (2001),
 * *Remember the Titans* (2000) and *Blade Runner 2049* (2017) all carry `2026-09-11`,
 * because they were marked in one sitting.
 *
 * It is also stamped in Letterboxd's own timezone. That export was taken on 2026-09-10
 * and every row reads 2026-09-11 — Letterboxd is a New Zealand company and
 * `Pacific/Auckland` runs twelve to thirteen hours ahead, so a US evening lands on the
 * following calendar day. `log_watched` refuses a date past `current_date + 1`, so
 * `Date` would sit exactly on a server guard while also being the wrong event.
 *
 * **`Date` is never read, from any file.** The only genuine viewing date in a Letterboxd
 * export is `diary.csv`'s `Watched Date`, and it is the only field that may become
 * `user_media.watched_on`.
 *
 * ---------------------------------------------------------------------------
 * TRAP 2 — THE DIARY'S `Letterboxd URI` IS A DIFFERENT OBJECT
 *
 * In the real export *Free Solo* is `boxd.it/iEEq` in `watched.csv` and `ratings.csv`,
 * and `boxd.it/ggWgth` in `diary.csv`. The second is a **diary entry** — per user, per
 * viewing, and different for every entry of the same film.
 *
 * So the diary is joined to the film by `(Name, Year)` and **never by URI**. A matcher
 * that keyed uniformly on "the URI" would emit a second, unmatched row for every film
 * with a diary entry and attach the watch date to a title that does not exist.
 *
 * ---------------------------------------------------------------------------
 * TRAP 3 — `correlation` IS NOT AN IDENTITY
 *
 * The key below unifies rows *within one export*. It is not a film identity and must
 * never be persisted as one: canonical identity is `media_items.id`, resolved through
 * TMDB, and the film URI is the external provenance handle. Deliberately it does **not**
 * use `media_squash`-style folding — stripping punctuation and diacritics is right for
 * probing a catalogue and wrong here, where two genuinely different films must never
 * collide. Whitespace and case only.
 */

import { parseCsv, cell, type CsvRow } from './csv';
import type { ArchiveText } from './archive';

export type Bucket = 'loved' | 'fine' | 'not_for_me';

/**
 * The locked star-to-bucket policy, in one place so it is one edit.
 *
 * `>= 3.5` is *I liked it*, and that boundary is a founder decision taken on semantic
 * grounds: bingd's top bucket is labelled **"I liked it"**, not "I loved it", and 3.5 of 5
 * is unambiguously liking something. The raw star is preserved beside the bucket
 * (`StagedWatched.rating`) precisely so this line can move later without asking anybody to
 * re-upload.
 *
 * An imported bucket is a **prior**. It never becomes a position and never becomes a
 * score — those come only from comparisons, and nothing in this feature writes `rankings`.
 */
export function bucketFor(rating: number | null): Bucket | null {
  if (rating === null) return null;
  if (rating >= 3.5) return 'loved';
  if (rating >= 2.5) return 'fine';
  return 'not_for_me';
}

/** A title the person has watched, with whatever the export could prove about it. */
export type StagedWatched = {
  /** Intra-export correlation only. See TRAP 3. */
  readonly correlation: string;
  /** Verbatim, as exported. The matcher's input and the provenance record. */
  readonly name: string;
  readonly year: number | null;
  /** The canonical **film** URI, when a file that carries one mentioned this title. */
  readonly filmUri: string | null;
  /** 0.5–5.0 in half steps, or null when never rated. */
  readonly rating: number | null;
  readonly bucket: Bucket | null;
  /** The most recent genuine `Watched Date`, or null. Never derived from `Date`. */
  readonly watchedOn: string | null;
};

/** One logged viewing. Identity is the diary URI, which Letterboxd issues per entry. */
export type StagedWatch = {
  /** Which title this viewing belongs to, within this export. */
  readonly correlation: string;
  readonly diaryUri: string;
  readonly watchedOn: string;
  readonly isRewatch: boolean;
};

/** A title the person wants to watch. Never one they have already watched. */
export type StagedWatchlist = {
  readonly correlation: string;
  readonly name: string;
  readonly year: number | null;
  readonly filmUri: string | null;
};

export type NormaliseCounts = {
  readonly watched: number;
  readonly watchlist: number;
  readonly rated: number;
  readonly dated: number;
  readonly watches: number;
  /**
   * Rows that could not be read as a film: no usable `Name`, an absurdly long one, or a
   * field count that did not match the header. Counted, never fatal.
   */
  readonly malformed: number;
  /**
   * How many of the four files ended inside an open quote.
   *
   * Separate from `malformed` because it is a different kind of damage and a different
   * sentence to the person: a malformed row is one film missing, while a damaged file is
   * an unknown number of films missing. **A non-zero value here means the counts in this
   * object are lower bounds**, and the import summary has to say so rather than reporting
   * a total it cannot stand behind.
   */
  readonly damagedFiles: number;
  /** Watchlist rows dropped because the same title is already watched. */
  readonly watchlistAlreadyWatched: number;
};

export type Normalised = {
  readonly watched: readonly StagedWatched[];
  readonly watchlist: readonly StagedWatchlist[];
  readonly watches: readonly StagedWatch[];
  readonly counts: NormaliseCounts;
};

/** Letterboxd's own floor and the outer edge of plausibility. */
const MIN_YEAR = 1870;
const MAX_NAME = 200;

const YEAR_RE = /^\d{4}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The intra-export correlation key. Whitespace-normalised, case-folded, NFC — and nothing
 * else. See TRAP 3 for why this stops short of the catalogue matcher's folding.
 */
export function correlationKey(name: string, year: number | null): string {
  const n = name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return `${n}|${year ?? ''}`;
}

/**
 * A name with spreadsheet formula prefixes removed, for display only.
 *
 * This import never writes a spreadsheet, so no formula can execute — but an unmatched
 * title is rendered back to the person on the repair surface, and a cell beginning `=` or
 * `@` is the shape that becomes an injection the moment anybody exports this list onward.
 *
 * Deliberately **not** applied to `name`: the stored value is matcher input and provenance,
 * and a film legitimately titled `-30-` must still match. Sanitising at the point of
 * display keeps both true.
 */
export function displayName(name: string): string {
  return name.replace(/^[=+\-@\t\r]+/, '').trim();
}

/** Parses a year cell, or null. Out-of-range is null rather than a throw. */
function readYear(raw: string | null, maxYear: number): number | null {
  if (raw === null || !YEAR_RE.test(raw)) return null;
  const year = Number(raw);
  return year >= MIN_YEAR && year <= maxYear ? year : null;
}

/**
 * Parses a rating, or null.
 *
 * The real export writes whole stars bare — `4`, not `4.0` — and halves with the decimal,
 * so both shapes are valid. Anything outside 0.5–5.0, or not on a half step, is not a
 * Letterboxd rating and is discarded rather than rounded: guessing what somebody meant by
 * `4.3` would put a film in a bucket they never chose.
 */
function readRating(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  // Halves are exactly representable in binary floating point, so this is safe.
  if (!Number.isInteger(value * 2)) return null;
  return value >= 0.5 && value <= 5 ? value : null;
}

/**
 * Parses a `Watched Date`, or null.
 *
 * Bounded above at `today + 1` for exactly the reason `log_watched` is: the server is UTC,
 * a client east of it reports a local date a day ahead for the first hours of its day, and
 * a date past that bound is not a viewing anybody had.
 */
function readWatchedDate(raw: string | null, maxDate: string): string | null {
  if (raw === null) return null;
  const m = DATE_RE.exec(raw);
  if (!m) return null;

  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < MIN_YEAR) return null;

  // Round-trip through UTC to reject 2026-02-31 and friends, which the regex admits.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  return raw <= maxDate ? raw : null;
}

/** A film-shaped row: a usable `Name`, and whatever else the file carries. */
type FilmRow = { name: string; year: number | null; uri: string | null };

/**
 * Reads the film fields of a row.
 *
 * `carriesFilmUri` is not a convenience — it is TRAP 2 enforced instead of described.
 * `watched.csv`, `ratings.csv` and `watchlist.csv` put a **film** link in
 * `Letterboxd URI`; `diary.csv` puts a **diary entry** link in the identically-named
 * column. Reading that column blindly and calling the result a film URI is precisely the
 * conflation this module exists to prevent, and it is reachable from a real export two
 * ways: a film whose name or year differs slightly between `watched.csv` and `diary.csv`
 * gets a diary-only draft, and a `watched.csv` row with an empty URI cell lets a later
 * diary row fill it in.
 *
 * It matters downstream because `filmUri` becomes the key of a **global, cross-account**
 * match cache. One bad value there is inherited by every later importer.
 */
function readFilmRow(
  row: CsvRow,
  maxYear: number,
  { carriesFilmUri }: { carriesFilmUri: boolean },
): FilmRow | null {
  // A row whose field count does not match the header is damaged, and the damage is not
  // local: an unescaped delimiter shifts every column after it, so `Year` may hold half a
  // title and `Rating` may hold a year. Letterboxd emits every column on every row, so
  // this is not a shape a healthy export produces — dropping the row and counting it is
  // honest, where importing a possibly-shifted one is a wrong fact stated confidently.
  if (row.ragged) return null;

  const name = cell(row, 'Name');
  if (name === null || name.length > MAX_NAME) return null;
  return {
    name,
    year: readYear(cell(row, 'Year'), maxYear),
    uri: carriesFilmUri ? cell(row, 'Letterboxd URI') : null,
  };
}

/** ISO date, local parts — the same rule `dates.ts` applies to a watch date. */
function isoLocal(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export type NormaliseOptions = {
  /** Injected so the date bound is testable. Defaults to the device's local today. */
  readonly now?: Date;
};

/**
 * Reduces the four permitted files to the staged model.
 *
 * Order is the contract's, and it is load-bearing: the watched set is assembled first
 * from all three files that can prove a watch, and the watchlist is filtered against it
 * afterwards. Server-side the same ordering matters again for a different reason — the
 * `_leave_watchlist` triggers fire on any watch signal — so writing the watchlist first
 * would have the database delete rows the import had just inserted.
 */
export function normalise(text: ArchiveText, options: NormaliseOptions = {}): Normalised {
  const now = options.now ?? new Date();
  const maxYear = now.getFullYear() + 5;
  const maxDate = isoLocal(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  let malformed = 0;
  let damagedFiles = 0;

  /**
   * Parses one file and folds its file-level damage into the counts.
   *
   * Every reader below goes through this rather than calling `parseCsv` directly, so a new
   * file cannot be added later that forgets to count its own damage.
   */
  const read = (source: string | null) => {
    if (source === null) return [];
    const doc = parseCsv(source);
    if (doc.unterminated) damagedFiles += 1;
    return doc.rows;
  };

  type Draft = {
    correlation: string;
    name: string;
    year: number | null;
    filmUri: string | null;
    rating: number | null;
    watchedOn: string | null;
  };

  const watched = new Map<string, Draft>();

  /** Adds or merges a film into the watched set, returning the draft it became. */
  const touch = (film: FilmRow): Draft => {
    const correlation = correlationKey(film.name, film.year);
    const existing = watched.get(correlation);
    if (existing) {
      // First file to carry a canonical film URI wins. `film.uri` is null for every diary
      // row by construction — `readFilmRow` is called with `carriesFilmUri: false` there —
      // so this cannot take a diary-entry link however the drafts were created.
      if (existing.filmUri === null && film.uri !== null) existing.filmUri = film.uri;
      return existing;
    }
    const draft: Draft = {
      correlation,
      name: film.name,
      year: film.year,
      filmUri: film.uri,
      rating: null,
      watchedOn: null,
    };
    watched.set(correlation, draft);
    return draft;
  };

  // ---------------------------------------------------------------------------
  // 1. watched.csv — the spine. `Date` is ignored, deliberately and completely.
  // ---------------------------------------------------------------------------
  for (const row of read(text['watched.csv'])) {
    const film = readFilmRow(row, maxYear, { carriesFilmUri: true });
    if (!film) {
      malformed += 1;
      continue;
    }
    touch(film);
  }

  // ---------------------------------------------------------------------------
  // 2. ratings.csv — the authority for the rating.
  //
  // A film here that `watched.csv` did not list is still watched: on Letterboxd a rating
  // implies a viewing, and the two files disagreeing is a sync artefact rather than a
  // statement that somebody rated a film they had not seen.
  // ---------------------------------------------------------------------------
  for (const row of read(text['ratings.csv'])) {
    const film = readFilmRow(row, maxYear, { carriesFilmUri: true });
    if (!film) {
      malformed += 1;
      continue;
    }
    const draft = touch(film);
    const rating = readRating(cell(row, 'Rating'));
    // A later duplicate row for the same film does not clear an earlier rating.
    if (rating !== null) draft.rating = rating;
  }

  // ---------------------------------------------------------------------------
  // 3. diary.csv — the only genuine watch dates, and the per-viewing rows.
  //
  // The per-entry `Rating` is read and discarded: Letterboxd stores a film-page rating and
  // a diary-entry rating separately and they can disagree, and the contract names
  // `ratings.csv` as the authority. `Tags` is never read at all.
  // ---------------------------------------------------------------------------
  const watches: StagedWatch[] = [];
  const seenDiaryUris = new Set<string>();

  for (const row of read(text['diary.csv'])) {
    // `carriesFilmUri: false`, and it is the whole of TRAP 2. This file's URI column
    // addresses a viewing; it is read below into `diaryUri` and may never reach
    // `filmUri`, which keys a global cross-account cache.
    const film = readFilmRow(row, maxYear, { carriesFilmUri: false });
    if (!film) {
      malformed += 1;
      continue;
    }

    const draft = touch(film);
      const watchedOn = readWatchedDate(cell(row, 'Watched Date'), maxDate);

      if (watchedOn !== null) {
        // The most recent genuine viewing is the one the collection row carries. String
        // comparison is correct for ISO dates and avoids a timezone round trip.
        if (draft.watchedOn === null || watchedOn > draft.watchedOn) draft.watchedOn = watchedOn;

        const diaryUri = cell(row, 'Letterboxd URI');
        // No URI, no per-viewing identity, so no idempotency — the date is still taken
        // above, and the viewing is simply not staged. A duplicate URI is the same entry
        // exported twice and is dropped rather than counted twice.
        if (diaryUri !== null && !seenDiaryUris.has(diaryUri)) {
          seenDiaryUris.add(diaryUri);
          watches.push({
            correlation: draft.correlation,
            diaryUri,
            watchedOn,
            isRewatch: (cell(row, 'Rewatch') ?? '').toLowerCase() === 'yes',
          });
    }
    }
  }

  // ---------------------------------------------------------------------------
  // 4. watchlist.csv — minus everything watched.
  // ---------------------------------------------------------------------------
  const watchlist: StagedWatchlist[] = [];
  const seenWatchlist = new Set<string>();
  let watchlistAlreadyWatched = 0;

  for (const row of read(text['watchlist.csv'])) {
    const film = readFilmRow(row, maxYear, { carriesFilmUri: true });
    if (!film) {
      malformed += 1;
      continue;
    }
    const correlation = correlationKey(film.name, film.year);
    if (watched.has(correlation)) {
      watchlistAlreadyWatched += 1;
      continue;
    }
    if (seenWatchlist.has(correlation)) continue;
    seenWatchlist.add(correlation);
    watchlist.push({ correlation, name: film.name, year: film.year, filmUri: film.uri });
  }

  const titles: StagedWatched[] = [...watched.values()].map((draft) => ({
    correlation: draft.correlation,
    name: draft.name,
    year: draft.year,
    filmUri: draft.filmUri,
    rating: draft.rating,
    bucket: bucketFor(draft.rating),
    watchedOn: draft.watchedOn,
  }));

  return {
    watched: titles,
    watchlist,
    watches,
    counts: {
      watched: titles.length,
      watchlist: watchlist.length,
      rated: titles.filter((t) => t.rating !== null).length,
      dated: titles.filter((t) => t.watchedOn !== null).length,
      watches: watches.length,
      malformed,
      damagedFiles,
      watchlistAlreadyWatched,
    },
  };
}
