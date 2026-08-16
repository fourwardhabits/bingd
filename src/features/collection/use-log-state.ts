import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import type { BucketId } from '@/ui/components';

/** The database's bucket names, back into the UI's. `not_for_me` is `notForMe`. */
const BUCKET_IDS: Record<string, BucketId> = {
  loved: 'loved',
  fine: 'fine',
  not_for_me: 'notForMe',
};

export type LogState = {
  bucket: BucketId | null;
  watchedOn: string | null;
  note: string;
  /**
   * Whether a `user_media` row exists at all.
   *
   * It decides which RPC a note edit uses. `save_note` updates in place and refuses a
   * title with no row (P0002); `log_watched` upserts but *coalesces*, so it can create
   * a note and can never clear one.
   */
  exists: boolean;
  /**
   * `note_updated_at`, the server's version for the stored note.
   *
   * Passed back on a save so a second device's edit is refused rather than silently
   * overwritten (offline-sync.md §5). It must always be a value the server issued —
   * a locally invented timestamp reads as a conflict with itself.
   */
  noteVersion: string | null;
  /** Present once the title has a position. Ranking owns the bucket from then on. */
  ranked: boolean;
};

export const emptyLogState: LogState = {
  bucket: null,
  watchedOn: null,
  note: '',
  exists: false,
  noteVersion: null,
  ranked: false,
};

/**
 * What the user has already recorded about a title, for the log sheet to open onto.
 *
 * Without this the sheet opened blank every time, which had two consequences worth
 * separating. The visible one: a note the user had written was invisible when they
 * came back, so the field looked empty and the sheet offered no way to edit it. The
 * quiet one: because the field was empty and saving happened on blur, re-opening and
 * touching the field was a plausible route to writing over a note with nothing.
 *
 * `ranked` comes back with it because the two facts are read together and always
 * used together: once a title has a position, `set_bucket` refuses it with 55000 and
 * the only legitimate route is `rank_rebucket`.
 *
 * Its own key rather than `queryKeys.title`. That key holds a different shape for a
 * different screen, and query.ts already records what sharing one costs: whichever
 * query runs first serves the other something it did not ask for.
 */
export function useLogState(userId: string, mediaItemId: string | null) {
  return useQuery({
    queryKey: queryKeys.logState(mediaItemId ?? ''),
    enabled: Boolean(mediaItemId),
    // The sheet is the only writer of most of this, and it invalidates on save. A
    // stale read here would show the user their own edit undone.
    staleTime: 0,
    queryFn: async (): Promise<LogState> => {
      const id = mediaItemId as string;

      const [logged, ranked] = await Promise.all([
        supabase
          .from('user_media')
          .select('bucket, watched_on, note, note_updated_at')
          .eq('user_id', userId)
          .eq('media_item_id', id)
          .maybeSingle(),
        supabase
          .from('rankings')
          .select('bucket')
          .eq('user_id', userId)
          .eq('media_item_id', id)
          .maybeSingle(),
      ]);

      if (logged.error) throw logged.error;
      if (ranked.error) throw ranked.error;

      const row = logged.data as {
        bucket: string | null;
        watched_on: string | null;
        note: string | null;
        note_updated_at: string | null;
      } | null;

      return {
        bucket: row?.bucket ? (BUCKET_IDS[row.bucket] ?? null) : null,
        watchedOn: row?.watched_on ?? null,
        note: row?.note ?? '',
        exists: Boolean(row),
        noteVersion: row?.note_updated_at ?? null,
        ranked: Boolean(ranked.data),
      };
    },
  });
}
