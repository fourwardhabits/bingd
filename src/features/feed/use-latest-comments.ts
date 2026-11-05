import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

/**
 * The newest comment this reader may see on each Feed card (cinematic Feed, 2026-11-04).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE THREAD'S OWN READ AND NOT A NEW ONE
 *
 * `activity_comments` is the function the comment sheet already opens with, and every
 * rule the founder asked the preview to keep is enforced inside it rather than here:
 *
 *   · an author this reader may not see — blocked either way, or a private account they
 *     do not follow — is **absent**, joined out on the server (`use-comments.ts`);
 *   · a retracted comment comes back as a tombstone with no body, and is skipped below;
 *   · the spoiler flag rides on the row, and masking is decided by `shouldMask` at the
 *     card, exactly as the sheet decides it.
 *
 * So the preview can never show a remark the sheet would not, because it is the sheet's
 * answer with all but one row dropped. No new RPC, no schema, nothing stored differently.
 *
 * **Only for cards that have comments.** The caller passes the events whose
 * `activity_comment_counts` is above zero, so a page of twenty quiet cards costs no reads
 * at all, and a card with a conversation costs one. A batched server read
 * ("latest comment per event") would make that one read per page instead, and is listed
 * as a follow-up rather than built here because it is a new function on the database.
 *
 * ---------------------------------------------------------------------------
 * KEYED UNDER `['comments', viewer]`, ON PURPOSE
 *
 * `useCommentWrites` invalidates that prefix after every post, edit and delete, so a
 * comment written, corrected or retracted in the sheet replaces the preview under the
 * card it belongs to without this file knowing any writer exists. The trailing `latest`
 * keeps the entry distinct from the sheet's own `['comments', viewer, event]`, which is
 * `gcTime: 0` and must stay so.
 *
 * `staleTime: 0` for the reason the sheet gives: this is the one kind of text in the app
 * its author can withdraw, and a minute-old cache is a minute of somebody reading words
 * that no longer exist.
 */
export type LatestComment = {
  id: string;
  authorId: string;
  authorUsername: string;
  authorName: string;
  authorAvatarUri: string | null;
  body: string;
  hasSpoilers: boolean;
  createdAt: string;
};

type Row = {
  id: string;
  author_id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  body: string | null;
  has_spoilers: boolean;
  created_at: string;
  deleted_at: string | null;
};

/**
 * The newest readable comment in a thread, or null.
 *
 * Replies count: "the most recent comment" is the last thing anybody said, and a reply is
 * where most of a conversation's latest words are. A tombstone does not — it has no words.
 * Exported for the test that pins both rules.
 */
export function latestReadable(rows: readonly Row[]): LatestComment | null {
  let latest: Row | null = null;
  for (const row of rows) {
    if (row.deleted_at !== null || !row.body) continue;
    if (!latest || row.created_at > latest.created_at) latest = row;
  }
  if (!latest || !latest.body) return null;
  return {
    id: latest.id,
    authorId: latest.author_id,
    authorUsername: latest.username,
    authorName: latest.display_name || latest.username,
    authorAvatarUri: avatarUri(latest.avatar_path),
    body: latest.body,
    hasSpoilers: latest.has_spoilers,
    createdAt: latest.created_at,
  };
}

export const latestCommentKey = (viewerId: string, eventId: string) =>
  ['comments', viewerId, eventId, 'latest'] as const;

/**
 * `eventIds`: the cards with at least one comment this reader may see. Returns a map that
 * holds an entry only for a thread whose read succeeded and had something readable in it;
 * a failed or pending read is simply absent, and the card then draws no preview.
 */
export function useLatestComments(eventIds: readonly string[], viewerId: string) {
  const results = useQueries({
    queries: eventIds.map((eventId) => ({
      queryKey: latestCommentKey(viewerId, eventId),
      staleTime: 0,
      queryFn: async (): Promise<LatestComment | null> => {
        const { data, error } = await supabase.rpc('activity_comments', {
          p_feed_event_id: eventId,
        });
        if (error) throw error;
        return latestReadable((data ?? []) as Row[]);
      },
    })),
  });

  // `useQueries` returns a new array every render, so the map is keyed on what it holds —
  // the body and the flag included, so an edit to the same comment redraws the preview.
  const signature = JSON.stringify(
    results.map((result) =>
      result.data ? [result.data.id, result.data.body, result.data.hasSpoilers] : null,
    ),
  );
  return useMemo(() => {
    const map = new Map<string, LatestComment>();
    results.forEach((result, index) => {
      const eventId = eventIds[index];
      if (eventId && result.data) map.set(eventId, result.data);
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, eventIds]);
}
