import { useQuery, useQueryClient } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

import { newOperationId } from './writes';

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
      const [following, followers] = await Promise.all([
        supabase
          .from('follows')
          .select('profiles:followee_id(id, username, display_name, avatar_path)')
          .eq('follower_id', userId)
          .eq('state', 'approved'),
        supabase
          .from('follows')
          .select('profiles:follower_id(id, username, display_name, avatar_path)')
          .eq('followee_id', userId)
          .eq('state', 'approved'),
      ]);

      if (following.error) throw following.error;
      if (followers.error) throw followers.error;

      // The intersection, which is the whole rule: somebody in one list and not the
      // other is a one-way follow.
      const outgoing = new Map<string, ProfileShape>();
      for (const row of following.data ?? []) {
        const profile = one((row as { profiles: ProfileShape | ProfileShape[] | null }).profiles);
        if (profile) outgoing.set(profile.id, profile);
      }

      const byId = new Map<string, Person>();
      for (const row of followers.data ?? []) {
        const profile = one((row as { profiles: ProfileShape | ProfileShape[] | null }).profiles);
        if (profile && outgoing.has(profile.id)) byId.set(profile.id, toPerson(profile));
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
 * Saves the whole companion list for one watch.
 *
 * One call, because that is what the control is — a picker that opens, gets ticked,
 * and closes. Expressed as add and remove it would be N writes whose failures
 * interleave, and closing the sheet could leave the screen and the database
 * disagreeing with no single operation to retry.
 */
export function useSetCompanions(userId: string) {
  const queryClient = useQueryClient();

  return async (mediaItemId: string, taggedIds: string[]) => {
    const { error } = await supabase.rpc('set_watch_tags', {
      p_operation_id: newOperationId(),
      p_media_item_id: mediaItemId,
      p_tagged_ids: taggedIds,
    });

    if (error) {
      // 42501 is the server refusing somebody in the list. The picker only offers
      // connected people, so reaching it means a follow lapsed or a block landed
      // while the sheet was open — worth saying plainly rather than as a code.
      const message =
        error.code === '42501'
          ? 'You can only tag people who follow you back.'
          : error.message;
      return { ok: false as const, message };
    }

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['companions', userId, mediaItemId] }),
      queryClient.invalidateQueries({ queryKey: ['feed'] }),
    ]);
    return { ok: true as const, message: null };
  };
}

/** The tagged person's own control: hides the tag without touching the tagger's log. */
export function useHideTag() {
  const queryClient = useQueryClient();

  return async (tagId: string) => {
    const { error } = await supabase.rpc('hide_watch_tag', {
      p_operation_id: newOperationId(),
      p_tag_id: tagId,
    });
    if (error) return { ok: false as const, message: error.message };

    await queryClient.invalidateQueries({ queryKey: ['companions'] });
    return { ok: true as const, message: null };
  };
}
