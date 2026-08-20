import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { invalidateAwards } from '@/features/awards/invalidate';
import { track, type Surface } from '@/lib/analytics';
import { diagnose } from '@/lib/diagnose';
import { readAllByKey } from '@/lib/read-all';
import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';
import { classifyWrite } from '@/lib/write-outcome';

/**
 * The send half of friend recommendations (20260817001300).
 *
 * The recipient rule is **mutual follow**, and it lives in the database. What lives
 * here is the same rule expressed as a query, so that the sheet offers only people the
 * server will accept — a picker that lets you choose somebody and then refuses is
 * worse than one that never offered them. The duplication is deliberate and the
 * server's copy is the one that decides; this one is a courtesy.
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
 * Everybody the viewer and the other person follow, both ways, both approved.
 *
 * Two selects intersected rather than one join, because `follows_read` admits a row
 * only where the caller is a party to it — which is exactly what makes this safe to
 * run from the client at all. Neither query can see anybody else's graph.
 *
 * Blocks are not filtered here and do not need to be: `block` deletes both follow
 * rows, so a blocked person has no edges left to intersect. Suspension is filtered,
 * because a suspended account keeps its edges and should stop being offered.
 */
export function useRecommendRecipients(viewerId: string) {
  return useQuery({
    queryKey: ['recommend-recipients', viewerId],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Recipient[]> => {
      /**
       * Every edge the viewer is an end of, in one request per page (`lib/read-all.ts`).
       *
       * Two things changed here at once and each is worth naming.
       *
       * **It is read to exhaustion.** PostgREST caps an unbounded select at 1,000 rows,
       * and this is an intersection: a short read does not shorten the list, it *removes
       * people from it*, so a mutual the reader has followed for a year would simply not
       * appear in the picker.
       *
       * **And it is one request rather than two.** It used to be a select per direction,
       * intersected. That is not a snapshot: read the outgoing side, have `me → A`
       * deleted, have `A → me` approved, then read the incoming side, and the picker
       * offers a mutual that never existed. `recommend_title` refuses it — the server's
       * copy of the rule is the one that decides — but the founder's brief is that a
       * picker offering somebody it will then refuse is the failure to avoid.
       * Independent review 21c; `use-awards.ts` carries the same predicate for the same
       * reason.
       */
      type Edge = {
        follower_id: string;
        followee_id: string;
        follower: ProfileShape | ProfileShape[] | null;
        followee: ProfileShape | ProfileShape[] | null;
      };

      const edges = await readAllByKey<Edge>(
        (cursor, limit) => {
          const mine = `follower_id.eq.${viewerId},followee_id.eq.${viewerId}`;
          const request = supabase
            .from('follows')
            .select(
              'follower_id, followee_id, ' +
                'follower:follower_id(id, username, display_name, avatar_path, status), ' +
                'followee:followee_id(id, username, display_name, avatar_path, status)',
            )
            .eq('state', 'approved');

          return (
            cursor === null
              ? request.or(mine)
              : request.or(
                  `and(follower_id.gt.${cursor[0]},or(${mine})),` +
                    `and(follower_id.eq.${cursor[0]},followee_id.gt.${cursor[1]},or(${mine}))`,
                )
          )
            .order('follower_id', { ascending: true })
            .order('followee_id', { ascending: true })
            .limit(limit);
        },
        (row) => [row.follower_id, row.followee_id],
      );

      if (edges.error) throw edges.error;

      // The intersection, which is the whole rule: somebody on one side and not the other
      // is a one-way follow.
      const outgoing = new Map<string, ProfileShape>();
      const incoming = new Set<string>();
      for (const row of edges.data ?? []) {
        if (row.follower_id === viewerId) {
          const profile = one(row.followee);
          if (profile) outgoing.set(profile.id, profile);
        }
        if (row.followee_id === viewerId) incoming.add(row.follower_id);
      }

      const mutuals: Recipient[] = [];
      for (const [id, profile] of outgoing) {
        if (!incoming.has(id)) continue;
        // A suspended account keeps its edges and should stop being offered. A block does
        // not need filtering: `block` deletes both rows, so there is nothing to intersect.
        if (profile.status !== 'active') continue;
        mutuals.push({
          id: profile.id,
          username: profile.username,
          name: profile.display_name || profile.username,
          avatarUri: avatarUri(profile.avatar_path),
        });
      }

      return mutuals.sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}

/** A simple contains match over name and handle, for a list that has outgrown reading. */
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
 * `not_mutual` covers a stranger, a one-way follow, a block in either direction and a
 * suspended account, all as one answer. The wording is about the relationship rather
 * than about the person, which is both the honest reading and the one that does not
 * tell somebody they have been blocked.
 */
const REFUSALS: Record<string, string> = {
  not_mutual: 'You can only recommend to people who follow you back.',
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

      return { ok: true };
    },
    /**
     * `recommend_title` returns its refusals in the body, so a 200 that says
     * `not_mutual` must not move anything — that one is a genuine "nothing happened".
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
  }

  const token = body?.token;
  return token ? `https://bingd.app/i/${token}` : null;
}
