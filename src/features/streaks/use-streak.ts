import { useQuery } from '@tanstack/react-query';

import { after, readAllByKey } from '@/lib/read-all';
import { supabase } from '@/lib/supabase';

import { weeklyStreak, type WeeklyStreak } from './streak';

/**
 * The reader's weekly ranking streak.
 *
 * **One column, and no new anything.** `rankings.created_at` already records when each
 * title was placed; `rankings_read` already makes the row the owner's to read. So this
 * is a select of one timestamp per ranked title, and the whole feature is `streak.ts`
 * over the result. No table, no column, no trigger, no scheduler — see `streak.ts` for
 * what that costs and why it is the right trade for a v1.
 *
 * **Paged through `readAllByKey`, like every other whole-table read in this app.** An
 * unbounded PostgREST select silently caps at 1,000 rows, which for a streak would not
 * error or warn: it would quietly drop the oldest weeks and shorten somebody's best run.
 * `media_item_id` is the cursor because it is unique per row within an account, which is
 * what a keyset needs.
 *
 * **Own rows only.** A streak is a private fact about effort, not a public one about
 * taste, and nothing here is built to be shown on somebody else's profile. Passing
 * another id would return their rows only if policy allowed it, and the section that
 * renders this is drawn on the owner's profile alone.
 */
export function useStreak(userId: string | null) {
  return useQuery({
    queryKey: ['weekly-streak', userId],
    enabled: Boolean(userId),
    // The same window the awards use. The two sit within a screen of each other on the
    // profile, and different windows would mean the shelf and the streak describing
    // different moments for no reason a reader could see.
    staleTime: 60_000,
    queryFn: async (): Promise<WeeklyStreak> => {
      const result = await readAllByKey<{ media_item_id: string; created_at: string }>(
        (cursor, limit) =>
          after(
            supabase
              .from('rankings')
              .select('media_item_id, created_at')
              .eq('user_id', userId as string),
            'media_item_id',
            cursor,
          )
            .order('media_item_id', { ascending: true })
            .limit(limit),
        (row) => [row.media_item_id],
      );
      if (result.error) throw result.error;

      /**
       * `new Date()` at the moment of the read, not a value threaded in.
       *
       * The streak is about now, and the only honest "now" is the one the answer is
       * being computed against. React Query caches the *result* for a minute, which is
       * the right granularity: a week does not turn over inside one.
       */
      return weeklyStreak(
        (result.data ?? []).map((row) => row.created_at),
        new Date(),
      );
    },
  });
}
