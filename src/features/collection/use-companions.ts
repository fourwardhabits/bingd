import { useQuery, useQueryClient } from '@tanstack/react-query';

import { nudgePushDelivery } from '@/features/notifications/push';
import { readAllByKey } from '@/lib/read-all';
import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';
import { answerWasLost, useOperationIntent } from '@/lib/operation-intent';
import { classifyWrite, mustReconcile } from '@/lib/write-outcome';


export type Person = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
};

type ProfileShape = { id: string; username: string; display_name: string | null; avatar_path: string | null };

const one = <T>(value: T | T[] | null): T | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

const toPerson = (profile: ProfileShape): Person => ({
  id: profile.id,
  username: profile.username,
  name: profile.display_name || profile.username,
  avatarUri: avatarUri(profile.avatar_path),
});

/**
 * The people this user may tag: **mutual follows**, both edges approved.
 *
 * Narrowed from "either direction" by 20260817001300, so that tagging somebody and
 * recommending a title to them obey one social rule. Putting your name on somebody's
 * watch and putting a title in their inbox are the same kind of act, and a person who
 * followed you once without your following back has agreed to neither.
 *
 * Read here as well as enforced in `set_watch_tags`, and the duplication is the
 * point. The server's copy is the one that decides; this one exists so the picker
 * offers only names that will be accepted, because a picker that lets you choose
 * somebody and then refuses the whole save is worse than one that never offered them.
 *
 * **The server is more permissive than this list, on purpose.** A companion already
 * tagged on a watch stays taggable there even after the follow lapses, or the whole
 * list could never be saved again. That grandfather clause is per watch and cannot be
 * expressed by a picker that does not know which watch it is for, so the picker shows
 * the current mutuals and `useCompanions` supplies anybody already on the list.
 *
 * A block is not filtered here. `block` deletes both follow rows, so a blocked person
 * has no edge left to intersect — and if one somehow did, the server refuses.
 * Filtering blocks a second time on the client would mean reading the block graph,
 * which the schema deliberately does not expose (20260813001900).
 */
export function useTaggablePeople(userId: string) {
  return useQuery({
    queryKey: ['taggable', userId],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Person[]> => {
      // Every edge the viewer is an end of, in one request per page, read to exhaustion
      // (`lib/read-all.ts`). Both properties matter for the same reason
      // `useRecommendRecipients` gives: this is an intersection, so a short read removes
      // people from it rather than shortening it, and two snapshots can produce a pair
      // that never coexisted. Independent review 21c.
      type Edge = {
        follower_id: string;
        followee_id: string;
        follower: ProfileShape | ProfileShape[] | null;
        followee: ProfileShape | ProfileShape[] | null;
      };

      const edges = await readAllByKey<Edge>(
        (cursor, limit) => {
          const mine = `follower_id.eq.${userId},followee_id.eq.${userId}`;
          const request = supabase
            .from('follows')
            .select(
              'follower_id, followee_id, ' +
                'follower:follower_id(id, username, display_name, avatar_path), ' +
                'followee:followee_id(id, username, display_name, avatar_path)',
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

      // The intersection, which is the whole rule: somebody in one list and not the
      // other is a one-way follow.
      const outgoing = new Map<string, ProfileShape>();
      const incoming = new Set<string>();
      for (const row of edges.data ?? []) {
        if (row.follower_id === userId) {
          const profile = one(row.followee);
          if (profile) outgoing.set(profile.id, profile);
        }
        if (row.followee_id === userId) incoming.add(row.follower_id);
      }

      const byId = new Map<string, Person>();
      for (const [id, profile] of outgoing) {
        if (incoming.has(id)) byId.set(id, toPerson(profile));
      }

      return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}

/**
 * The list the picker should actually offer: current mutuals, plus anybody already
 * on this watch.
 *
 * `set_watch_tags` grandfathers a companion whose follow has since lapsed — without
 * that, narrowing the rule on 2026-08-17 would have made an old list unsaveable. The
 * picker has to agree: built from current mutuals alone it would draw a shorter list
 * than the one being saved, the count against the ten-person cap would be wrong, and
 * there would be no row to untick for the one person the reader wants to remove.
 *
 * Order is preserved from the mutual list and the survivors are appended, so the
 * people who are still connected read first.
 */
export function taggableWith(mutuals: Person[], onThisWatch: Person[]): Person[] {
  const byId = new Map(mutuals.map((person) => [person.id, person]));
  for (const person of onThisWatch) {
    if (!byId.has(person.id)) byId.set(person.id, person);
  }
  return [...byId.values()];
}

export type Companion = Person & {
  /** The tag row, which is what `hide_watch_tag` acts on. */
  tagId: string;
  hiddenByThem: boolean;
};

/**
 * Who the given user says they watched this title with.
 *
 * No RPC. `watch_tags_read` already resolves through `watch_tag_visible(id)`, which
 * folds the block, the removal and the tagger's profile visibility into one answer —
 * so an ordinary select returns exactly the tags this viewer may see, and a hidden
 * one is simply absent.
 */
export function useCompanions(taggerId: string | null, mediaItemId: string | null) {
  return useQuery({
    queryKey: ['companions', taggerId, mediaItemId],
    enabled: Boolean(taggerId && mediaItemId),
    queryFn: async (): Promise<Companion[]> => {
      const { data, error } = await supabase
        .from('watch_tags')
        .select(
          'id, removed_by_tagged, profiles:tagged_id(id, username, display_name, avatar_path)',
        )
        .eq('tagger_id', taggerId!)
        .eq('media_item_id', mediaItemId!)
        // Rows the tagger took off the list are kept, because they are what
        // remembers that the tagged person hid the tag. They are not the list.
        .eq('removed_by_tagger', false);
      if (error) throw error;

      const rows = (data ?? []) as unknown as {
        id: string;
        removed_by_tagged: boolean;
        profiles: ProfileShape | ProfileShape[] | null;
      }[];

      return rows
        .map((row) => {
          const profile = one(row.profiles);
          if (!profile) return null;
          return { ...toPerson(profile), tagId: row.id, hiddenByThem: row.removed_by_tagged };
        })
        .filter(Boolean) as Companion[];
    },
  });
}

/**
 * What a companion save reports back.
 *
 * `changed` is the same flag `collection/writes.ts` carries and means the same thing:
 * **the server may already have written this**, so the caller has state to reconcile
 * even while it shows an error. Independent review 21e found the LogSheet path that
 * needs it.
 */
export type CompanionWriteResult =
  | { ok: true; message: null }
  | { ok: false; message: string; changed: boolean };

/**
 * Saves the whole companion list for one watch.
 *
 * One call, because that is what the control is — a picker that opens, gets ticked,
 * and closes. Expressed as add and remove it would be N writes whose failures
 * interleave, and closing the sheet could leave the screen and the database
 * disagreeing with no single operation to retry.
 *
 * **Set semantics, which is what makes a retry safe.** `set_watch_tags` is handed the
 * whole list and replaces what is stored, so sending it twice stores it once — a
 * retry after an unknown outcome cannot produce a duplicate tag. That is a property of
 * the RPC rather than of the operation id, which is why it survives the caller minting
 * a fresh id for the second attempt.
 */
export function useSetCompanions(userId: string) {
  const queryClient = useQueryClient();
  const withIntent = useOperationIntent();

  return async (mediaItemId: string, taggedIds: string[]): Promise<CompanionWriteResult> => {
    /**
     * **The intent is the list itself**, so the key is the list.
     *
     * `set_watch_tags` replaces, so the tags converge whatever happens — but it is
     * rate-limited, and a replay under a fresh id spends a second slot for one tick
     * (`lib/operation-intent.ts`). Sorted, because "Ada and Raj" and "Raj and Ada" are
     * the same intent and the picker's order is not a fact about anything.
     */
    const { error } = await withIntent(
      `set_watch_tags:${mediaItemId}:${[...taggedIds].sort().join(',')}`,
      (operationId) =>
        supabase.rpc('set_watch_tags', {
          p_operation_id: operationId,
          p_media_item_id: mediaItemId,
          p_tagged_ids: taggedIds,
        }),
      answerWasLost,
    );

    const outcome = classifyWrite(error);

    /**
     * **Reconciled on an unknown outcome as well as on a commit.**
     *
     * The tag list is canonical server state and the sheet renders it. A save that
     * commits and loses its reply used to leave the sheet showing the previous list,
     * with the previous list also in cache — so nothing on the device disagreed with
     * anything, and all of it was wrong. The refetch is what makes the fallback honest.
     */
    if (mustReconcile(outcome)) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['companions', userId, mediaItemId] }),
        queryClient.invalidateQueries({ queryKey: ['feed'] }),
      ]);
    }

    if (!error) {
      // Everybody newly tagged has a `watch_tag` notification as of the statement above,
      // and this reader is the only person holding a phone on their behalf. Debounced and
      // awaited by nothing (`nudgePushDelivery`).
      nudgePushDelivery();
      return { ok: true as const, message: null };
    }

    // 42501 is the server refusing somebody in the list. The picker only offers
    // connected people, so reaching it means a follow lapsed or a block landed
    // while the sheet was open — worth saying plainly rather than as a code.
    const message =
      error.code === '42501'
        ? 'You can only tag people who follow you back.'
        : error.message;
    return { ok: false as const, message, changed: outcome === 'unknown' };
  };
}

/** The tagged person's own control: hides the tag without touching the tagger's log. */
export function useHideTag() {
  const queryClient = useQueryClient();
  const withIntent = useOperationIntent();

  return async (tagId: string) => {
    // Not rate-limited, and it assigns rather than accumulates — so this one costs
    // nothing either way. It takes an intent-scoped id because a rule that holds only
    // where it happens to matter is a rule the next writer forgets.
    const { error } = await withIntent(
      `hide_watch_tag:${tagId}`,
      (operationId) =>
        supabase.rpc('hide_watch_tag', { p_operation_id: operationId, p_tag_id: tagId }),
      answerWasLost,
    );

    // The same rule as every other writer: refetch unless the server proved it refused
    // (`lib/write-outcome.ts`). A hide that lands and loses its reply would otherwise
    // leave the tag on screen with nothing ever asking again.
    const outcome = classifyWrite(error);
    if (mustReconcile(outcome)) {
      await queryClient.invalidateQueries({ queryKey: ['companions'] });
    }

    if (error) return { ok: false as const, message: error.message, changed: outcome === 'unknown' };
    return { ok: true as const, message: null };
  };
}
