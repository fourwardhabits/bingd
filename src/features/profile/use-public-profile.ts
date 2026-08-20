import { useQuery } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';

export type PublicProfile = {
  id: string;
  username: string;
  name: string;
  /** The line they wrote about themselves, under the handle. Null until they do. */
  bio: string | null;
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
        .select('id, username, display_name, bio, avatar_path, created_at')
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
        bio: (profile.bio as string | null) ?? null,
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

/**
 * The four numbers a profile header shows, for the viewer's own account.
 *
 * `usePublicProfile` reads them through `public_profiles` for somebody else. The own
 * profile cannot use that path — it already has the identity from the session and
 * looking itself up by handle would be a round trip to learn what it knows — so this
 * fetches the counts alone, in the same shape, and `ProfileIdentity` cannot tell which
 * screen it is on.
 *
 * Four rather than the five the own profile used to show. Followers, Following, Movies
 * and TV seasons describe the account as a collection; Watched and Watchlist are the
 * reader's own working state and belong in Collection, where they can be acted on. At
 * five columns a three-digit number wrapped.
 */
export function useProfileStats(userId: string) {
  return useQuery({
    queryKey: ['profile-stats', userId],
    queryFn: async () => {
      const [followers, following, movies, seasons] = await Promise.all([
        supabase
          .from('follows')
          .select('*', { count: 'exact', head: true })
          .eq('followee_id', userId)
          .eq('state', 'approved'),
        supabase
          .from('follows')
          .select('*', { count: 'exact', head: true })
          .eq('follower_id', userId)
          .eq('state', 'approved'),
        supabase
          .from('rankings')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('category', 'movies'),
        supabase
          .from('rankings')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('category', 'tv_seasons'),
      ]);

      if (followers.error) throw followers.error;
      if (following.error) throw following.error;
      if (movies.error) throw movies.error;
      if (seasons.error) throw seasons.error;

      return {
        followers: followers.count ?? 0,
        following: following.count ?? 0,
        rankedMovies: movies.count ?? 0,
        rankedSeasons: seasons.count ?? 0,
      };
    },
  });
}

/**
 * The minimum needed to draw somebody the viewer may not read.
 *
 * **Discovery is worthless if the row leads nowhere.** `20260819000100` made a private
 * account findable by name; before this hook, tapping one landed on "This profile is not
 * available" — the same answer as a handle nobody has taken — with no way to ask. That
 * turned the private setting from a door into a wall, which is the thing the migration
 * exists to stop.
 *
 * `profile_identity` answers for **every** discoverable account, public ones included,
 * and that is deliberate rather than convenient: a screen that only reached for it when
 * `public_profiles` came back empty would make "which call succeeded" a report of
 * somebody's visibility setting to anybody watching the network.
 *
 * It carries identity and nothing else — handle, display name, avatar, visibility. The
 * collection, the activity, the counts, the notes and the goals all stay behind
 * `can_view_profile`, which this migration did not touch.
 */
export type ProfileIdentitySummary = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
  visibility: 'public' | 'private';
};

export function useProfileIdentity(username: string | null) {
  return useQuery({
    queryKey: ['profile-identity', username ?? ''],
    enabled: Boolean(username),
    queryFn: async (): Promise<ProfileIdentitySummary | null> => {
      const { data, error } = await supabase.rpc('profile_identity', { p_username: username });
      if (error) throw error;

      // A set-returning function comes back as an array; nobody by that handle, or an
      // account this viewer may not find, is an empty one.
      const row = (Array.isArray(data) ? data[0] : data) as
        | { id: string; username: string; display_name: string | null; avatar_path: string | null; visibility: 'public' | 'private' }
        | undefined;
      if (!row) return null;

      return {
        id: row.id,
        username: row.username,
        name: row.display_name || row.username,
        avatarUri: avatarUri(row.avatar_path),
        visibility: row.visibility,
      };
    },
  });
}
