import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { invalidateAwards } from '@/features/awards/invalidate';
import { nudgePushDelivery } from '@/features/notifications/push';
import { offerPushPermission } from '@/features/notifications/push-permission';
import { track, type Surface } from '@/lib/analytics';
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
export function useSocialWrites(viewerId: string, surface: Surface) {
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
        /**
         * **The two recommendation surfaces a follow moves** (20260826000400).
         *
         * Following somebody releases every recommendation they were holding for the
         * caller, in the same transaction, on the server. That is what makes a follow
         * started on a profile page behave exactly like one started in the Requests
         * sheet — neither client replays anything, so neither can get it wrong.
         *
         * What the client does have to do is stop believing its old answer. Without
         * these two keys the compact requests row keeps its count and the released
         * titles do not appear until something else happens to refetch, which reads as
         * the release having failed.
         *
         * The other three writers earn them too: unfollowing sends that person's *next*
         * recommendation back to Requests, blocking deletes their pending ones
         * outright, and approving a follow request releases what the caller was holding
         * for the requester.
         *
         * Unkeyed by account, like every other entry in this list — the accounts on
         * both sides of a follow have surfaces that move.
         */
        ['recommendation-requests'],
        ['sent-to-you'],
        /**
         * **The picker, and the founder's silkyy report.**
         *
         * They followed a public account on the device, opened Recommend on a title,
         * and the person was not in the list. Nothing was refused and no message said
         * why — the row simply was not there, which reads as the feature not working.
         *
         * `20260826000400` had already made following somebody sufficient to send to
         * them, on the server and in `useRecommendRecipients`' query. What neither
         * touched is that the query holds a five-minute `staleTime` and **nothing
         * invalidated it when the follow graph moved**. So the picker kept answering
         * from a list assembled before the follow existed, and the only cures were
         * waiting out the cache or restarting the app.
         *
         * Every writer here earns it, not just `follow`: an unfollow removes somebody
         * from the picker, a block removes them, an unblock does not put them back
         * (`block` deleted the edge) but the list must stop being stale either way, and
         * approving a request changes nothing about the *caller's* outgoing edges —
         * which is exactly the case where being wrong is cheapest to get right by
         * refetching anyway.
         *
         * Unkeyed by account, like every other entry in this list. The alternative —
         * disabling or shortening the cache — would refetch the whole following list on
         * every open of the sheet, which is the cost this key avoids paying except at
         * the one moment the answer can have changed.
         */
        ['recommend-recipients'],
        /**
         * **People discovery is deliberately absent from this list**, and it is the one
         * entry where the obvious answer is the wrong one.
         *
         * Both suggestion lists exclude accounts the caller already follows, so a follow
         * *does* make the row it came from stale, and invalidating would be defensible on
         * correctness. What it would look like is a row disappearing from under the thumb
         * that pressed it, and the rest of the list reshuffling as the mutual counts move
         * — while the reader is halfway through working down it.
         *
         * The founder has already reported that failure once, on the For You wall: a
         * bookmark used to invalidate the slate, so saving one title discarded the whole
         * wall and put the reader back at the top of a list they were partway down.
         * `recommendations.tsx` carries that reasoning at `toggleSaveById`, and the rule
         * it settled on is the one applied here — **the list is not a function of the
         * relationship.**
         *
         * The row still answers: `FollowControl` reads `follow_state_with` through
         * `['relationships', …]`, which *is* invalidated above, so the button becomes
         * Following immediately. The suggestion itself simply stops being offered the
         * next time the section is opened, which is a minute of `staleTime` away.
         */
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
    // Mutual Mania is an intersection of the follow graph, so following back somebody
    // who already follows you moves it from 4 to 5 — and blocking moves it down, since
    // `block` deletes both edges. Not folded into the list above because that list is
    // unkeyed by account on purpose and this one must not be
    // (`awards/invalidate.ts`). Independent review 21b.
    invalidateAwards(queryClient, viewerId);
  };

  /**
   * `observe` sees the server's body, and only when the server answered.
   *
   * It exists for `follow_created`, which needs something the boolean result cannot
   * carry: whether the follow landed as `approved` or as `pending`. `follow` is the one
   * writer here that reports that, and it is the only decision in the schema about it
   * (`20260817000600`) — so reading it out of the reply is the only way to record it
   * without asking the client to guess from a visibility it may not have.
   */
  const run = async (
    fn: () => PromiseLike<{ data?: unknown; error: unknown }>,
    observe?: (data: unknown) => void,
  ): Promise<SocialWriteResult> => {
    const { data, error } = await fn();

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
    observe?.(data);
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

  const rpc = async (
    name: string,
    args: Record<string, unknown>,
    observe?: (data: unknown) => void,
  ): Promise<SocialWriteResult> => {
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
      return await run(
        () =>
          withIntent(
            `${name}:${JSON.stringify(args)}`,
            (operationId) => supabase.rpc(name, { p_operation_id: operationId, ...args }),
            answerWasLost,
          ),
        observe,
      );
    } finally {
      setBusy(false);
    }
  };

  return {
    /**
     * `follow_created` is emitted from the server's own answer, and only from `ok`.
     *
     * Three bodies are possible and only one of them is a new edge:
     *
     * - `{status: 'ok', state}` where no row existed — the edge this event is about.
     * - `{status: 'ok', state}` where a row **already existed**. `follow` returns the
     *   existing state rather than raising, so that re-following somebody you follow is
     *   not an error. It is also not a second follow, and counting it would let one
     *   person inflate the network by tapping a button that changed nothing. **The body
     *   cannot tell the two apart**, which is why the caller has to say what it knew.
     * - `{status: 'already_applied'}` — `_claim_operation` recognising a replayed id
     *   after a lost reply. Carries no `state` at all, so it emits nothing.
     *
     * `priorState` is the caller's own reading of the relationship *before* the press,
     * and it has three values rather than two. `'unknown'` is the one independent review
     * 24 was right about: `FollowControl` renders a Follow button from `noRelationship()`
     * while `follow_state_with` is still in flight, so a boolean would report "there was
     * no edge" when the honest answer is "nobody has looked". **Unknown emits nothing** —
     * an undercount in the same direction as every other event here, rather than a
     * network that looks bigger than it is.
     *
     * The complete fix is a server that reports whether it inserted. That is a migration,
     * the database is frozen for this tranche, and this closes the case that actually
     * occurs.
     */
    follow: ({
      userId,
      priorState,
    }: {
      userId: string;
      priorState: 'none' | 'existing' | 'unknown';
    }) =>
      rpc('follow', { p_followee_id: userId }, (data) => {
        const body = data as { status?: string; state?: string } | null;
        if (body?.status !== 'ok') return;
        if (body.state !== 'approved' && body.state !== 'pending') return;

        // Their phone, if they have one: the recipient's `follow` or `follow_request`
        // notification was written by the statement that just returned. Before the
        // `priorState` guard, because `unknown` is "nobody has looked" rather than
        // "nothing happened" — and a nudge that finds an empty queue costs nothing.
        nudgePushDelivery();

        if (priorState !== 'none') return;
        /**
         * **The moment PRD §15 names**, and the reason it is here rather than at launch:
         * somebody who has just followed a person has decided they care what that person
         * does, which is the whole content of a notification. It is one of two such
         * moments, and the other is an invitation.
         *
         * After the write, never before, and awaited by nothing — a permission dialog
         * must not sit between the tap and the follow. It shares the guard with
         * `follow_created` above it, so a re-follow that changed nothing does not spend
         * the one question iOS will ever present.
         *
         * `offerPushPermission` asks at most once per install and returns immediately
         * when the OS has already decided, so this being on a common path is not a cost.
         */
        void offerPushPermission('follow');
        track({ name: 'follow_created', props: { surface, state: body.state } });
      }),
    unfollow: ({ userId }: { userId: string }) => rpc('unfollow', { p_followee_id: userId }),
    block: ({ userId }: { userId: string }) => rpc('block', { p_blocked_id: userId }),
    unblock: ({ userId }: { userId: string }) => rpc('unblock', { p_blocked_id: userId }),
    respondToRequest: ({ userId, approve }: { userId: string; approve: boolean }) =>
      // Approving writes the requester a `follow_approved`, which is inbox-only
      // (PRD §15). The nudge is still right: it drains everything, and this is a
      // foreground moment like any other.
      rpc('respond_follow_request', { p_requester_id: userId, p_approve: approve }, () =>
        nudgePushDelivery(),
      ),
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
