import { useQuery } from '@tanstack/react-query';

import type { Bucket } from '@/features/collection/score';
import { avatarUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';

export type FeedItem = {
  id: string;
  type: 'title_ranked' | 'title_logged' | 'season_completed';
  actorId: string;
  actorUsername: string;
  actorName: string;
  actorAvatarUri: string | null;
  mediaItemId: string | null;
  title: string | null;
  year: number | null;
  posterPath: string | null;
  genres: string[];
  runtimeMinutes: number | null;
  createdAt: string;
  position: number | null;
  /**
   * Snapshotted at rank time, not derived here.
   *
   * A score is a title's place within its owner's band, so computing one needs
   * that person's whole ranking — which a viewer cannot read and should not be
   * able to. `_rank_finalize` writes it into the payload instead
   * (20260815010000). A snapshot is arguably the more correct thing for an
   * activity item anyway: it records what the moment was.
   */
  score: number | null;
  bucket: Bucket | null;
  category: 'movies' | 'tv_seasons' | null;
};

type Embedded<T> = T | T[] | null;

type MediaShape = {
  title: string;
  release_date: string | null;
  poster_path: string | null;
  genres: string[] | null;
  runtime_minutes: number | null;
};

type ProfileShape = {
  username: string;
  display_name: string | null;
  avatar_path: string | null;
};

type FeedRow = {
  id: string;
  type: string;
  actor_id: string;
  media_item_id: string | null;
  created_at: string;
  payload: {
    position?: number;
    category?: 'movies' | 'tv_seasons';
    score?: number;
    bucket?: Bucket;
  } | null;
  media_items: Embedded<MediaShape>;
  profiles: Embedded<ProfileShape>;
};

/**
 * PostgREST returns a to-one embed as an object and a to-many as an array, and
 * its generated types say array for both.
 *
 * Indexing `[0]` into the object therefore yields undefined and every fallback
 * fires at once — which is exactly how the feed came to read "Someone ranked a
 * title." on every row, including the user's own activity, where an unnamed
 * actor is impossible by construction.
 */
const one = <T>(value: Embedded<T>): T | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

export function useFeed(userId: string) {
  return useQuery({
    queryKey: queryKeys.feed(userId),
    queryFn: async (): Promise<FeedItem[]> => {
      const { data: follows, error: followsError } = await supabase
        .from('follows')
        .select('followee_id')
        .eq('follower_id', userId)
        .eq('state', 'approved');
      if (followsError) throw followsError;

      const actorIds = [userId, ...(follows ?? []).map((row) => row.followee_id)];
      const { data, error } = await supabase
        .from('feed_events')
        .select(
          'id, type, actor_id, media_item_id, created_at, payload, ' +
            'media_items(title, release_date, poster_path, genres, runtime_minutes), ' +
            'profiles:actor_id(username, display_name, avatar_path)',
        )
        .in('actor_id', actorIds)
        .in('type', ['title_ranked', 'title_logged', 'season_completed'])
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) throw error;

      const items: FeedItem[] = [];

      for (const row of (data ?? []) as unknown as FeedRow[]) {
        const profile = one(row.profiles);
        const media = one(row.media_items);

        // An activity item whose subject is "Someone" is not an activity item.
        // An unresolvable actor means a failed join or a policy hiding a row
        // that should be visible, and absorbing that behind a plausible
        // fallback is what let the bug above survive to a screenshot. A feed
        // with three items is honest; five, two of them about nobody, is not.
        const actorName = profile?.display_name || profile?.username;
        if (!actorName) continue;

        items.push({
          id: row.id,
          type: row.type as FeedItem['type'],
          actorId: row.actor_id,
          actorUsername: profile?.username ?? '',
          actorName,
          actorAvatarUri: avatarUri(profile?.avatar_path),
          mediaItemId: row.media_item_id,
          title: media?.title ?? null,
          year: media?.release_date ? Number(media.release_date.slice(0, 4)) : null,
          posterPath: media?.poster_path ?? null,
          genres: media?.genres ?? [],
          runtimeMinutes: media?.runtime_minutes ?? null,
          createdAt: row.created_at,
          position: row.payload?.position ?? null,
          score: row.payload?.score ?? null,
          bucket: row.payload?.bucket ?? null,
          category: row.payload?.category ?? null,
        });
      }

      return items;
    },
  });
}
