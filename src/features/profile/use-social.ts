import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { invalidateAwards } from '@/features/awards/invalidate';
import { avatarUri } from '@/lib/images';
import { diagnose } from '@/lib/diagnose';
import { supabase } from '@/lib/supabase';
import { answerWasLost, useOperationIntent } from '@/lib/operation-intent';
import { classifyWrite, mustReconcile } from '@/lib/write-outcome';

/**
 * How the viewer stands with one other account.
 *
 * Four independent facts rather than one enum, because they genuinely compose: you can
 * follow somebody who does not follow you, be followed by somebody you have blocked,
 * and have a request pending against somebody who has none against you.
 */
export type Relationship = {
  /** The viewer's outgoing edge: approved, pending, or absent. */
  following: 'approved' | 'pending' | null;
  /** Their incoming edge. `pending` here means they are waiting on the viewer. */
  followedBy: 'approved' | 'pending' | null;
  /** Whether the viewer has blocked them. Never whether they have blocked the viewer. */
  blocked: boolean;
};

const NONE: Relationship = { following: null, followedBy: null, blocked: false };

export const noRelationship = () => NONE;

type RelationshipRow = {
  user_id: string;
  following: Relationship['following'];
  followed_by: Relationship['followedBy'];
  blocked: boolean;
};

/**
 * The viewer's relationship with a set of accounts, in one round trip.
 *
 * `follow_state_with` is `security invoker`, so it can only report what `follows_read`
 * and `blocks_read` already admit — which is the caller's own edges. It cannot be
 * pointed at a pair the caller is not part of, and that is a property of the function
 * rather than of this hook.
 *
 * Keyed by the viewer, like every other viewer-relative key here. The answer is
 * *entirely* about who is asking, so a key without the account would be the same
 * defect reviews 6, 10 and 10b each found somewhere else.
 */
export function useRelationships(userIds: string[], viewerId: string) {
  const key = [...userIds].sort().join(',');

  return useQuery({
    queryKey: ['relationships', viewerId, key],
    enabled: userIds.length > 0,
    queryFn: async (): Promise<Map<string, Relationship>> => {
      const { data, error } = await supabase.rpc('follow_state_with', { p_user_ids: userIds });
      if (error) throw error;

      const map = new Map<string, Relationship>();
      for (const row of (data ?? []) as RelationshipRow[]) {
        map.set(row.user_id, {
          following: row.following,
          followedBy: row.followed_by,
          blocked: row.blocked,
        });
      }
      return map;
    },
  });
}

export type BlockedAccount = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
};

/**
 * The accounts this viewer has blocked.
 *
 * Exists because blocking closes the door behind itself, which independent review 12
 * found: `can_view_profile` goes false in both directions, so the blocked account
 * disappears from `public_profiles` and from search *including for the person who
 * blocked them* — and the Unblock control lives on that profile. Blocking was a
 * one-way trip.
 *
 * `my_blocks` is definer for exactly that reason: it must read past `profiles_read` to
 * name an account the caller deliberately made invisible. It takes no argument and can
 * only ever answer "who have I blocked".
 */
export function useMyBlocks(viewerId: string) {
  return useQuery({
    queryKey: ['my-blocks', viewerId],
    queryFn: async (): Promise<BlockedAccount[]> => {
      const { data, error } = await supabase.rpc('my_blocks');
      if (error) throw error;

      return ((data ?? []) as {
        user_id: string;
        username: string;
        display_name: string | null;
        avatar_path: string | null;
      }[]).map((row) => ({
        id: row.user_id,
        username: row.username,
        name: row.display_name || row.username,
        avatarUri: avatarUri(row.avatar_path),
      }));
    },
  });
}

export type SocialWriteResult = { ok: true } | { ok: false; message: string };

/**
 * Follow, unfollow, block, unblock, and answering a request.
 *
 * No optimism anywhere. Every one of these changes what the other person sees, and a
 * control that shows "Following" and then silently reverts is worse than one that
 * takes a beat — especially for `block`, where believing you have blocked somebody and
 * being wrong is a safety failure rather than a UI annoyance.
 *
 * Invalidation is deliberately broad: a follow moves the relationship, the profile's
 * counts, the feed's population, the Following score on every title, and who can be
 * seen at all. Enumerating those precisely would be a list to keep in step with every
 * future feature, and this is a once-in-a-while write rather than a per-keystroke one.
 */
export function useSocialWrites(viewerId: string) {
  const queryClient = useQueryClient();

  const refresh = async () => {
    await Promise.all(
      [
        ['relationships', viewerId],
        ['my-blocks', viewerId],
        ['feed', viewerId],
        ['profile'],
        ['profile-follows'],
        ['actor-activity'],
        ['following-score', viewerId],
        ['user-search'],
        ['notifications'],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
    // Mutual Mania is an intersection of the follow graph, so following back somebody
    // who already follows you moves it from 4 to 5 — and blocking moves it down, since
    // `block` deletes both edges. Not folded into the list above because that list is
    // unkeyed by account on purpose and this one must not be
    // (`awards/invalidate.ts`). Independent review 21b.
    invalidateAwards(queryClient, viewerId);
  };

  const run = async (fn: () => PromiseLike<{ error: unknown }>): Promise<SocialWriteResult> => {
    const { error } = await fn();

    /**
     * **Reconciled on an unknown outcome as well as on a commit.**
     *
     * A follow that lands and loses its reply leaves the relationship changed on the server
     * and unchanged on every surface that draws it — including `block`, where believing you
     * have blocked somebody and being wrong is a safety failure rather than a stale cache. `lib/write-outcome.ts` is what separates a refusal this app raises on
     * purpose — which proves nothing was written — from a dropped socket, a timeout, or
     * an `08007` out of the pooler, any of which can carry a committed transaction. This
     * helper used to return on any error and refresh only afterwards, which is the defect
     * independent review 21e found in four screens; it is the same defect here.
     */
    if (mustReconcile(classifyWrite(error as { code?: string }))) await refresh();

    if (error) {
      const message =
        diagnose(error) ??
        (error instanceof Error ? error.message : 'Something went wrong. Try again.');
      return { ok: false, message };
    }
    return { ok: true };
  };

  /**
   * One `busy` for all five, rather than a `useMutation` each.
   *
   * They are mutually exclusive by construction — every one of them is behind a
   * control that this same flag disables — so five independent pending flags would be
   * five ways to express one fact. A `useMutation` per verb was the first version and
   * it also broke the rules of hooks the moment the five were built by a helper.
   */
  const [busy, setBusy] = useState(false);
  const withIntent = useOperationIntent();

  const rpc = async (name: string, args: Record<string, unknown>): Promise<SocialWriteResult> => {
    if (busy) return { ok: false, message: 'One at a time.' };
    setBusy(true);
    try {
      /**
       * **The intent is the verb and who it is about**, which is exactly what the key
       * says (`lib/operation-intent.ts`).
       *
       * All five converge — a follow, an unfollow, a block, an unblock and a request
       * response each assign or delete — but `follow` is rate-limited, so a replay under
       * a fresh id after a lost reply spends a second slot for one tap and brings
       * `follows.max_per_day` forward for somebody who has not reached it. Independent
       * review 21j.
       *
       * The arguments are in the key rather than only the verb: following Ada and
       * following Grace are two intents, and sharing an id between them would have the
       * second answered `already_applied` — a control that says it worked and did
       * nothing.
       */
      return await run(() =>
        withIntent(
          `${name}:${JSON.stringify(args)}`,
          (operationId) => supabase.rpc(name, { p_operation_id: operationId, ...args }),
          answerWasLost,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return {
    follow: ({ userId }: { userId: string }) => rpc('follow', { p_followee_id: userId }),
    unfollow: ({ userId }: { userId: string }) => rpc('unfollow', { p_followee_id: userId }),
    block: ({ userId }: { userId: string }) => rpc('block', { p_blocked_id: userId }),
    unblock: ({ userId }: { userId: string }) => rpc('unblock', { p_blocked_id: userId }),
    respondToRequest: ({ userId, approve }: { userId: string; approve: boolean }) =>
      rpc('respond_follow_request', { p_requester_id: userId, p_approve: approve }),
    busy,
  };
}

/**
 * The one word a control shows for a relationship.
 *
 * In one place because three surfaces need it — a search row, a profile, and a
 * request — and three copies would drift on the case that is easiest to get wrong:
 * `pending` is "Requested" from the requester's side and "Wants to follow you" from
 * the other, and the same enum value means both.
 */
export function followLabel(relationship: Relationship): string {
  if (relationship.blocked) return 'Blocked';
  if (relationship.following === 'approved') return 'Following';
  if (relationship.following === 'pending') return 'Requested';
  if (relationship.followedBy === 'approved') return 'Follows you';
  return 'Follow';
}
