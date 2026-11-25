/**
 * The post-log refresh, held while the ranking it leads into is running.
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
 * what to ask…". #378 handed the refresh here and let it go at `rank_start`'s answer.
 *
 * ---------------------------------------------------------------------------
 * WHY IT NOW WAITS FOR THE END OF THE SESSION (perf P4, 2026-11-25)
 *
 * Let go at `rank_start`, the same forty-odd requests landed on the *first comparison*
 * instead: on the five Android slots they sat ahead of the first `rank_answer` (and, when
 * the opponent's card was not in the cached band, ahead of the `media_items` read that
 * makes the comparison answerable). And when the session places, the ranking sheet runs
 * `invalidateAfterCollectionChange({ category })` over the same title — the same helper,
 * the same keys, except that it names one ranked pool where this one names all three. So a
 * ranking that completes paid for two full refreshes, and the first was redundant.
 *
 * A hold that names its title (`owner`) is therefore **kept through the session** that
 * `rank_start` opens for that title, and ends one of two ways:
 *
 *   - **The session places** (`supersedeRankingHold`). The placement's own refresh has
 *     just run and covers every key this one does but the other two ranked pools, so the
 *     held task is dropped and only `owner.supersededBy(category)` runs: the narrow
 *     remainder, which the caller states. `invalidate.test.ts` pins that the two together
 *     are key for key the refresh that was held.
 *   - **Anything else** — Close, Android back, a failure, the sheet unmounting, the reader
 *     never getting a session at all — runs the held task in full, once
 *     (`releaseRankingHold`).
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CAN NEVER DO
 *
 * Drop the work without something equivalent having run. A held task always runs: on
 * release, or after `HOLD_CEILING_MS` if no session takes it — a caller that does not open
 * one, a sheet that never mounts, a `rank_start` that is slow to answer. Only a placement
 * for the task's own title supersedes it, and only after that placement's refresh has run.
 *
 * The ceiling applies **only until a session takes the task.** Once it has, the ranking
 * sheet is on screen over the surfaces the refresh is for, and the session's own end —
 * placement, close or unmount — is what lets it go. A ceiling firing mid-session would put
 * the burst back on whichever comparison was on screen at four seconds, which is the
 * defect this module exists to remove.
 */

/**
 * The longest anything waits for a session to take it. Well past the slowest first answer
 * measured (2.67 s).
 */
export const HOLD_CEILING_MS = 4_000;

/** Who a held refresh is about, so a placement of that title can stand in for it. */
export type HoldOwner = {
  /** The title the refresh is for. Only a session for this title can keep or supersede it. */
  mediaItemId: string;
  /**
   * What still has to run when that title is placed, given the category it was placed in:
   * whatever this refresh covers that the placement's own refresh does not.
   */
  supersededBy: (category: string | undefined) => void;
};

/**
 * Which ranking session has taken a hold: any object, compared by identity. A session keeps
 * only what it took, and lets go only of what it took or what nobody has, so a session that
 * has gone — an opening abandoned while `rank_start` was still in flight, whose answer lands
 * later — can never let go of a hold a newer session is keeping (Codex review, PR 387).
 */
export type HoldSession = object;

type Held = { task: () => void; owner: HoldOwner | null; keptBy: HoldSession | null };

let held: Held[] = [];
let ceiling: ReturnType<typeof setTimeout> | null = null;

const run = (work: () => void) => {
  try {
    work();
  } catch {
    // A refresh that throws must not stop the next one, or the session that released it.
  }
};

/** Arms the ceiling while something is waiting for a session, and disarms it once nothing is. */
const syncCeiling = () => {
  const waiting = held.some((entry) => entry.keptBy === null);
  if (waiting && ceiling === null) ceiling = setTimeout(releaseUnkept, HOLD_CEILING_MS);
  if (!waiting && ceiling !== null) {
    clearTimeout(ceiling);
    ceiling = null;
  }
};

/** Runs every entry no session has kept; a kept one stays with its session. */
function releaseUnkept(): void {
  if (ceiling !== null) clearTimeout(ceiling);
  ceiling = null;
  const due = held.filter((entry) => entry.keptBy === null);
  held = held.filter((entry) => entry.keptBy !== null);
  for (const entry of due) run(entry.task);
  syncCeiling();
}

/**
 * Runs `task` once the next ranking session has answered, or after the ceiling.
 *
 * With an `owner`, a session for that title keeps it until the session ends, and a
 * placement of that title supersedes it (see the header).
 */
export function holdUntilRankingOpens(task: () => void, owner?: HoldOwner): void {
  held.push({ task, owner: owner ?? null, keptBy: null });
  syncCeiling();
}

/**
 * `rank_start` opened `session` for `mediaItemId`, and its comparison is on screen.
 *
 * The holds for that title that nobody has taken stay held — without the ceiling — until
 * that session ends. Everything else nobody has taken runs now, which is what this moment
 * always meant for it.
 */
export function keepRankingHoldThroughSession(mediaItemId: string, session: HoldSession): void {
  for (const entry of held) {
    if (entry.keptBy === null && entry.owner?.mediaItemId === mediaItemId)
      entry.keptBy = session;
  }
  releaseUnkept();
}

/**
 * `mediaItemId` has just been reconciled by `invalidateAfterCollectionChange` with this
 * `category` (none when the caller did not know one), so the refresh held for that title
 * is replaced by its owner's remainder. Holds for any other title are untouched.
 */
export function supersedeRankingHold(mediaItemId: string, category: string | undefined): void {
  const mine = held.filter((entry) => entry.owner?.mediaItemId === mediaItemId);
  if (mine.length === 0) return;
  held = held.filter((entry) => !mine.includes(entry));
  syncCeiling();
  for (const entry of mine) run(() => entry.owner?.supersededBy(category));
}

/**
 * Runs what is held, once. Safe to call when nothing is held.
 *
 * With `session`: what that session kept, and what nobody has taken — never what another
 * session is keeping. Without: everything.
 */
export function releaseRankingHold(session?: HoldSession): void {
  const due = held.filter(
    (entry) => session === undefined || entry.keptBy === null || entry.keptBy === session,
  );
  held = held.filter((entry) => !due.includes(entry));
  syncCeiling();
  for (const entry of due) run(entry.task);
}
