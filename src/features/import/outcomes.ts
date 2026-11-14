/**
 * Which titles a finished IMDb import put under each heading, as far as the client can know.
 *
 * ---------------------------------------------------------------------------
 * TWO SOURCES, AND WHAT EACH ONE CAN HONESTLY SAY
 *
 * The summary's counts are the server's (`_import_settle`). The titles behind them come from
 * one of two places, and from nowhere else:
 *
 *   Couldn't match       the owner's own `import_rows` for the job, which `_import_settle`
 *                        keeps for exactly this, reduced to `{name, year}` (the tt id is
 *                        redacted). Readable on any visit: `import_rows_own` is the RLS.
 *
 *   TV shows, episodes,  the file as this app process parsed it (`ImdbTitle`), and ONLY for
 *   other types          the job this process started. The server deletes these rows on
 *                        settle, so after a restart, or for a job started elsewhere, there
 *                        is no list to show and the summary keeps its counts and sentences.
 *
 * Added, Already in your collection, Imported before and Duplicate have no list. The server
 * keeps no row for them, and the parse cannot tell which movies landed in which: a movie
 * may have been ranked here, imported last month, or folded into another tt id, and only
 * the database knew. Guessing would put a title under the wrong heading.
 *
 * ---------------------------------------------------------------------------
 * A LIST IS SHOWN ONLY WHEN IT ADDS UP
 *
 * Every list here is checked against its count before it is offered, and a list that does
 * not have exactly as many titles as the count beside it is not shown at all (`titles:
 * null`): the heading keeps the count and today's sentence. The checks are what make the
 * join safe without a migration. The cases they catch are real if rare: an id TMDB files as
 * an episode is "unsupported" with no media item, so it counts as "other" while the parse
 * called it a movie; a show the provider could not find is "couldn't match", not "TV
 * shows"; a job adopted from an earlier, unfinished upload carries rows this parse never
 * saw. In each of those the client cannot say which title is which, so it says the count.
 */

import type { ImportCounts } from './use-import';
import type { ImdbTitle, ImdbTitleType } from './imdb';

/** What one listed title shows. */
export type OutcomeTitle = {
  /** Stable within one list, for React. Not an identifier of anything. */
  readonly key: string;
  readonly name: string;
  readonly year: number | null;
  /**
   * IMDb's `tt` id, only while this process still holds the parsed file. Never read back
   * from the server, which redacts it on settle.
   */
  readonly imdbId: string | null;
  /** IMDb's own type, when the parse is the source. */
  readonly titleType: ImdbTitleType | null;
};

export type OutcomeSectionId = 'unmatched' | 'tv' | 'episodes' | 'other';

export type OutcomeSection = {
  readonly id: OutcomeSectionId;
  /** The summary's own number for this heading. Never recomputed from the list. */
  readonly count: number;
  /**
   * The titles, sorted, exactly `count` of them; or null when no list can be shown that
   * adds up (still loading, unavailable, or does not reconcile).
   */
  readonly titles: readonly OutcomeTitle[] | null;
};

/** One unresolved row as `import_rows` keeps it after settle. */
export type UnresolvedRow = { readonly name: string; readonly year: number | null };

/**
 * The server's unresolved rows: still being read, read, or unreadable (offline, RLS, a
 * server older than the redaction). Only `ready` lists anything.
 */
export type UnresolvedRows =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly rows: readonly UnresolvedRow[] }
  | { readonly state: 'unavailable' };

/** The summary's per-heading numbers, from the counts exactly as `ImdbSummary` reads them. */
export function outcomeCounts(counts: ImportCounts) {
  const unsupported = counts.unsupported ?? 0;
  const tv = counts.unsupported_tv ?? 0;
  const episodes = counts.unsupported_episode ?? 0;
  return {
    unmatched: (counts.ambiguous ?? 0) + (counts.unmatched ?? 0) + (counts.stragglers ?? 0),
    tv,
    episodes,
    other: Math.max(unsupported - tv - episodes, 0),
  } as const;
}

const identity = (name: string, year: number | null) => `${name}\u0000${year ?? ''}`;

const byName = (a: OutcomeTitle, b: OutcomeTitle) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
  (a.year ?? 0) - (b.year ?? 0) ||
  a.key.localeCompare(b.key);

const fromParse = (title: ImdbTitle): OutcomeTitle => ({
  key: title.imdbId,
  name: title.name,
  year: title.year,
  imdbId: title.imdbId,
  titleType: title.titleType,
});

/** A list, if it has exactly `count` titles; otherwise none. */
const reconciled = (titles: OutcomeTitle[], count: number): readonly OutcomeTitle[] | null =>
  titles.length === count ? titles.sort(byName) : null;

/**
 * The titles under each list-able heading of a finished IMDb import.
 *
 * @param counts The job's counts, as the summary shows them.
 * @param session The file this process parsed for **this** job, or null when it has none
 *   (restarted, or a job started elsewhere). Never persisted; see `session-outcomes.ts`.
 * @param unresolved The job's remaining `import_rows`, as `useUnresolvedRows` read them.
 * @returns One section per heading with a non-zero count, in the summary's order.
 */
export function buildImdbOutcomes({
  counts,
  session,
  unresolved,
}: {
  counts: ImportCounts;
  session: readonly ImdbTitle[] | null;
  unresolved: UnresolvedRows;
}): OutcomeSection[] {
  const n = outcomeCounts(counts);
  const sections: OutcomeSection[] = [];

  // tt ids for unmatched titles, only where the parse names exactly one title with that
  // name and year, so a join can never put somebody else's id on a row.
  const byIdentity = new Map<string, ImdbTitle | null>();
  for (const title of session ?? []) {
    const key = identity(title.name, title.year);
    byIdentity.set(key, byIdentity.has(key) ? null : title);
  }

  if (n.unmatched > 0) {
    sections.push({
      id: 'unmatched',
      count: n.unmatched,
      titles:
        unresolved.state === 'ready'
          ? reconciled(
              unresolved.rows.map((row, index) => {
                const parsed = byIdentity.get(identity(row.name, row.year)) ?? null;
                return {
                  key: `u${index}`,
                  name: row.name,
                  year: row.year,
                  imdbId: parsed?.imdbId ?? null,
                  titleType: parsed?.titleType ?? null,
                };
              }),
              n.unmatched,
            )
          : null,
    });
  }

  if (n.tv > 0) {
    let titles: readonly OutcomeTitle[] | null = null;
    if (session !== null) {
      const shows = session.filter((title) => title.kind === 'series');
      if (shows.length === n.tv) {
        titles = reconciled(shows.map(fromParse), n.tv);
      } else if (unresolved.state === 'ready') {
        // Some shows were not found and are under Couldn't match instead. Take those out,
        // one for one by name and year, and offer what is left only if it adds up.
        const unplaced = new Map<string, number>();
        for (const row of unresolved.rows) {
          const key = identity(row.name, row.year);
          unplaced.set(key, (unplaced.get(key) ?? 0) + 1);
        }
        const matched = shows.filter((show) => {
          const key = identity(show.name, show.year);
          const left = unplaced.get(key) ?? 0;
          if (left === 0) return true;
          unplaced.set(key, left - 1);
          return false;
        });
        titles = reconciled(matched.map(fromParse), n.tv);
      }
    }
    sections.push({ id: 'tv', count: n.tv, titles });
  }

  if (n.episodes > 0) {
    sections.push({
      id: 'episodes',
      count: n.episodes,
      titles:
        session === null
          ? null
          : reconciled(
              session.filter((title) => title.titleType === 'tvepisode').map(fromParse),
              n.episodes,
            ),
    });
  }

  if (n.other > 0) {
    sections.push({
      id: 'other',
      count: n.other,
      titles:
        session === null
          ? null
          : reconciled(
              session
                .filter((title) => title.kind === null && title.titleType !== 'tvepisode')
                .map(fromParse),
              n.other,
            ),
    });
  }

  return sections;
}
