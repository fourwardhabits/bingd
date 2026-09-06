/**
 * The weekly ranking streak, derived from what the reader has already done.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS STORED, AND THAT WAS THE FIRST QUESTION
 *
 * A streak is the sort of feature that arrives with a `streak_count` column, a
 * `last_active_week`, and a nightly job to decrement them — three pieces of mutable
 * state that can disagree with each other and with the behaviour they claim to describe.
 * None of it is necessary here.
 *
 * `rankings.created_at` already records when each title was placed, it is the reader's
 * own row under `rankings_read`, and the client already pages the whole table for the
 * collection. So a streak is a question asked of canonical data, exactly as an award is
 * (`use-awards.ts`) — which means it cannot drift, needs no migration, and cannot be
 * wrong in a way a backfill would have to repair.
 *
 * **What that costs, stated rather than buried.** `rankings` holds one row per title,
 * not one per act:
 *
 *   - Un-ranking a title removes the row, so the evidence for that week goes with it. A
 *     streak can shrink retroactively.
 *   - Re-ranking a title deletes and re-inserts it (`rank_again`), so its `created_at`
 *     moves forward and an old week can lose its only evidence.
 *
 * Both are rare, both make the streak *lower* rather than higher, and neither can
 * fabricate one. A durable per-act ledger would fix them and is a migration; if streaks
 * turn out to matter, that is the upgrade — and it can be made without changing anything
 * a reader sees, because this module takes timestamps and not a table.
 * ---------------------------------------------------------------------------
 */

/**
 * The week a moment belongs to, as the Monday that starts it, at local midnight.
 *
 * **Monday, and local.** Monday is what "calendar week" means outside the US and is what
 * ISO-8601 says; the alternative is a Sunday boundary that surprises most of the world.
 * Local, because the reader's own midnight is the only boundary that matches what they
 * would say they did — "I ranked something on Sunday night" has to count for that week,
 * and under UTC it would not for anybody west of Greenwich.
 *
 * **The timezone comes from the device and costs no permission.** It is the OS's own
 * clock setting, which `Date` already uses — not a location, not a request, nothing new
 * asked of anybody. That is only true while the streak is computed *here*; a server-side
 * reminder would need the zone stored, which is a column and a decision, and is why the
 * reminder is deferred rather than half-built. See `docs/product/notifications.md`.
 */
export function weekStart(at: Date): Date {
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  // getDay: 0 is Sunday. Monday-based offset, so Sunday goes back six days rather than
  // forward one — the single most common off-by-one in week arithmetic.
  const offset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - offset);
  return start;
}

/** A week, as one comparable string. `2026-09-01`. */
export function weekKey(at: Date): string {
  const start = weekStart(at);
  const month = `${start.getMonth() + 1}`.padStart(2, '0');
  const day = `${start.getDate()}`.padStart(2, '0');
  return `${start.getFullYear()}-${month}-${day}`;
}

/** The Monday `count` weeks before this one. Negative counts go forward. */
function weeksBefore(from: Date, count: number): Date {
  const start = weekStart(from);
  start.setDate(start.getDate() - count * 7);
  return start;
}

export type WeeklyStreak = {
  /**
   * How many consecutive weeks up to and including this one contain a ranking.
   *
   * **This week counts as soon as it has one, and an empty this-week does not break
   * it.** A reader who ranked something every week for four weeks and has not yet
   * ranked anything this Tuesday still has a streak of four — it is *at risk*, not
   * lost. Zeroing it on Monday morning would tell somebody they had lost something
   * they still have five days to keep.
   */
  weeks: number;
  /** Whether this week already has a ranking in it. */
  rankedThisWeek: boolean;
  /** The longest run ever, for the day somebody wants to know. */
  best: number;
  /** Whether the reader has ever ranked anything. */
  hasHistory: boolean;
};

/**
 * The streak, from the instants at which rankings were placed.
 *
 * Takes timestamps rather than a query so that every rule above is testable without a
 * database, and so that swapping the source later — a durable per-act ledger, say —
 * changes one function and nothing a reader sees.
 */
export function weeklyStreak(rankedAt: readonly (string | Date)[], now: Date): WeeklyStreak {
  const weeks = new Set<string>();
  for (const at of rankedAt) {
    const date = at instanceof Date ? at : new Date(at);
    // A row whose timestamp will not parse is dropped rather than counted as the epoch,
    // which would otherwise anchor a phantom streak in 1970.
    if (Number.isNaN(date.getTime())) continue;
    weeks.add(weekKey(date));
  }

  if (weeks.size === 0) {
    return { weeks: 0, rankedThisWeek: false, best: 0, hasHistory: false };
  }

  const rankedThisWeek = weeks.has(weekKey(now));

  /**
   * Counted back from this week if it has one, and from *last* week if it does not.
   *
   * That single offset is the grace: an unfinished week is not yet a broken one. The
   * week before last is where a streak genuinely ends, because by then a whole week
   * passed with nothing in it.
   */
  let count = 0;
  let cursor = rankedThisWeek ? 0 : 1;
  while (weeks.has(weekKey(weeksBefore(now, cursor)))) {
    count += 1;
    cursor += 1;
  }

  return { weeks: count, rankedThisWeek, best: longestRun(weeks), hasHistory: true };
}

/**
 * The longest run of consecutive weeks in the set.
 *
 * Walks the sorted keys and steps a cursor a week at a time rather than differencing
 * dates, so a run that crosses a month, a year or a daylight-saving change is the same
 * arithmetic as one that does not — `weekKey` is already normalised to a local Monday,
 * and comparing two of those is comparing two strings.
 */
function longestRun(weeks: ReadonlySet<string>): number {
  const sorted = [...weeks].sort();
  let best = 0;
  let run = 0;
  let previous: string | null = null;

  for (const key of sorted) {
    const [year, month, day] = key.split('-').map(Number);
    const start = new Date(year as number, (month as number) - 1, day as number);
    start.setDate(start.getDate() - 7);
    const expected = weekKey(start);

    run = previous === expected ? run + 1 : 1;
    previous = key;
    if (run > best) best = run;
  }

  return best;
}

/**
 * How many days are left in this week, counting today.
 *
 * For the line that says how long there is to keep a streak going. Monday is 7 and
 * Sunday is 1, so it never reads "0 days left" on a day somebody can still act.
 */
export function daysLeftInWeek(now: Date): number {
  return 7 - ((now.getDay() + 6) % 7);
}
