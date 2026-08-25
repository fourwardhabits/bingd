import { useQuery } from '@tanstack/react-query';

import { after, readAllByKey } from '@/lib/read-all';
import { supabase } from '@/lib/supabase';

/**
 * Which exact media items the signed-in user has watched.
 *
 * This is the whole input to spoiler masking, and the word *exact* is the feature.
 * A `user_media` row is per media item, and a season is its own media item, so:
 *
 *   - having watched Season 1 says nothing about Season 2;
 *   - having watched any season says nothing about the series;
 *   - having the series on a watchlist or in a discovery surface says nothing about
 *     any of its seasons.
 *
 * None of those are rules this module enforces. They are consequences of comparing
 * ids and never walking the `parent_id` edge, which is why the check lives here as a
 * set membership rather than as a function with cases in it — the cases are where a
 * spoiler leak would come from.
 *
 * Own rows only, which `user_media_own` enforces anyway. The question is always
 * "have *I* seen this", asked about the person looking at the screen.
 */
export function useWatched(userId: string) {
  return useQuery({
    queryKey: ['watched', userId],
    /**
     * Not before there is somebody to ask about.
     *
     * Every caller but one holds a resolved profile, so this is true the moment the hook
     * runs and nothing changes for them. The exception is `app/activity/[id].tsx`, which
     * is reached from a notification tap and can render while the session is still
     * loading — it passes `''`, and without this that becomes a `user_id = ''` select
     * that the database refuses as a malformed uuid, once per cold start, for an answer
     * the screen is not going to use yet.
     *
     * It fails safe either way: `data` stays undefined and `shouldMask` masks, which is
     * the direction `use-watched`'s own header argues for. This removes the request
     * rather than the protection.
     */
    enabled: Boolean(userId),
    // The set changes only when this user logs something, and every log invalidates
    // the collection key. A minute of staleness costs a spoiler being masked for a
    // viewer who has just this moment watched the thing.
    staleTime: 60_000,
    queryFn: async (): Promise<Set<string>> => {
      // Read to exhaustion (`lib/read-all.ts`). PostgREST caps an unbounded select at
      // 1,000 rows, and a *set* silently missing its thousand-and-first member is a
      // question this module answers wrongly — the film you watched last night would
      // stay masked because the read stopped before reaching it. It fails in the safe
      // direction, which is exactly why nobody would ever report it.
      const { data, error } = await readAllByKey<{ media_item_id: string }>(
        (cursor, limit) =>
          after(
            supabase.from('user_media').select('media_item_id').eq('user_id', userId),
            'media_item_id',
            cursor,
          )
            .order('media_item_id', { ascending: true })
            .limit(limit),
        (row) => [row.media_item_id],
      );
      if (error) throw error;
      return new Set((data ?? []).map((row) => row.media_item_id));
    },
  });
}

/**
 * Whether spoilers about `mediaItemId` should be hidden from this viewer.
 *
 * Three inputs, and the order they are checked in matters:
 *
 *   1. The author sees their own writing, always. Masking someone's own note is
 *      absurd and would also be the first thing they reported as a bug.
 *   2. A note not marked as spoiling anything is not masked.
 *   3. Otherwise it comes down to whether this viewer has watched this exact thing.
 *
 * `watched` being undefined — the query has not landed — resolves to *masked*. The
 * failure modes are not symmetric: a mask shown to someone who has seen the film is
 * one extra tap, and an unmask shown to someone who has not is the thing the feature
 * exists to prevent.
 */
export function shouldMask({
  hasSpoilers,
  mediaItemId,
  viewerId,
  authorId,
  watched,
}: {
  hasSpoilers: boolean;
  mediaItemId: string | null;
  viewerId: string;
  authorId: string;
  watched: Set<string> | undefined;
}): boolean {
  if (!hasSpoilers) return false;
  if (viewerId === authorId) return false;
  if (!mediaItemId) return true;
  return !watched?.has(mediaItemId);
}
