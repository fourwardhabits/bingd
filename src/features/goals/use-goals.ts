import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';

import {
  countWatched,
  goalStatus,
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

export type YearGoals = {
  year: number;
  /** Only the media the user actually set a goal for. Absence is "no goal". */
  targets: Partial<Record<GoalCategory, number>>;
  counts: GoalCounts;
  /** One per goal that exists, in a stable order. Empty when no goal is set. */
  statuses: GoalStatus[];
};

/** The kinds a goal can count. `series` is fetched and then refused, never filtered
 *  out in the query — the refusal belongs with the rule, in `goals.ts`. */
type WatchRow = {
  media_item_id: string;
  watched_on: string | null;
  media_items: { kind: CountableWatch['kind'] } | { kind: CountableWatch['kind'] }[] | null;
};

/** PostgREST returns an embedded row as an object but types it as an array. */
const kindOf = (value: WatchRow['media_items']): CountableWatch['kind'] =>
  (Array.isArray(value) ? value[0] : value)?.kind ?? 'movie';

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
        supabase
          .from('user_media')
          .select('media_item_id, watched_on, media_items!inner(kind)')
          .eq('user_id', userId)
          // Bounds the transfer to one year. The year is *also* checked in
          // `countWatched`, which is where the rule is tested — this filter is an
          // optimisation and is not trusted to be the only one.
          .gte('watched_on', from)
          .lte('watched_on', to),
      ]);

      if (goals.error) throw goals.error;
      if (watched.error) throw watched.error;

      const targets: Partial<Record<GoalCategory, number>> = {};
      for (const row of goals.data ?? []) {
        targets[row.category as GoalCategory] = row.target as number;
      }

      const counts = countWatched(
        ((watched.data ?? []) as unknown as WatchRow[]).map((row) => ({
          mediaItemId: row.media_item_id,
          kind: kindOf(row.media_items),
          watchedOn: row.watched_on,
        })),
        year,
      );

      // Movies first, always, so the two bars do not swap places between renders
      // depending on which goal was set first.
      const statuses = (['movies', 'tv_seasons'] as const)
        .filter((category) => targets[category] != null)
        .map((category) => goalStatus(category, targets[category]!, counts[category]));

      return { year, targets, counts, statuses };
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
