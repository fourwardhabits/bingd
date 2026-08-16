import { useQuery } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';

export type PublicProfile = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
  memberSince: string | null;
  followers: number;
  following: number;
  rankedMovies: number;
  rankedSeasons: number;
};

/**
 * Somebody else's profile, by username.
 *
 * Every read here is one the schema already authorises, and the shape of that is the
 * point: this hook adds no visibility logic of its own, because a second copy of the
 * rule is a second thing to get wrong.
 *
 *   `public_profiles`   a `security_invoker` view over `profiles`, so `profiles_read`
 *                       applies and a private account the viewer does not follow
 *                       simply does not come back.
 *   `rankings`          `rankings_read` is `can_i_view(user_id)`.
 *   `follows`           counts of approved rows, which `follows_read` permits for a
 *                       viewable pair.
 *
 * A profile that resolves to nothing is not distinguished from one that does not
 * exist. PRD §16 asks for exactly that: a 404 for a private account is itself a
 * disclosure that the account is there.
 *
 * Deliberately absent: `user_media`. The Logged collection inherits profile
 * visibility (PRD §22), but its row carries the watch date and the note, which do
 * not — so a public profile is built from `rankings`, which carries neither, and
 * notes arrive separately through `public_notes` where visibility is per note.
 */
export function usePublicProfile(username: string | null) {
  return useQuery({
    queryKey: queryKeys.profile(username ?? ''),
    enabled: Boolean(username),
    queryFn: async (): Promise<PublicProfile | null> => {
      const { data: profile, error } = await supabase
        .from('public_profiles')
        .select('id, username, display_name, avatar_path, created_at')
        .eq('username', username!)
        .maybeSingle();
      if (error) throw error;
      if (!profile) return null;

      const id = profile.id as string;

      const [followers, following, movies, seasons] = await Promise.all([
        supabase
          .from('follows')
          .select('*', { count: 'exact', head: true })
          .eq('followee_id', id)
          .eq('state', 'approved'),
        supabase
          .from('follows')
          .select('*', { count: 'exact', head: true })
          .eq('follower_id', id)
          .eq('state', 'approved'),
        supabase
          .from('rankings')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', id)
          .eq('category', 'movies'),
        supabase
          .from('rankings')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', id)
          .eq('category', 'tv_seasons'),
      ]);

      return {
        id,
        username: profile.username as string,
        name: (profile.display_name as string | null) || (profile.username as string),
        avatarUri: avatarUri(profile.avatar_path as string | null),
        memberSince: (profile.created_at as string | null) ?? null,
        followers: followers.count ?? 0,
        following: following.count ?? 0,
        rankedMovies: movies.count ?? 0,
        rankedSeasons: seasons.count ?? 0,
      };
    },
  });
}

export type ProfileNote = {
  mediaItemId: string;
  title: string;
  seriesTitle: string | null;
  kind: 'movie' | 'series' | 'season';
  posterPath: string | null;
  note: string;
  hasSpoilers: boolean;
  updatedAt: string | null;
};

/**
 * A person's public notes, newest first.
 *
 * `public_notes` returns the note columns and the media item's id, and nothing about
 * the title — it projects five columns of `user_media` on purpose, and widening it to
 * join the catalogue would put a second table inside a function whose justification
 * is how little it exposes. So the titles are a second read of `media_items`, which
 * is world-readable.
 */
export function useProfileNotes(userId: string | null) {
  return useQuery({
    queryKey: ['profile-notes', userId],
    enabled: Boolean(userId),
    queryFn: async (): Promise<ProfileNote[]> => {
      const { data, error } = await supabase.rpc('public_notes', {
        p_user_ids: [userId],
        p_media_item_ids: null,
        p_limit: 50,
      });
      if (error) throw error;

      const notes = (data ?? []) as {
        media_item_id: string;
        note: string;
        has_spoilers: boolean;
        updated_at: string | null;
      }[];
      if (!notes.length) return [];

      const { data: media, error: mediaError } = await supabase
        .from('media_items')
        .select('id, kind, title, poster_path, parent:parent_id(title)')
        .in('id', [...new Set(notes.map((note) => note.media_item_id))]);
      if (mediaError) throw mediaError;

      const byId = new Map(
        ((media ?? []) as unknown as {
          id: string;
          kind: ProfileNote['kind'];
          title: string;
          poster_path: string | null;
          parent: { title: string } | { title: string }[] | null;
        }[]).map((item) => [item.id, item]),
      );

      return notes
        .map((note) => {
          const item = byId.get(note.media_item_id);
          if (!item) return null;
          const parent = Array.isArray(item.parent) ? item.parent[0] : item.parent;
          return {
            mediaItemId: note.media_item_id,
            title: item.title,
            seriesTitle: parent?.title ?? null,
            kind: item.kind,
            posterPath: item.poster_path,
            note: note.note,
            hasSpoilers: note.has_spoilers,
            updatedAt: note.updated_at,
          };
        })
        .filter(Boolean) as ProfileNote[];
    },
  });
}
