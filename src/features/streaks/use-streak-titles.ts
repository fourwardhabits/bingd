import { useQuery } from '@tanstack/react-query';

import type { BreakdownRow } from '@/features/awards/tracks';
import { compactName } from '@/lib/titles';
import { after, readAllByKey } from '@/lib/read-all';
import { supabase } from '@/lib/supabase';

import { weekKey, weekStart } from './streak';

/** The `media_items` columns a poster and a name need, and nothing more. */
const MEDIA = 'title, season_number, poster_path, kind, parent:parent_id(title)';

type Row = {
  media_item_id: string;
  created_at: string;
  media_items: {
    title: string | null;
    season_number: number | null;
    poster_path: string | null;
    kind: string | null;
    parent: { title: string | null } | { title: string | null }[] | null;
  } | null;
};

/**
 * Everything ranked inside a streak's own weeks.
 *
 * ---------------------------------------------------------------------------
 * THE FULL PERIOD, NOT ONE TITLE PER WEEK
 *
 * The founder's rule: a four-week streak that was built from five titles in week one,
 * two in week two, seven in week three and one in week four has **fifteen** contributing
 * titles, and all fifteen are legitimately part of it. A list showing four — one per week
 * — would be describing the streak's arithmetic rather than what the reader actually did.
 *
 * The poster wall still standardises how many it draws (`celebration-posters.ts`); this
 * is the set it draws from, and it is the whole set behind `See titles`.
 * ---------------------------------------------------------------------------
 *
 * **Derived, never recorded.** The weeks come from `rankings.created_at` — the same
 * column the streak itself is computed from — so there is no contribution ledger to keep
 * in step and no migration. A title ranked inside the window is a contributor because
 * the timestamp says so.
 *
 * Returned as `BreakdownRow` so the wall and the `See titles` sheet take exactly the
 * shape every award already hands them. A streak is not an award, but "here are the
 * titles behind this number" is the same question, and answering it with a second row
 * type would be a second way for a list to stop matching the thing it explains.
 */
export function useStreakTitles(userId: string | null, weeks: number | null) {
  return useQuery({
    queryKey: ['streak-titles', userId, weeks],
    enabled: Boolean(userId) && Boolean(weeks),
    staleTime: 60_000,
    queryFn: async (): Promise<BreakdownRow[]> => {
      const span = weeks as number;
      const now = new Date();
      // The Monday that opens the earliest week in the run. `weeks - 1` back, because
      // the current week is the last of them rather than the one before the first.
      const from = weekStart(now);
      from.setDate(from.getDate() - (span - 1) * 7);

      const { data, error } = await readAllByKey<Row>(
        (cursor, limit) =>
          after(
            supabase
              .from('rankings')
              .select(`media_item_id, created_at, media_items(${MEDIA})`)
              .eq('user_id', userId as string)
              // Bounded by the run rather than filtered afterwards: a reader with a
              // thousand rankings and a two-week streak should not page their whole
              // history to find nineteen of them.
              .gte('created_at', from.toISOString()),
            'media_item_id',
            cursor,
          )
            .order('media_item_id', { ascending: true })
            .limit(limit),
        (row) => [row.media_item_id],
      );
      if (error) throw error;

      /**
       * The weeks that are actually in the run, as keys.
       *
       * A `gte` on the timestamp is the cheap server-side bound; this is the exact one.
       * They differ only at the edges — a local Monday is not a UTC one — and the set
       * membership test is what keeps the answer agreeing with `weeklyStreak`, which is
       * the function the number in the heading came from.
       */
      const inRun = new Set<string>();
      for (let back = 0; back < span; back += 1) {
        const monday = weekStart(now);
        monday.setDate(monday.getDate() - back * 7);
        inRun.add(weekKey(monday));
      }

      return (data ?? [])
        .filter((row) => inRun.has(weekKey(new Date(row.created_at))))
        .map((row) => {
          // PostgREST returns a to-one embed as an object here and as an array elsewhere;
          // both shapes are handled for the same reason the feed handles them.
          const media = row.media_items;
          const parent = Array.isArray(media?.parent) ? media?.parent[0] : media?.parent;
          return {
            key: row.media_item_id,
            // Never empty: `compactName` can answer null for a row whose title the
            // catalogue has not filled in, and a blank line in a list is worse than a
            // neutral one.
            label:
              compactName({
                kind: (media?.kind ?? 'movie') as 'movie' | 'season' | 'series',
                title: media?.title ?? '',
                seriesTitle: parent?.title ?? null,
                seasonNumber: media?.season_number ?? null,
              }) ?? 'Untitled',
            posterPath: media?.poster_path ?? null,
            link: { kind: 'title' as const, mediaItemId: row.media_item_id },
          } satisfies BreakdownRow;
        });
    },
  });
}
