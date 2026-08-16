import { useQuery } from '@tanstack/react-query';

import { bandSizes, scoreFor } from '@/features/collection/score';
import { useRankedCollection, type RankedEntry } from '@/features/collection/use-collection';
import { supabase } from '@/lib/supabase';
import { cacheSimilar } from '@/lib/tmdb-adapter';

import {
  ANCHOR_LIMIT,
  buildSlate,
  tasteFrom,
  type Anchor,
  type Candidate,
  type Scored,
} from './rank';

/**
 * The data half of For You: anchors, candidates, and what to leave out.
 *
 * Three sources, in the order they matter:
 *
 *   1. **`media_cache` facet `similar`** for the viewer's strongest few titles. This
 *      is the personalised half and the only one that can produce "because you loved
 *      X". Filled by the adapter's `similar` action the first time an anchor is used
 *      and then cached for every user, so a popular anchor is free after the first
 *      person to rank it highly.
 *   2. **`provider_list_cache` `trending.*.week`** as the popularity fallback. Week
 *      rather than day: the Feed's shelf is "what is happening now" and this is "what
 *      is worth watching", which is a slower question. It is also what makes a slate
 *      possible for somebody who has ranked nothing.
 *   3. Nothing else. There is no cross-user family in V1 — see the header of
 *      `rank.ts` for why that is what makes on-device scoring legitimate.
 */

export type Medium = 'movies' | 'tv';

export type ForYouItem = Scored & {
  /** On the viewer's watchlist. Shown, and marked, rather than filtered out. */
  saved: boolean;
};

export type ForYouSlate = {
  items: ForYouItem[];
  /** How many anchors actually had a cached list. Zero means popularity-only. */
  anchorsUsed: number;
  /** True when the slate is popularity-only — no personalisation to claim. */
  lowData: boolean;
};

const KIND_FOR: Record<Medium, 'movie' | 'series'> = { movies: 'movie', tv: 'series' };
const TRENDING_FOR: Record<Medium, string> = {
  movies: 'trending.movie.week',
  tv: 'trending.series.week',
};

/**
 * The titles a slate reasons from: the viewer's own highest-scoring, capped.
 *
 * A season's anchor is its **series**, deduplicated — five seasons of one show is one
 * anchor, not five, which is both what TMDB can answer and what stops a single
 * favourite show owning the whole TV slate before diversity even runs.
 */
export function anchorsFrom(ranked: readonly RankedEntry[], medium: Medium): {
  mediaItemId: string;
  title: string;
  score: number;
}[] {
  const sizes = bandSizes(ranked);
  const seen = new Set<string>();
  const anchors: { mediaItemId: string; title: string; score: number }[] = [];

  for (const entry of ranked) {
    const id = medium === 'tv' ? entry.seriesId : entry.mediaItemId;
    // A ranked season whose parent did not come back is skipped rather than anchored
    // on the season itself, which TMDB cannot answer about.
    if (!id || seen.has(id)) continue;
    seen.add(id);
    anchors.push({
      mediaItemId: id,
      title: medium === 'tv' ? (entry.seriesTitle ?? entry.title) : entry.title,
      score: scoreFor(entry.bucket, entry.position, sizes),
    });
    if (anchors.length >= ANCHOR_LIMIT) break;
  }

  return anchors;
}

type CachedList = { media_item_id: string; payload: { ids?: unknown } | null; expires_at: string };

async function cachedSimilar(ids: readonly string[]): Promise<Map<string, string[]>> {
  if (ids.length === 0) return new Map();

  const { data, error } = await supabase
    .from('media_cache')
    .select('media_item_id, payload, expires_at')
    .eq('facet', 'similar')
    .in('media_item_id', ids as string[])
    .gt('expires_at', new Date().toISOString());
  if (error) throw error;

  const byAnchor = new Map<string, string[]>();
  for (const row of (data ?? []) as unknown as CachedList[]) {
    const list = (row.payload?.ids ?? []) as unknown[];
    byAnchor.set(
      row.media_item_id,
      list.filter((id): id is string => typeof id === 'string'),
    );
  }
  return byAnchor;
}

async function trendingFallback(listKey: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('provider_list_cache')
    .select('payload')
    .eq('list_key', listKey)
    .maybeSingle();
  // A missing fallback is not a failed slate. The adapter may simply never have run
  // against this project, and the anchored half still works.
  if (error || !data) return [];
  const list = ((data.payload as { ids?: unknown })?.ids ?? []) as unknown[];
  return list.filter((id): id is string => typeof id === 'string');
}

type CandidateRow = {
  id: string;
  title: string;
  release_date: string | null;
  poster_path: string | null;
  kind: 'movie' | 'series' | 'season';
  genres: string[] | null;
  original_language: string | null;
  popularity: number | null;
};

async function candidatesFor(ids: readonly string[], medium: Medium): Promise<Candidate[]> {
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from('media_items')
    .select('id, title, release_date, poster_path, kind, genres, original_language, popularity')
    .in('id', ids as string[])
    // The medium the viewer is looking at. A movie anchor's list is nearly all
    // films, but TMDB will put a show in it, and a film on the TV wall reads as a bug.
    .eq('kind', KIND_FOR[medium]);
  if (error) throw error;

  return ((data ?? []) as unknown as CandidateRow[]).map((row) => ({
    mediaItemId: row.id,
    title: row.title,
    year: row.release_date ? Number(row.release_date.slice(0, 4)) : null,
    posterPath: row.poster_path,
    kind: row.kind === 'series' ? 'series' : 'movie',
    genres: row.genres ?? [],
    language: row.original_language,
    popularity: row.popularity,
  }));
}

/**
 * The viewer's own collection and watchlist, as two sets.
 *
 * `user_media` is everything logged, bucketed or dated — the collection. It is
 * excluded outright: recommending someone a film they logged last week is the fastest
 * way to make a slate look broken.
 *
 * `watchlist` is not excluded. The decision is explicit that a watchlisted title
 * stays and is marked Saved, because wanting to see something is not having seen it,
 * and a wall that hid everything you saved would quietly punish saving.
 */
async function collectionOf(userId: string) {
  const [collection, watchlist] = await Promise.all([
    supabase.from('user_media').select('media_item_id').eq('user_id', userId),
    supabase.from('watchlist').select('media_item_id').eq('user_id', userId),
  ]);
  if (collection.error) throw collection.error;
  if (watchlist.error) throw watchlist.error;

  return {
    exclude: new Set((collection.data ?? []).map((row) => row.media_item_id as string)),
    saved: new Set((watchlist.data ?? []).map((row) => row.media_item_id as string)),
  };
}

export function useForYou(userId: string, medium: Medium) {
  // Taste spans both media. Someone who ranks Japanese cinema highly means that about
  // television too, and splitting the affinity vector by medium would halve the
  // evidence behind every genre for no reason anybody could state.
  const movies = useRankedCollection(userId, 'movies');
  const seasons = useRankedCollection(userId, 'tv_seasons');

  const ranked = medium === 'movies' ? movies : seasons;
  const anchorSeeds = ranked.data ? anchorsFrom(ranked.data, medium) : [];
  const anchorKey = anchorSeeds.map((anchor) => anchor.mediaItemId).join(',');

  return useQuery({
    // Keyed by the anchors, so ranking something new rebuilds the slate and nothing
    // else has to remember to invalidate it. Keyed by the account because `exclude`
    // is that account's collection.
    queryKey: ['for-you', userId, medium, anchorKey],
    enabled: Boolean(userId) && movies.isSuccess && seasons.isSuccess,
    // A slate is stable between rankings. Half an hour stops a tab switch rebuilding
    // it, and any actual change to the inputs changes the key above instead.
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<ForYouSlate> => {
      const taste = tasteFrom(
        [...(movies.data ?? []), ...(seasons.data ?? [])].map((entry) => ({
          score: scoreFor(
            entry.bucket,
            entry.position,
            bandSizes(entry.category === 'movies' ? (movies.data ?? []) : (seasons.data ?? [])),
          ),
          genres: entry.genres,
          language: entry.language,
        })),
      );

      let lists = await cachedSimilar(anchorSeeds.map((anchor) => anchor.mediaItemId));

      // Fill what is missing, then read once more. Bounded by `ANCHOR_LIMIT`, and
      // each fill is a request that every later user of the same anchor avoids.
      const missing = anchorSeeds
        .filter((anchor) => !lists.has(anchor.mediaItemId))
        .map((anchor) => anchor.mediaItemId);

      if (missing.length > 0) {
        // Sequentially, so a cold start is six requests spread out rather than six at
        // once against a provider quota shared by everyone.
        for (const id of missing) {
          // One anchor failing — a title with no TMDB id, a rate limit — must not
          // cost the whole slate. The others still have lists.
          await cacheSimilar(id).catch(() => undefined);
        }
        lists = await cachedSimilar(anchorSeeds.map((anchor) => anchor.mediaItemId));
      }

      const anchors: Anchor[] = anchorSeeds.map((anchor) => ({
        ...anchor,
        similarIds: lists.get(anchor.mediaItemId) ?? [],
      }));

      const anchorsUsed = anchors.filter((anchor) => anchor.similarIds.length > 0).length;

      const fallback = await trendingFallback(TRENDING_FOR[medium]);
      const candidateIds = [
        ...new Set([...anchors.flatMap((anchor) => anchor.similarIds), ...fallback]),
      ];

      const [candidates, { exclude, saved }] = await Promise.all([
        candidatesFor(candidateIds, medium),
        collectionOf(userId),
      ]);

      const slate = buildSlate({ candidates, anchors, taste, exclude });

      return {
        items: slate.map((item) => ({ ...item, saved: saved.has(item.mediaItemId) })),
        anchorsUsed,
        lowData: anchorsUsed === 0,
      };
    },
  });
}
