/**
 * Work that waits for a ranking session's first answer, so that answer does not wait for it.
 *
 * ---------------------------------------------------------------------------
 * WHY (perf, 2026-11-24)
 *
 * Logging a title and ranking it is two calls in series: `log_title` from the Log sheet,
 * then `rank_start` from the ranking sheet that opens over it. Between them the Log sheet
 * refreshed everything a collection change touches — rankings, the collection, scores,
 * the Feed, the title page, goals, reviews — and on a phone with every tab mounted that
 * is forty to sixty requests. They were all asked for *before* `rank_start`, because the
 * ranking sheet only asks once it has mounted.
 *
 * On Android that order is the whole wait. OkHttp sends at most five requests to one host
 * at a time and queues the rest first in, first out, so `rank_start` went out last. On
 * the founder's Preview (staging, 2026-11-24) the gap between `log_title` and
 * `rank_start` reaching the server was 1.68 s and 2.67 s, with 45 and about 60 requests
 * in between — while `rank_start` itself executes in 57–79 ms. That gap is "Working out
 * what to ask…".
 *
 * So the refresh is handed here instead, and released the moment the session's first
 * answer arrives (or the sheet goes away). Nothing it refreshes is on screen while the
 * comparison is: the ranking sheet covers the page, and the comparison's own reads are
 * seeded from the band already in the cache.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CAN NEVER DO
 *
 * Drop the work. A held task always runs: on release, or after `HOLD_CEILING_MS` if no
 * sheet ever releases it — a caller that does not open one, a sheet that never mounts. The
 * worst case is a refresh that arrives a few seconds later than it used to, which is the
 * same refresh.
 */

/** The longest anything is held. Well past the slowest first answer measured (2.67 s). */
export const HOLD_CEILING_MS = 4_000;

let held: (() => void)[] = [];
let ceiling: ReturnType<typeof setTimeout> | null = null;

/** Runs `task` once the next ranking session has answered, or after the ceiling. */
export function holdUntilRankingOpens(task: () => void): void {
  held.push(task);
  if (ceiling === null) ceiling = setTimeout(releaseRankingHold, HOLD_CEILING_MS);
}

/** Runs everything held, once. Safe to call when nothing is held. */
export function releaseRankingHold(): void {
  if (ceiling !== null) {
    clearTimeout(ceiling);
    ceiling = null;
  }
  const tasks = held;
  held = [];
  for (const task of tasks) {
    try {
      task();
    } catch {
      // A refresh that throws must not stop the next one, or the session that released it.
    }
  }
}
