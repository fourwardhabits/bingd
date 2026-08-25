import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { invalidateAwards } from '@/features/awards/invalidate';
import { nudgePushDelivery } from '@/features/notifications/push';
import { offerPushPermission } from '@/features/notifications/push-permission';
import { track, type Surface } from '@/lib/analytics';
import { diagnose } from '@/lib/diagnose';
import { readAllByKey } from '@/lib/read-all';
import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';
import { classifyWrite } from '@/lib/write-outcome';

/**
 * The send half of friend recommendations (20260817001300, 20260826000400).
 *
 * The recipient rule is **the people the sender approvedly follows**, and it lives in
 * the database. What lives here is the same rule expressed as a query, so that the
 * sheet offers only people the server will accept — a picker that lets you choose
 * somebody and then refuses is worse than one that never offered them. The duplication
 * is deliberate and the server's copy is the one that decides; this one is a courtesy.
 *
 * **It was an intersection of both directions until 2026-08-26, and that was the bug.**
 * A mutual follow was required to send, so somebody who followed twenty accounts and
 * was followed back by three could recommend to three — and the other seventeen were
 * not refused with a reason, they were *absent from the picker*, which reads as the
 * feature not working. Following somebody is now enough. Whether they follow back
 * decides only whether it arrives directly or waits as a request, and the sender is
 * deliberately not told which (§17 of the tranche brief).
 */

export type Recipient = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
};

type ProfileShape = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  status: string;
};

const one = <T>(value: T | T[] | null): T | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

/**
 * Everybody the viewer approvedly follows.
 *
 * **The viewer's own outgoing edges and nothing else** (20260826000400). It used to be
 * the intersection of both directions, which is the picker half of the mutual-follow
 * bug: it silently removed everybody who had not followed back, and there was no
 * message anywhere saying why they were missing.
 *
 * A `follower_id.eq` filter rather than a read of the whole directory narrowed on the
 * client, and that matters for more than efficiency: `follows_read` admits a row only
 * where the caller is a party to it, so this query *cannot* see anybody else's graph —
 * which is what makes it safe to run from a client at all. The server's authorisation
 * (`_may_recommend_to`) tests exactly this edge, so the picker and the rule agree.
 *
 * Blocks are not filtered here and do not need to be: `block` deletes both follow rows,
 * so a blocked person has no edge left to find. Suspension is filtered, because a
 * suspended account keeps its edges and should stop being offered.
 *
 * A **pending** follow request is deliberately excluded — `state = 'approved'` — which
 * is the server's rule too. Asking to follow somebody is not following them.
 */
export function useRecommendRecipients(viewerId: string) {
  return useQuery({
    queryKey: ['recommend-recipients', viewerId],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Recipient[]> => {
      /**
       * Every outgoing edge, in one request per page (`lib/read-all.ts`).
       *
       * **It is read to exhaustion.** PostgREST caps an unbounded select at 1,000 rows,
       * and somebody who follows more than that would simply not see the rest of their
       * own following list in the picker. Kept from the intersection this replaced,
       * where a short read was worse still: it *removed* people rather than truncating.
       *
       * **And it no longer has to be a snapshot.** The intersection this replaced was
       * one request for a reason: read the outgoing side, have `me → A` deleted, have
       * `A → me` approved, then read the incoming side, and the picker offered a mutual
       * that never existed. One direction has no such seam — a row either is the
       * viewer's approved follow or it is not — so the paging here is ordinary rather
       * than load-bearing. Independent review 21c is what put it in one request;
       * `use-awards.ts` still carries the two-direction predicate, because Mutual Mania
       * genuinely is about both.
       */
      type Edge = {
        follower_id: string;
        followee_id: string;
        followee: ProfileShape | ProfileShape[] | null;
      };

      const edges = await readAllByKey<Edge>(
        (cursor, limit) => {
          const request = supabase
            .from('follows')
            .select(
              'follower_id, followee_id, ' +
                'followee:followee_id(id, username, display_name, avatar_path, status)',
            )
            .eq('state', 'approved')
            .eq('follower_id', viewerId);

          return (cursor === null ? request : request.gt('followee_id', cursor[1]))
            .order('follower_id', { ascending: true })
            .order('followee_id', { ascending: true })
            .limit(limit);
        },
        (row) => [row.follower_id, row.followee_id],
      );

      if (edges.error) throw edges.error;

      // One direction, which is now the whole rule: whether they follow back decides
      // where the recommendation lands, not whether it may be sent.
      const following: Recipient[] = [];
      for (const row of edges.data ?? []) {
        const profile = one(row.followee);
        if (!profile) continue;
        // A suspended account keeps its edges and should stop being offered. A block does
        // not need filtering: `block` deletes both rows, so there is no edge left to find.
        if (profile.status !== 'active') continue;
        following.push({
          id: profile.id,
          username: profile.username,
          name: profile.display_name || profile.username,
          avatarUri: avatarUri(profile.avatar_path),
        });
      }

      return following.sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}

/**
 * A simple contains match over name and handle, for a list that has outgrown reading.
 *
 * Over the *following* list and never over the directory. Searching everybody and
 * filtering the results on the client would make the picker a people-search that
 * happens to refuse most of what it finds, and would put accounts the sender has no
 * relationship with in front of them. §16 of the tranche brief, and the server agrees:
 * `_may_recommend_to` tests the same edge this list is built from.
 */
export function filterRecipients(people: Recipient[], query: string): Recipient[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return people;
  return people.filter(
    (person) =>
      person.name.toLowerCase().includes(needle) ||
      person.username.toLowerCase().includes(needle),
  );
}

/**
 * `changed` carries the same meaning it does in `collection/writes.ts`: **the send may
 * already have happened**, so the caches that describe sends have to be reconciled even
 * while the sheet shows an error. Absent means the server answered no — either as a
 * SQLSTATE this app raises on purpose, or as a `refused` in a 200's body, which is how
 * `recommend_title` declines a recipient (see `REFUSALS` below).
 */
export type SendResult = { ok: true } | { ok: false; message: string; changed?: boolean };

/**
 * What the server says when it will not send.
 *
 * `recommend_title` returns its refusals rather than raising them, so that a refused
 * attempt still costs the sender a slot against the hourly ceiling — see the header of
 * `20260817001300`. The consequence here is that **a 200 is not a success**, and the
 * body has to be read.
 *
 * `not_following` covers a stranger, somebody who follows the sender without being
 * followed back, a block in either direction and a suspended account, all as one
 * answer. The wording is about the relationship rather than about the person, which is
 * both the honest reading and the one that does not tell somebody they have been
 * blocked. It replaced `not_mutual` on 2026-08-26, and the old key is kept below for
 * the window in which a friend-beta build that has not taken the update is still
 * calling a server that has: the message it produced was *wrong* under the new rule, so
 * mapping it to the new sentence is the closest thing to right.
 *
 * `too_many_pending` says how many are waiting and nothing at all about what the
 * recipient has done with the others — see §22. "They dismissed four of yours" is the
 * oracle the whole state model is arranged to avoid, said out loud.
 */
const REFUSALS: Record<string, string> = {
  not_following: 'You can recommend titles to people you follow.',
  not_mutual: 'You can recommend titles to people you follow.',
  too_many_pending: 'They already have several recommendations from you waiting.',
  yourself: 'You cannot recommend a title to yourself.',
  not_recommendable: 'You can recommend a film or a season, not a whole series.',
};

/**
 * Sending one.
 *
 * One recipient per call, which is the V1 shape: no multi-select, no send-to-all, no
 * message. Refusals arrive in the body and errors arrive as codes, and both become
 * sentences here rather than reaching the sheet as either.
 */
export function useRecommendTitle(viewerId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    /**
     * **The operation id comes from the caller**, for the reason independent review 21i
     * gave: a unique key on (sender, recipient, title) stops a duplicate *row*, and that
     * is not the same as the operation being idempotent.
     *
     * A send commits, the reply is lost, the sheet stays open and reports a failure, and
     * the person taps the same name again. With a fresh id: `_claim_operation` lets it
     * through, so it counts a second time against `recommendations.max_per_hour` and
     * `max_per_day` — one intent, two slots — and the `else` branch moves
     * `recommended_at` to now, reordering the recipient's list on the strength of a
     * send they were already shown. A wrong quota and a wrong screen from one tap.
     *
     * With the id held, `_claim_operation` answers `already_applied`, which is the exact
     * mechanism `20260817001300` built for it.
     */
    mutationFn: async ({
      operationId,
      recipientId,
      mediaItemId,
    }: {
      operationId: string;
      recipientId: string;
      mediaItemId: string;
    }): Promise<SendResult> => {
      const { data, error } = await supabase.rpc('recommend_title', {
        p_operation_id: operationId,
        p_recipient_id: recipientId,
        p_media_item_id: mediaItemId,
      });

      if (error) {
        // A rate limit and an `assert_can_write` are both refusals this app raises on
        // purpose, so nothing was sent. Anything else may have been
        // (`lib/write-outcome.ts`), and `onSuccess` below reconciles on it.
        const changed = classifyWrite(error) === 'unknown';
        switch (error.code) {
          case '53400':
            return {
              ok: false,
              message: 'You have sent a lot of recommendations today. Try again later.',
            };
          // assert_can_write. The only 42501 left on this path, now that a refused
          // recipient comes back in the body instead.
          case '42501':
            return { ok: false, message: 'Your account cannot make changes right now.' };
          default:
            return { ok: false, message: diagnose(error) ?? error.message, changed };
        }
      }

      const result = data as { status?: string; reason?: string } | null;
      if (result?.status === 'refused') {
        return {
          ok: false,
          message: REFUSALS[result.reason ?? ''] ?? 'That recommendation could not be sent.',
        };
      }

      // The recipient's `recommendation` notification was written by the statement above,
      // and this is the only moment anybody is holding a phone on its behalf. Fire and
      // forget, and debounced (`nudgePushDelivery`).
      nudgePushDelivery();
      return { ok: true };
    },
    /**
     * `recommend_title` returns its refusals in the body, so a 200 that says
     * `not_following` must not move anything — that one is a genuine "nothing happened".
     *
     * **But a failure whose outcome is unknown must.** The row may be in
     * `title_recommendations`, in which case the recipient's list, the picker's
     * already-sent set and Hype Courier are all describing the state before it.
     * Independent review 21e's invariant, in the send path.
     */
    onSuccess: (result) => {
      if (!result.ok && !result.changed) return;
      void queryClient.invalidateQueries({ queryKey: ['sent-to-you'] });
      void queryClient.invalidateQueries({ queryKey: ['recommend-recipients', viewerId] });
      // Hype Courier counts recommendations sent (`awards/invalidate.ts`). Review 21b.
      invalidateAwards(queryClient, viewerId);
    },
  });
}

/**
 * The one reusable personal link, and the record that it was created.
 *
 * Returns null rather than throwing when the link cannot be minted. Sharing a title
 * with somebody who is not on Bingd is the point of the control; failing the whole
 * share because the growth instrumentation was unavailable would be the tail wagging
 * the dog.
 */
export async function createInviteLink(
  mediaItemId: string | null,
  /**
   * **The operation id belongs to the share, not to the attempt.**
   *
   * The token itself is stable — the function reuses the caller's existing one — but the
   * `invite_link_creations` row beside it is an unconditional insert, and that is the
   * half that counts. So: the insert commits, the reply is lost, this returns `null`, the
   * sheet degrades to sharing the title without the link, and the person presses Share
   * again *because the first attempt did not do what they wanted*. A fresh id walks
   * straight past `_claim_operation` and records a second creation for one intent.
   *
   * That is one wrong number in the growth instrumentation with no exception anywhere,
   * which is the exact shape this section has been closing. Independent review 21h found
   * it after 21g's PASS, in the sweep 21h existed to make.
   */
  operationId: string,
  /** Where the share was started from, for `invite_link_created`. */
  surface: Surface,
): Promise<string | null> {
  const { data, error } = await supabase.rpc('create_invite_link', {
    p_operation_id: operationId,
    p_media_item_id: mediaItemId,
  });
  if (error) return null;

  const body = data as { status?: string; token?: string } | null;

  /**
   * `invite_link_created` follows the **row**, not the tap.
   *
   * `create_invite_link` writes one `invite_link_creations` row per accepted call and
   * answers `already_applied` — with the same token, so the share still works — when
   * `_claim_operation` recognises a replayed id. That replay writes nothing, so it must
   * count nothing. It is the exact case the held operation id exists for: a creation
   * that commits, loses its reply, and is retried because the person was told the share
   * had failed (independent review 21h).
   *
   * The event is emitted here rather than at the share sheet for the same reason the id
   * is released here: what is being counted is the creation being recorded, not the
   * message going out. Opening a share sheet is not an invitation sent, and this is the
   * one stage of that funnel the app can measure honestly
   * (`docs/product/growth-instrumentation.md`).
   */
  if (body?.status === 'ok') {
    track({ name: 'invite_link_created', props: { surface, has_title: Boolean(mediaItemId) } });
    /**
     * The second of PRD §15's two moments, and the one with the longest payoff: the
     * notification an invitation earns — somebody joined from your invite — arrives days
     * later, when the app is closed. It is the one event in this product that cannot be
     * replaced by opening the app at the right moment, which is what makes minting a link
     * the honest place to ask.
     *
     * Behind the same `status === 'ok'` guard the event above uses, so a replayed
     * operation id — a share whose reply was lost and was pressed again — does not spend
     * the one question iOS will ever present. Awaited by nothing: the share sheet opens
     * next and must not wait behind a dialog.
     */
    void offerPushPermission('invite');
  }

  const token = body?.token;
  return token ? `https://bingd.app/i/${token}` : null;
}
