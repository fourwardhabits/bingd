import { useQuery } from '@tanstack/react-query';

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
  posterPath: string | null;
  createdAt: string;
  position: number | null;
  category: 'movies' | 'tv_seasons' | null;
};

type FeedRow = {
  id: string;
  type: string;
  actor_id: string;
  media_item_id: string | null;
  created_at: string;
  payload: { position?: number; category?: 'movies' | 'tv_seasons' } | null;
  media_items: { title: string; poster_path: string | null }[] | null;
  profiles: { username: string; display_name: string | null; avatar_url: string | null }[] | null;
};

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
          'id, type, actor_id, media_item_id, created_at, payload, media_items(title, poster_path), profiles:actor_id(username, display_name, avatar_url)',
        )
        .in('actor_id', actorIds)
        .in('type', ['title_ranked', 'title_logged', 'season_completed'])
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) throw error;

      return ((data ?? []) as unknown as FeedRow[]).map((row) => {
        const profile = row.profiles?.[0];
        const media = row.media_items?.[0];

        return {
          id: row.id,
          type: row.type as FeedItem['type'],
          actorId: row.actor_id,
          actorUsername: profile?.username ?? '',
          actorName: profile?.display_name ?? profile?.username ?? 'Someone',
          actorAvatarUri: profile?.avatar_url ?? null,
          mediaItemId: row.media_item_id,
          title: media?.title ?? null,
          posterPath: media?.poster_path ?? null,
          createdAt: row.created_at,
          position: row.payload?.position ?? null,
          category: row.payload?.category ?? null,
        };
      });
    },
  });
}
