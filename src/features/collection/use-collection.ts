import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';

/**
 * The user's own collection.
 *
 * Read straight from `user_media`, `rankings` and `watchlist` rather than through a view.
 * `visible_collection` exists for looking at *someone else's* collection and deliberately
 * omits notes and watch dates; the owner is entitled to all of it, and RLS already scopes
 * every one of these tables to `auth.uid()`.
 */

export type RankedEntry = {
  mediaItemId: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  genres: string[];
  runtimeMinutes: number | null;
  kind: 'movie' | 'season' | 'series';
  /**
   * The parent series, for a season.
   *
   * A ranked list of TV is a column of rows called "Season 2", so the name is only
   * complete with the show attached (`lib/titles.ts`). Carried on the entry rather
   * than resolved per row at render time, because a second query per season would be
   * a request per visible row.
   */
  seriesTitle: string | null;
  /** ISO 639-1, for the hero's language rank context (`hero-rank.ts`). */
  language: string | null;
  bucket: 'loved' | 'fine' | 'not_for_me';
  position: number;
  category: RankingCategory;
};

export type LoggedEntry = {
  mediaItemId: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  genres: string[];
  runtimeMinutes: number | null;
  kind: 'movie' | 'season' | 'series';
  bucket: 'loved' | 'fine' | 'not_for_me' | null;
  watchedOn: string | null;
};

export type RankingCategory = 'movies' | 'tv_seasons';

const yearOf = (date: string | null) => (date ? Number(date.slice(0, 4)) : null);

type MediaShape = {
  title: string;
  release_date: string | null;
  poster_path: string | null;
  genres: string[] | null;
  runtime_minutes: number | null;
  kind: 'movie' | 'season' | 'series';
  original_language?: string | null;
  parent?: { title: string } | { title: string }[] | null;
};

/** PostgREST returns an embedded row as an object, but types it as an array. */
const media = (value: MediaShape | MediaShape[] | null): MediaShape =>
  (Array.isArray(value) ? value[0] : value) ?? {
    title: '',
    release_date: null,
    poster_path: null,
    genres: [],
    runtime_minutes: null,
    kind: 'movie',
  };

const parentTitle = (shape: MediaShape): string | null => {
  const parent = Array.isArray(shape.parent) ? shape.parent[0] : shape.parent;
  return parent?.title ?? null;
};

/**
 * The ranked list for one category, in position order.
 *
 * Movies and TV seasons are separate rankings and are never merged — a position is only
 * meaningful within its category (PRD §11), and a combined list would imply an ordering
 * across the two that nobody ever expressed.
 */
export function useRankedCollection(userId: string, category: RankingCategory) {
  return useQuery({
    queryKey: queryKeys.rankings(userId, category),
    queryFn: async (): Promise<RankedEntry[]> => {
      const { data, error } = await supabase
        .from('rankings')
        .select(
          'media_item_id, bucket, position, category, ' +
            'media_items(title, release_date, poster_path, genres, runtime_minutes, kind, original_language, parent:parent_id(title))',
        )
        .eq('user_id', userId)
        .eq('category', category)
        .order('position');
      if (error) throw error;

      return (data ?? []).map((row: any) => ({
        mediaItemId: row.media_item_id,
        title: media(row.media_items).title,
        year: yearOf(media(row.media_items).release_date),
        posterPath: media(row.media_items).poster_path,
        genres: media(row.media_items).genres ?? [],
        runtimeMinutes: media(row.media_items).runtime_minutes,
        kind: media(row.media_items).kind,
        seriesTitle: parentTitle(media(row.media_items)),
        language: media(row.media_items).original_language ?? null,
        bucket: row.bucket,
        position: row.position,
        category: row.category,
      }));
    },
  });
}

/**
 * Everything logged, and which of it has a position.
 *
 * Two requests inside one query, rather than one request with an embed. PostgREST embeds
 * across a foreign key and there is none between `user_media` and `rankings` — they share
 * a primary key shape and nothing else, since the ranking RPCs are the only writers of
 * `rankings` and a constraint between the two would say something about ordering that is
 * not true. Asking for `rankings(position)` from `user_media` fails outright.
 *
 * They settle together because the Logged tab states the split — "142 ranked · 380 logged"
 * (PRD §5) — and two independently cached fetches produce a pair of numbers that disagree
 * for a moment every time either one lands.
 */
export function useLoggedCollection(userId: string) {
  return useQuery({
    queryKey: queryKeys.collection(userId),
    queryFn: async () => {
      const [logged, ranked] = await Promise.all([
        supabase
          .from('user_media')
          .select(
            'media_item_id, bucket, watched_on, media_items(title, release_date, poster_path, genres, runtime_minutes, kind)',
          )
          .eq('user_id', userId)
          .order('created_at', { ascending: false }),
        supabase.from('rankings').select('media_item_id').eq('user_id', userId),
      ]);

      if (logged.error) throw logged.error;
      if (ranked.error) throw ranked.error;

      const hasPosition = new Set((ranked.data ?? []).map((row) => row.media_item_id));

      const rows = (logged.data ?? []).map((row: any) => ({
        entry: {
          mediaItemId: row.media_item_id,
          title: media(row.media_items).title,
          year: yearOf(media(row.media_items).release_date),
          posterPath: media(row.media_items).poster_path,
          genres: media(row.media_items).genres ?? [],
          runtimeMinutes: media(row.media_items).runtime_minutes,
          kind: media(row.media_items).kind,
          bucket: row.bucket,
          watchedOn: row.watched_on,
        } satisfies LoggedEntry,
        ranked: hasPosition.has(row.media_item_id),
      }));

      return {
        entries: rows.map((r) => r.entry),
        // Titles without a position. PRD §5 is explicit that this is not a backlog and
        // must not be presented as one: no progress bar, no "380 remaining".
        unranked: rows.filter((r) => !r.ranked).map((r) => r.entry),
        rankedCount: rows.filter((r) => r.ranked).length,
        loggedCount: rows.length,
      };
    },
  });
}

export function useWatchlist(userId: string) {
  return useQuery({
    queryKey: [...queryKeys.collection(userId), 'watchlist'],
    queryFn: async (): Promise<LoggedEntry[]> => {
      const { data, error } = await supabase
        .from('watchlist')
        .select(
          'media_item_id, media_items(title, release_date, poster_path, genres, runtime_minutes, kind)',
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;

      return (data ?? []).map((row: any) => ({
        mediaItemId: row.media_item_id,
        title: media(row.media_items).title,
        year: yearOf(media(row.media_items).release_date),
        posterPath: media(row.media_items).poster_path,
        genres: media(row.media_items).genres ?? [],
        runtimeMinutes: media(row.media_items).runtime_minutes,
        kind: media(row.media_items).kind,
        bucket: null,
        watchedOn: null,
      }));
    },
  });
}

/** The band headers, in the order the scale is always shown in. */
export const BAND_LABEL: Record<'loved' | 'fine' | 'not_for_me', string> = {
  loved: 'Loved it',
  fine: 'It was fine',
  not_for_me: 'Not for me',
};

export const BAND_ORDER = ['loved', 'fine', 'not_for_me'] as const;
