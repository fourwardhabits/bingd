import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { invalidateAwards } from '@/features/awards/invalidate';
import { newOperationId } from '@/features/collection/writes';
import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';
import { classifyWrite, mustReconcile } from '@/lib/write-outcome';

/**
 * Recommendation requests: the held half of the recommendations tab (20260826000400).
 *
 * A request is a recommendation somebody sent across a **one-way follow** — they follow
 * the reader, the reader does not follow them back. It is stored at send time and is
 * never lost; it simply waits here until the reader adds it, dismisses it, or follows
 * the sender, which releases everything that person was holding.
 *
 * **This is not an inbox and it is deliberately not wired to one.** No notification is
 * filed for a request, the Bell badge does not move, and nothing here appears in the
 * chronological Notifications timeline. The signal lives on the recommendations screen
 * because that is where the decision is — see the migration header.
 */

export type RecommendationRequest = {
  id: string;
  senderId: string;
  senderUsername: string;
  senderName: string;
  senderAvatarUri: string | null;
  mediaItemId: string;
  kind: 'movie' | 'season' | 'series';
  title: string;
  seriesTitle: string | null;
  posterPath: string | null;
  year: number | null;
  genres: string[];
  runtimeMinutes: number | null;
  recommendedAt: string;
};

/** One sender, and everything of theirs that is waiting. */
export type RequestGroup = {
  senderId: string;
  senderUsername: string;
  senderName: string;
  senderAvatarUri: string | null;
  items: RecommendationRequest[];
};

export type RecommendationRequests = {
  /**
   * Total pending **items**, not senders, and not the length of `groups`.
   *
   * Counted by the server before its own limit is applied, so a capped list still
   * reports a true total — the rule review 21c set on the unopened chip, which this
   * count is drawn beside.
   */
  total: number;
  groups: RequestGroup[];
};

type Row = {
  id: string;
  sender_id: string;
  sender_username: string;
  sender_display_name: string | null;
  sender_avatar_path: string | null;
  media_item_id: string;
  media_kind: 'movie' | 'season' | 'series';
  media_title: string;
  series_title: string | null;
  poster_path: string | null;
  release_date: string | null;
  genres: string[] | null;
  runtime_minutes: number | null;
  recommended_at: string;
  total_pending: number | string;
};

const yearOf = (date: string | null): number | null => {
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : null;
};

export const REQUEST_LIMIT = 200;

/** Every query this feature keeps, invalidated together. */
export const invalidateRequests = (
  queryClient: ReturnType<typeof useQueryClient>,
  viewerId: string,
) => {
  void queryClient.invalidateQueries({ queryKey: ['recommendation-requests', viewerId] });
  // An added request becomes an ordinary recommendation, so the list beside it moves too.
  void queryClient.invalidateQueries({ queryKey: ['sent-to-you', viewerId] });
};

/**
 * The requests, already grouped.
 *
 * Grouped here rather than in the component so the sheet and the count above it read
 * the same object — and **in the order the server sent them**, never re-sorted. The
 * RPC orders sender groups by their newest request and requests newest-first within a
 * group, so the grouping below only has to preserve first-appearance order. Two sorts
 * over one list is how a screen comes to disagree with the number drawn above it
 * (`use-sent-to-you.ts` records the same rule).
 */
export function useRecommendationRequests(viewerId: string) {
  return useQuery({
    queryKey: ['recommendation-requests', viewerId],
    staleTime: 30_000,
    queryFn: async (): Promise<RecommendationRequests> => {
      const { data, error } = await supabase.rpc('recommendation_requests', {
        p_limit: REQUEST_LIMIT,
      });
      if (error) throw error;

      const rows = (data ?? []) as Row[];
      // `total_pending` is a bigint, which PostgREST may serialise as a string. It is
      // the number drawn in front of the reader, so it is coerced once, here.
      const total = rows[0] ? Number(rows[0].total_pending) : 0;

      const groups: RequestGroup[] = [];
      const index = new Map<string, RequestGroup>();

      for (const row of rows) {
        let group = index.get(row.sender_id);
        if (!group) {
          group = {
            senderId: row.sender_id,
            senderUsername: row.sender_username,
            senderName: row.sender_display_name || row.sender_username,
            senderAvatarUri: avatarUri(row.sender_avatar_path),
            items: [],
          };
          index.set(row.sender_id, group);
          groups.push(group);
        }
        group.items.push({
          id: row.id,
          senderId: row.sender_id,
          senderUsername: row.sender_username,
          senderName: group.senderName,
          senderAvatarUri: group.senderAvatarUri,
          mediaItemId: row.media_item_id,
          kind: row.media_kind,
          title: row.media_title,
          seriesTitle: row.series_title,
          posterPath: row.poster_path,
          year: yearOf(row.release_date),
          genres: row.genres ?? [],
          runtimeMinutes: row.runtime_minutes,
          recommendedAt: row.recommended_at,
        });
      }

      return { total: Number.isFinite(total) ? total : rows.length, groups };
    },
  });
}

export type RequestActionResult = { ok: true } | { ok: false; message: string };

/**
 * Add one, dismiss one, dismiss all.
 *
 * **No optimism.** Every one of these is a decision about somebody else's suggestion,
 * and a row that disappears and comes back is worse than one that takes a beat. The
 * same rule `use-social.ts` applies to follow and block, for a smaller reason.
 *
 * **Only `dismiss_all_recommendation_requests` carries an operation id.** The two
 * single-row writers are idempotent by construction — they update a row only while it
 * is still `pending`, and both transitions out of pending are terminal — so a replay
 * after a lost reply is a no-op the server can answer without a ledger. The sweep is
 * addressed at *whatever is pending when it runs*, so a replay would eat requests that
 * arrived in between. See §9 of the migration.
 */
export function useRequestActions(viewerId: string) {
  const queryClient = useQueryClient();

  /**
   * `changed` here means what it means in `collection/writes.ts`: the write may already
   * have happened, so the caches have to be reconciled even while an error is shown.
   * Anything other than a refusal this app raises on purpose can carry a committed
   * transaction (`lib/write-outcome.ts`).
   */
  const run = async (
    call: () => PromiseLike<{ error: unknown }>,
    failed: string,
  ): Promise<RequestActionResult> => {
    const { error } = await call();

    if (mustReconcile(classifyWrite(error as { code?: string } | null))) {
      invalidateRequests(queryClient, viewerId);
      // Hype Courier counts recommendations, and an add moves one into the list its
      // metric reads (`awards/invalidate.ts`).
      invalidateAwards(queryClient, viewerId);
    }

    if (error) {
      const code = (error as { code?: string } | null)?.code;
      // `assert_can_write`. Nothing else on these three paths raises on purpose.
      if (code === '42501') {
        return { ok: false, message: 'Your account cannot make changes right now.' };
      }
      return { ok: false, message: failed };
    }
    return { ok: true };
  };

  const add = useMutation({
    mutationFn: ({ recommendationId }: { recommendationId: string }) =>
      run(
        () => supabase.rpc('add_recommendation', { p_recommendation_id: recommendationId }),
        'That recommendation could not be added.',
      ),
  });

  const dismiss = useMutation({
    mutationFn: ({ recommendationId }: { recommendationId: string }) =>
      run(
        () => supabase.rpc('dismiss_recommendation', { p_recommendation_id: recommendationId }),
        'That recommendation could not be dismissed.',
      ),
  });

  const dismissAll = useMutation({
    /**
     * The id comes from the caller so a retry can carry the one the first attempt used.
     * A fresh id would walk straight past `_claim_operation` and sweep whatever had
     * arrived since — which is exactly the case the ledger exists for.
     */
    mutationFn: ({ operationId }: { operationId: string }) =>
      run(
        () => supabase.rpc('dismiss_all_recommendation_requests', { p_operation_id: operationId }),
        'Those recommendations could not be dismissed.',
      ),
  });

  return {
    add: add.mutateAsync,
    dismiss: dismiss.mutateAsync,
    dismissAll: dismissAll.mutateAsync,
    busy: add.isPending || dismiss.isPending || dismissAll.isPending,
    newOperationId,
  };
}
