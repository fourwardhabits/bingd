import { useQueries, useQueryClient, type QueryClient } from '@tanstack/react-query';
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
  parent_id: string | null;
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
 *
 * **Only a reply the sheet would draw** (independent review, 2026-11-04). `activity_comments`
 * can return a visible person's reply while omitting its root, when the root's author is one
 * this reader may not see. The sheet's `threadsOf` drops such a reply; the preview must too,
 * or it would show words that opening the conversation never does. A reply under a returned
 * tombstone is kept, as the sheet keeps it. Exported for the tests that pin these rules.
 */
export function latestReadable(rows: readonly Row[]): LatestComment | null {
  const present = new Set(rows.map((row) => row.id));
  let latest: Row | null = null;
  for (const row of rows) {
    if (row.deleted_at !== null || !row.body) continue;
    if (row.parent_id !== null && !present.has(row.parent_id)) continue;
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
 * ---------------------------------------------------------------------------
 * ONE ORDER FOR EVERY COMMENT READ (combined Preview re-checks, 2026-11-04)
 *
 * A card's preview is written by two reads of the same thread — the card's own and the
 * conversation's — and responses arrive in any order. Three races were found in turn: an
 * old thread answer restoring words after a block; an old *preview* answer restoring words
 * the conversation had just shown gone (or a newer, clean thread answer being refused
 * because an older preview had finished later); and a thread request pending across a block
 * being reused when the conversation reopened.
 *
 * They are one problem — "is this answer older than one already applied?" — and are
 * answered by one number instead of by timing:
 *
 *   · every comment read, preview or thread, takes a **revision** from a per-reader counter
 *     when it *starts*;
 *   · a card applies an answer only if its revision is newer than the last one applied to
 *     that card, whichever order the responses arrive in;
 *   · a **visibility reset** (follow, unfollow, block, unblock) raises a per-reader floor to
 *     the counter, so every request already in flight is too old to apply anywhere — the
 *     privacy case is decided by order alone, with no clock;
 *   · a thread read whose revision falls under the floor by the time it answers **reads
 *     again** before returning rows, so a reopened conversation cannot show a pre-block
 *     answer either.
 *
 * Session memory only: revisions say nothing across launches, and need not — every cache
 * they guard is in memory too.
 * ---------------------------------------------------------------------------
 */
const lastRevision = new Map<string, number>();
const visibilityFloor = new Map<string, number>();
const appliedRevision = new Map<string, number>();

/** Called when a comment read starts. Returns its place in this reader's order. */
export function beginCommentRead(viewerId: string): number {
  const next = (lastRevision.get(viewerId) ?? 0) + 1;
  lastRevision.set(viewerId, next);
  return next;
}

/** Whether a read that started at `revision` began after the reader's last visibility change. */
export const afterVisibilityChange = (viewerId: string, revision: number) =>
  revision > (visibilityFloor.get(viewerId) ?? 0);

/**
 * Whether the answer to a read that started at `revision` may be applied to this card —
 * and, if so, records it as the newest applied. Refused when the reader's visibility has
 * changed since it started, or when a newer read's answer is already on the card.
 */
export function acceptCommentRead(viewerId: string, eventId: string, revision: number): boolean {
  if (!afterVisibilityChange(viewerId, revision)) return false;
  const key = `${viewerId}\u0000${eventId}`;
  if (revision < (appliedRevision.get(key) ?? 0)) return false;
  appliedRevision.set(key, revision);
  return true;
}

/**
 * **Forget every preview at once, after anything that changes whom this reader may see**
 * (independent re-check, 2026-11-04).
 *
 * The floor first, so every read already in flight is too old to apply. Then the previews
 * are reset rather than invalidated: a refetching query keeps its last success on screen,
 * and a blocked person's words would stay under the card while the refetch ran. The reset
 * drops them synchronously, and the card draws nothing until a read made after the change
 * has answered.
 */
export function resetCommentPreviews(queryClient: QueryClient, viewerId: string) {
  visibilityFloor.set(viewerId, lastRevision.get(viewerId) ?? 0);
  return queryClient.resetQueries({
    predicate: (query) =>
      query.queryKey[0] === 'comments' &&
      query.queryKey[1] === viewerId &&
      query.queryKey[3] === 'latest',
  });
}

/**
 * Set a card's preview from a fresh thread read, if no newer answer is already on the card
 * and the reader's visibility has not changed since the read began. Returns whether it wrote.
 */
export function reconcilePreviewFromThread(
  queryClient: QueryClient,
  viewerId: string,
  eventId: string,
  rows: readonly Row[],
  revision: number,
): boolean {
  if (!acceptCommentRead(viewerId, eventId, revision)) return false;
  queryClient.setQueryData(latestCommentKey(viewerId, eventId), latestReadable(rows));
  return true;
}

/**
 * `eventIds`: the cards with at least one comment this reader may see. Returns a map that
 * holds an entry only for a thread whose read succeeded and had something readable in it;
 * a failed or pending read is simply absent, and the card then draws no preview.
 */
export function useLatestComments(eventIds: readonly string[], viewerId: string) {
  const queryClient = useQueryClient();
  const results = useQueries({
    queries: eventIds.map((eventId) => ({
      queryKey: latestCommentKey(viewerId, eventId),
      // Both of the sheet's safeguards: refetch on every mount, and discard the entry the
      // moment no card observes it, so a card scrolled back into a page never starts from
      // words that may since have been withdrawn.
      staleTime: 0,
      gcTime: 0,
      queryFn: async (): Promise<LatestComment | null> => {
        const revision = beginCommentRead(viewerId);
        const { data, error } = await supabase.rpc('activity_comments', {
          p_feed_event_id: eventId,
        });
        if (error) throw error;
        // An answer older than one already applied to this card, or from before a
        // visibility change, is discarded: the card keeps what it has.
        if (!acceptCommentRead(viewerId, eventId, revision)) {
          const current = queryClient.getQueryData(latestCommentKey(viewerId, eventId));
          return (current as LatestComment | null | undefined) ?? null;
        }
        return latestReadable((data ?? []) as Row[]);
      },
    })),
  });

  // `useQueries` returns a new array every render, so the map is keyed on what it holds —
  // the body and the flag included, so an edit to the same comment redraws the preview.
  //
  // **Only an answer this mount has read and that has not since failed** (independent
  // review, 2026-11-04). A result carried over from an earlier mount, or one whose refetch
  // errored, is not evidence the comment still stands, so the card draws no preview rather
  // than words the author may have withdrawn.
  const verified = results.map((result) =>
    result.isSuccess && result.isFetchedAfterMount && !result.isError ? result.data : null,
  );
  const signature = JSON.stringify(
    verified.map((data) => (data ? [data.id, data.body, data.hasSpoilers] : null)),
  );
  return useMemo(() => {
    const map = new Map<string, LatestComment>();
    verified.forEach((data, index) => {
      const eventId = eventIds[index];
      if (eventId && data) map.set(eventId, data);
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, eventIds]);
}
