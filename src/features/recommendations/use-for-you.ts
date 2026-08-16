import { useQuery } from '@tanstack/react-query';

import { bandSizes, scoreFor } from '@/features/collection/score';
import {
  useRankedCollection,
  useWatchlist,
  type RankedEntry,
} from '@/features/collection/use-collection';
import { useWatched } from '@/features/collection/use-watched';
import { supabase } from '@/lib/supabase';
import { AdapterError, cacheSimilar } from '@/lib/tmdb-adapter';

import {
  ANCHOR_LIMIT,
  buildSlate,
  tasteFrom,
  type Anchor,
  type Candidate,
  type Scored,
  type Taste,
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
  /**
   * The affinity vector the slate was scored with.
   *
   * Returned so the screen can pass the *real* taste to `headlineFor` rather than a
   * stand-in. It was passing `{ sampleSize: 99 }`, which defeated the suppression
   * that stops a taste built from one ranking being asserted in words — the unit test
   * covered `headlineFor` and not its caller. Independent review found it.
   */
  taste: Taste;
};

const KIND_FOR: Record<Medium, 'movie' | 'series'> = { movies: 'movie', tv: 'series' };
const TRENDING_FOR: Record<Medium, string> = {
  movies: 'trending.movie.week',
  tv: 'trending.series.week',
};

/**
 * The titles a slate reasons from: the viewer's own **loved** ones, capped.
 *
 * `loved` and not merely "highest ranked", which is what this did first and what
 * independent review caught. Every anchor is quoted on screen as "Because you loved
 * X", and a viewer whose entire collection is `fine` and `not_for_me` still has a
 * top-ranked title — so the sentence was being said about films they had explicitly
 * marked as not for them. The arithmetic was sound and the word was a lie.
 *
 * It is also the better recommender. A `not_for_me` title's associations are titles
 * *like something the viewer disliked*, and feeding them in as positive evidence was
 * always going to be wrong however the sentence was worded.
 *
 * A viewer with nothing loved gets no anchors, a popularity-and-genre slate, and a
 * screen that says "Popular right now" — which is what that slate honestly is.
 *
 * A season's anchor is its **series**, deduplicated: five seasons of one show is one
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
    if (entry.bucket !== 'loved') continue;
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
 * A set of ids as one short string, for the query key.
 *
 * Order-independent — a sum rather than a running hash — because PostgREST makes no
 * promise about row order and a re-fetch that returned the same rows differently
 * ordered must not look like a change.
 */
const setFingerprint = (ids: Iterable<string>): string => {
  let total = 0;
  let count = 0;
  for (const id of ids) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    total = (total + (hash >>> 0)) % 0xffffffff;
    count += 1;
  }
  return `${count}.${total.toString(36)}`;
};

/**
 * Everything about the viewer's rankings that changes a slate, as one short string.
 *
 * The key used to carry only the selected medium's anchor ids, which left two ways to
 * serve a stale slate for half an hour: re-bucketing a title changes the taste vector
 * without changing which ids are anchors, and editing TV rankings changes the taste
 * behind the *Movies* wall — taste spans both media on purpose. Independent review
 * found both.
 *
 * A digest rather than the rankings themselves, because a query key is compared by
 * value on every render and a four-hundred-title collection would be four hundred
 * comparisons a frame. FNV-1a: not a security hash, and nothing here needs one — a
 * collision would serve a slightly stale slate.
 */
export function rankingFingerprint(...lists: readonly (readonly RankedEntry[])[]): string {
  let hash = 0x811c9dc5;
  for (const list of lists) {
    for (const entry of list) {
      for (const char of `${entry.mediaItemId}:${entry.bucket}:${entry.position};`) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193);
      }
    }
  }
  return (hash >>> 0).toString(36);
}

export function useForYou(userId: string, medium: Medium) {
  // Taste spans both media. Someone who ranks Japanese cinema highly means that about
  // television too, and splitting the affinity vector by medium would halve the
  // evidence behind every genre for no reason anybody could state.
  const movies = useRankedCollection(userId, 'movies');
  const seasons = useRankedCollection(userId, 'tv_seasons');

  // Read through their own hooks rather than inside the query, so they are *inputs*
  // with keys of their own rather than hidden reads inside a cached result. Both are
  // already cached and already invalidated by `invalidateAfterCollectionChange`.
  const watched = useWatched(userId);
  const watchlist = useWatchlist(userId);

  const ranked = medium === 'movies' ? movies : seasons;
  const anchorSeeds = ranked.data ? anchorsFrom(ranked.data, medium) : [];

  /**
   * Everything the *viewer* controls that changes this slate, as one string.
   *
   * The key carried only the selected medium's anchor ids, and independent review
   * found three ways that served a stale wall for half an hour: re-bucketing changes
   * the taste vector without changing which ids are anchors; editing TV rankings
   * changes the taste behind the Movies wall, because taste spans both media; and
   * logging or saving a title changes what is excluded and what reads as Saved.
   *
   * What remains outside the key is the catalogue side — the `similar` facets and the
   * trending fallback. Those change on provider-cache clocks measured in hours
   * (trending: six) and weeks (`similar`), so the thirty-minute staleness below sits
   * comfortably inside them. Nothing the person using the app can do falls in that gap.
   */
  const inputs = [
    rankingFingerprint(movies.data ?? [], seasons.data ?? []),
    setFingerprint(watched.data ?? []),
    setFingerprint((watchlist.data ?? []).map((entry) => entry.mediaItemId)),
  ].join('|');

  return useQuery({
    queryKey: ['for-you', userId, medium, inputs],
    enabled:
      Boolean(userId) &&
      movies.isSuccess &&
      seasons.isSuccess &&
      watched.isSuccess &&
      watchlist.isSuccess,
    // See the note on `inputs`: everything the viewer can change is in the key, and
    // what is left changes on a six-hour clock at fastest.
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
          try {
            await cacheSimilar(id);
          } catch (cause) {
            // A rate limit is about the *account*, not about this anchor, so the five
            // calls after it would all be refused too — and each one still costs a
            // round trip and a log line. Every other failure is about the one title,
            // and the remaining anchors are still worth asking for.
            if (cause instanceof AdapterError && cause.isRateLimit) break;
          }
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

      const candidates = await candidatesFor(candidateIds, medium);

      // `user_media` is everything logged, bucketed or dated — the collection —
      // and is excluded outright: recommending someone a film they logged last week
      // is the fastest way to make a slate look broken.
      //
      // The watchlist is not excluded. The decision is explicit that a watchlisted
      // title stays and is marked Saved: wanting to see something is not having seen
      // it, and a wall that hid everything you saved would quietly punish saving.
      const exclude = watched.data ?? new Set<string>();
      const saved = new Set((watchlist.data ?? []).map((entry) => entry.mediaItemId));

      const slate = buildSlate({ candidates, anchors, taste, exclude });

      return {
        items: slate.map((item) => ({ ...item, saved: saved.has(item.mediaItemId) })),
        anchorsUsed,
        lowData: anchorsUsed === 0,
        taste,
      };
    },
  });
}
