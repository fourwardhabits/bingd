/**
 * What a finished import did, in the words the results screen uses (IMP1113-UI).
 *
 * Pure: the job's counts in, one bucket per outcome out. The counts are `_import_settle`'s
 * (20261113000100, `import_jobs.counts`), and nothing here recomputes, estimates or tops
 * one up; it only renames and groups them.
 *
 * ---------------------------------------------------------------------------
 * UNKNOWN IS NOT ZERO
 *
 * A key the job's counts do not carry is `undefined` here, never `0`. An import finished
 * before a bucket existed (a job from before 20261113000100 has no `unsupported_tv`; a
 * Letterboxd job never has the IMDb buckets) did not count that outcome, which is a
 * different fact from counting none of it. The screen leaves an unknown bucket out exactly
 * as it leaves a zero out, so the difference is invisible today; it is kept so that no
 * future sentence can say "0 TV shows" about an import that never asked.
 *
 * A bucket made of several keys is unknown only when **every** key is missing. Where some
 * are present, a missing part is a bucket that job never had (an old job with `unmatched`
 * and no `stragglers`), so the present parts are the whole of what it counted.
 *
 * ---------------------------------------------------------------------------
 * ONE ROW, ONE BUCKET
 *
 * Every row the server staged is counted in exactly one of `newlyAdded`,
 * `previouslyImported`, `alreadyPresent`, `matchedExcluded`, `unsupportedEpisode`,
 * `unsupportedOther`, `unmatched`, `duplicate` and `failed` (watched rows), or `watchlistAdded`
 * (Letterboxd watchlist rows that were added). `diaryKept` counts diary entries, not rows.
 * `bucketTotal` adds the row buckets so a test can hold them against the file.
 */

import type { ImportProvider } from './providers';
import type { ImportCounts } from './use-import';

export type ResultModel = {
  /** `watched`: titles this import put in the collection. Unranked. */
  readonly newlyAdded: number | undefined;
  /** `already`: titles an earlier import put there, unchanged by this one. Still unranked. */
  readonly previouslyImported: number | undefined;
  /** `kept`: titles that were already in bingd (ranked or logged here), left as they were. */
  readonly alreadyPresent: number | undefined;
  /** `watchlist`: Letterboxd watchlist titles added by this import. */
  readonly watchlistAdded: number | undefined;
  /** `viewings`: Letterboxd diary entries on file for this import's films. Held, not added. */
  readonly diaryKept: number | undefined;
  /** `unsupported_tv`: whole TV shows found in bingd and not added (IMDb, this release). */
  readonly matchedExcluded: number | undefined;
  /** `unsupported_episode`: single episodes. bingd does not track one. */
  readonly unsupportedEpisode: number | undefined;
  /** `unsupported − unsupported_tv − unsupported_episode`: games, podcasts and the like. */
  readonly unsupportedOther: number | undefined;
  /** `unmatched + ambiguous + stragglers`: titles that did not arrive for want of a match. */
  readonly unmatched: number | undefined;
  /** `duplicate`: a second IMDb id naming a title this import already placed. Counted once. */
  readonly duplicate: number | undefined;
  /** `failed`: matched, and the write failed. Never folded into another bucket. */
  readonly failed: number | undefined;
};

const sumOf = (...parts: (number | undefined)[]): number | undefined =>
  parts.every((part) => part === undefined)
    ? undefined
    : parts.reduce<number>((total, part) => total + (part ?? 0), 0);

/**
 * The results screen's buckets for one finished job.
 *
 * @param counts `import_jobs.counts`, as the status read returned it.
 * @param provider Whose file it was. A Letterboxd watchlist and diary have no IMDb
 *   counterpart (a ratings export has neither), so an IMDb job's are `undefined` rather than
 *   the server's structural zeros.
 */
export function resultModel(counts: ImportCounts, provider: ImportProvider): ResultModel {
  const unsupported = counts.unsupported;
  const tv = counts.unsupported_tv;
  const episode = counts.unsupported_episode;
  return {
    newlyAdded: counts.watched,
    previouslyImported: counts.already,
    alreadyPresent: counts.kept,
    watchlistAdded: provider === 'imdb' ? undefined : counts.watchlist,
    diaryKept: provider === 'imdb' ? undefined : counts.viewings,
    matchedExcluded: tv,
    unsupportedEpisode: episode,
    unsupportedOther:
      unsupported === undefined
        ? undefined
        : Math.max(unsupported - (tv ?? 0) - (episode ?? 0), 0),
    unmatched: sumOf(counts.unmatched, counts.ambiguous, counts.stragglers),
    duplicate: counts.duplicate,
    failed: counts.failed,
  };
}

/** The row buckets, added: every staged row the model accounts for. Unknown counts as 0. */
export function bucketTotal(model: ResultModel): number {
  return (
    (model.newlyAdded ?? 0) +
    (model.previouslyImported ?? 0) +
    (model.alreadyPresent ?? 0) +
    (model.watchlistAdded ?? 0) +
    (model.matchedExcluded ?? 0) +
    (model.unsupportedEpisode ?? 0) +
    (model.unsupportedOther ?? 0) +
    (model.unmatched ?? 0) +
    (model.duplicate ?? 0) +
    (model.failed ?? 0)
  );
}

/** Titles the import owns in the collection, still unranked: this run's and earlier runs'. */
export const importedTitles = (model: ResultModel): number =>
  (model.newlyAdded ?? 0) + (model.previouslyImported ?? 0);

/** Whether anything new came in: a title, or (Letterboxd) a watchlist entry. */
export const somethingArrived = (model: ResultModel): boolean =>
  (model.newlyAdded ?? 0) + (model.watchlistAdded ?? 0) > 0;

/**
 * **Already in bingd: everything the file named that was in the collection before this run**
 * (founder QA, 2026-11-16). That is `kept` (ranked or logged here) and `already` (put there by
 * an earlier import) together. A repeated import used to count the second group under
 * "Imported movies", as if this run had added them; it added nothing. The server counts every
 * row in exactly one bucket, so the sum is already deduplicated: a title is never both.
 */
export const alreadyInBingd = (model: ResultModel): number =>
  (model.alreadyPresent ?? 0) + (model.previouslyImported ?? 0);

/** Whether the file named titles bingd already had, from this person or an earlier import. */
export const alreadyHere = (model: ResultModel): boolean => alreadyInBingd(model) > 0;

/**
 * The results headline: one heading for every finished import (founder QA, 2026-11-16).
 * What happened is the summary line's job, not the heading's, so the heading never has to
 * choose between "is in" and "is already here" for a file that is partly both.
 */
export function resultHeadline(_model: ResultModel, _provider: ImportProvider): string {
  return 'Import complete';
}

/**
 * The line under the heading. Movies only: a Letterboxd or IMDb history arrives as films, and
 * TV and episodes have their own notes below. Three cases, never two claims at once.
 */
export function resultSummary(model: ResultModel): string {
  const added = model.newlyAdded ?? 0;
  const watchlist = model.watchlistAdded ?? 0;
  if (added > 0) return `${added === 1 ? '1 movie' : `${added} movies`} added to bingd.`;
  // A Letterboxd watchlist is the one other thing an import adds; saying "no new movies"
  // over a watchlist row that just grew would read as a contradiction.
  if (watchlist > 0) {
    return `${watchlist === 1 ? '1 movie' : `${watchlist} movies`} added to your watchlist.`;
  }
  if (alreadyHere(model)) {
    return 'No new movies were added. Your existing titles are already in bingd.';
  }
  return 'No new movies were added.';
}
