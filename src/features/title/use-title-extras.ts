import { useQuery } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

export type TitleVideo = {
  id: string;
  key: string;
  name: string;
  type: string;
  official: boolean;
};

/**
 * Trailers for a title.
 *
 * Returns an empty list until the adapter has been redeployed with the `videos`
 * facet, which is deliberate: the tab is rendered only when this has something in it,
 * so nothing ships a Videos tab with nothing behind it. `20260816000500` records why
 * the schema knows about videos before anything fetches them.
 */
export function useTitleVideos(mediaItemId: string | null) {
  return useQuery({
    queryKey: ['videos', mediaItemId],
    enabled: Boolean(mediaItemId),
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<TitleVideo[]> => {
      const { data, error } = await supabase
        .from('media_cache')
        .select('payload')
        .eq('media_item_id', mediaItemId!)
        .eq('facet', 'videos')
        .maybeSingle();
      if (error) throw error;

      const payload = data?.payload as { results?: TitleVideo[] } | undefined;
      return payload?.results ?? [];
    },
  });
}

export type TitleNote = {
  userId: string;
  username: string;
  name: string;
  avatarUri: string | null;
  note: string;
  hasSpoilers: boolean;
  updatedAt: string | null;
};

/**
 * What people have written about this exact title.
 *
 * Two queries, because `public_notes` is a definer function that projects only the
 * note columns — it cannot embed a profile, and it should not: widening it to join
 * `profiles` would put a second table's exposure decisions inside a function whose
 * whole justification is that it exposes exactly five columns of one table.
 *
 * So the notes come back first, and the names are resolved from `public_profiles`,
 * which is the view that already exists for exactly this. Both reads are already
 * authorised — a note only arrives if `can_view_profile` said so — and a profile that
 * fails to resolve drops its note rather than rendering an anonymous one.
 */
export function useTitleNotes(mediaItemId: string | null) {
  return useQuery({
    queryKey: ['title-notes', mediaItemId],
    enabled: Boolean(mediaItemId),
    queryFn: async (): Promise<TitleNote[]> => {
      const { data, error } = await supabase.rpc('public_notes', {
        p_user_ids: null,
        p_media_item_ids: [mediaItemId],
        p_limit: 25,
      });
      if (error) throw error;

      const notes = (data ?? []) as {
        user_id: string;
        note: string;
        has_spoilers: boolean;
        updated_at: string | null;
      }[];
      if (!notes.length) return [];

      const { data: people, error: peopleError } = await supabase
        .from('public_profiles')
        .select('id, username, display_name, avatar_path')
        .in('id', [...new Set(notes.map((note) => note.user_id))]);
      if (peopleError) throw peopleError;

      const byId = new Map(
        (people ?? []).map((person) => [
          person.id as string,
          person as { id: string; username: string; display_name: string | null; avatar_path: string | null },
        ]),
      );

      return notes
        .map((note) => {
          const person = byId.get(note.user_id);
          if (!person) return null;
          return {
            userId: note.user_id,
            username: person.username,
            name: person.display_name || person.username,
            avatarUri: avatarUri(person.avatar_path),
            note: note.note,
            hasSpoilers: note.has_spoilers,
            updatedAt: note.updated_at,
          };
        })
        .filter(Boolean) as TitleNote[];
    },
  });
}
