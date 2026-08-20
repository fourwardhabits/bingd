import { useQuery } from '@tanstack/react-query';

import { after, readAllByKey } from '@/lib/read-all';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';

import {
  goalStatus,
  qualifyingWatches,
  yearRange,
  type CountableWatch,
  type GoalCategory,
  type GoalCounts,
  type GoalStatus,
} from './goals';

/**
 * A year's goals: what the user aimed for, and where they are.
 *
 * **Why there is no `watch_goal_progress` RPC.** Both halves of this are the caller's
 * own rows under policies that already say so — `watch_goals_own` and `user_media_own`
 * are both `user_id = auth.uid()`. A function to count them would have to be either
 * `security invoker`, in which case it is a query with a grant attached, or
 * `security definer`, in which case a screen's arithmetic is now privileged code that
 * takes a year from the client. Neither buys anything: the count is over one person's
 * own rows for one year, which is tens of rows, and the range filter keeps it that way.
 *
 * The two requests settle together for the reason `useLoggedCollection` gives: the
 * surface renders "12 of 52", and independently cached halves show a pair of numbers
 * that disagree for a frame every time either lands.
 */

/** One title that counted toward a goal, with enough to draw a row for it. */
export type QualifyingWatch = CountableWatch & {
  title: string;
  posterPath: string | null;
};

export type YearGoals = {
  year: number;
  /** Only the media the user actually set a goal for. Absence is "no goal". */
  targets: Partial<Record<GoalCategory, number>>;
  counts: GoalCounts;
  /** One per goal that exists, in a stable order. Empty when no goal is set. */
  statuses: GoalStatus[];
  /**
   * The titles behind each number, in the order the query returned them.
   *
   * The same traversal that produced `counts`, so a drill-down cannot show a different
   * set from the bar it was opened from. Present for both media whether or not a goal
   * exists — the list is a fact about the year, not about the target.
   */
  qualifying: Record<GoalCategory, QualifyingWatch[]>;
};

/** The kinds a goal can count. `series` is fetched and then refused, never filtered
 *  out in the query — the refusal belongs with the rule, in `goals.ts`. */
type Embedded = { kind: CountableWatch['kind']; title: string | null; poster_path: string | null };

type WatchRow = {
  media_item_id: string;
  watched_on: string | null;
  media_items: Embedded | Embedded[] | null;
};

/** PostgREST returns an embedded row as an object but types it as an array. */
const embedded = (value: WatchRow['media_items']): Embedded | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

export function useWatchGoals(userId: string, year: number) {
  return useQuery({
    queryKey: queryKeys.goals(userId, year),
    enabled: Boolean(userId),
    queryFn: async (): Promise<YearGoals> => {
      const { from, to } = yearRange(year);

      const [goals, watched] = await Promise.all([
        supabase
          .from('watch_goals')
          .select('category, target')
          .eq('user_id', userId)
          .eq('year', year),
        // `!inner` so a row whose media item is unreadable is absent rather than
        // arriving with a null embed and being counted as a movie by `kindOf`'s
        // fallback. `media_items` is world-readable, so in practice this changes
        // nothing; it means the fallback can never decide a goal.
        // Paged to exhaustion (`lib/read-all.ts`), because what comes out of this read is
        // a *number* on a progress bar. PostgREST caps an unbounded select at 1,000 rows,
        // so a year past that would have shown a goal stuck at a thousand — a wrong
        // figure with nothing to distinguish it from a true one.
        readAllByKey<WatchRow>(
          (cursor, limit) =>
            after(
              supabase
                .from('user_media')
                .select('media_item_id, watched_on, media_items!inner(kind, title, poster_path)')
                .eq('user_id', userId)
                // Bounds the transfer to one year. The year is *also* checked in
                // `countWatched`, which is where the rule is tested — this filter is an
                // optimisation and is not trusted to be the only one.
                .gte('watched_on', from)
                .lte('watched_on', to),
              'media_item_id',
              cursor,
            )
              .order('media_item_id', { ascending: true })
              .limit(limit),
          (row) => [row.media_item_id],
        ),
      ]);

      if (goals.error) throw goals.error;
      if (watched.error) throw watched.error;

      const targets: Partial<Record<GoalCategory, number>> = {};
      for (const row of goals.data ?? []) {
        targets[row.category as GoalCategory] = row.target as number;
      }

      const qualifying = qualifyingWatches<QualifyingWatch>(
        ((watched.data ?? []) as unknown as WatchRow[]).map((row) => {
          const item = embedded(row.media_items);
          return {
            mediaItemId: row.media_item_id,
            // The `!inner` join means the embed is present; the fallback exists so a
            // null `kind` cannot silently become a movie. `series` is refused by the
            // rule rather than here.
            kind: item?.kind ?? 'series',
            watchedOn: row.watched_on,
            title: item?.title ?? 'Untitled',
            posterPath: item?.poster_path ?? null,
          };
        }),
        year,
      );

      const counts: GoalCounts = {
        movies: qualifying.movies.length,
        tv_seasons: qualifying.tv_seasons.length,
      };

      // Movies first, always, so the two bars do not swap places between renders
      // depending on which goal was set first.
      const statuses = (['movies', 'tv_seasons'] as const)
        .filter((category) => targets[category] != null)
        .map((category) => goalStatus(category, targets[category]!, counts[category]));

      return { year, targets, counts, statuses, qualifying };
    },
  });
}

/**
 * Sets, changes or clears one goal.
 *
 * A null target clears. That is `set_watch_goal`'s contract rather than this
 * function's convenience: three RPCs would be three grants and three ways for a
 * client to invent a state nobody tested (20260816000800 §3).
 */
export type GoalWriteResult = { ok: true } | { ok: false; message: string };

export async function setWatchGoal(input: {
  year: number;
  category: GoalCategory;
  target: number | null;
}): Promise<GoalWriteResult> {
  const { error } = await supabase.rpc('set_watch_goal', {
    p_year: input.year,
    p_category: input.category,
    p_target: input.target,
  });

  if (!error) return { ok: true };

  // Mapped here rather than through `collection/writes.ts`'s `interpret`, which
  // reads 55000 as "ranking owns this bucket now". A goal has no such state, and
  // borrowing the mapping would mean a future 55000 from this RPC being reported to
  // the user as something about ranking.
  switch (error.code) {
    case '22023':
    case '23514':
      // The server's sentence is the useful one: it distinguishes an out-of-range
      // target from an out-of-range year, and neither is worth a second wording.
      return { ok: false, message: error.message };
    case '42501':
      return { ok: false, message: 'Your account cannot make changes right now.' };
    case '28000':
      return { ok: false, message: 'Your session expired. Sign in again.' };
    default:
      return { ok: false, message: error.message };
  }
}

/**
 * The year a goal screen defaults to.
 *
 * The device's local year, for the same reason `today()` in `collection/writes.ts`
 * is a local calendar date: on the 1st of January the user's year and UTC's disagree
 * for up to thirteen hours, and the one they mean is the one on their wall.
 */
export const currentYear = () => new Date().getFullYear();
