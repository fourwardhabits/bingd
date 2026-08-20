import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { bandSizes, scoreFor } from '@/features/collection/score';
import { useRankedCollection, type RankedEntry } from '@/features/collection/use-collection';
import {
  applyFilters,
  emptyFilters,
  isFiltered,
  type CollectionFilters,
  type CollectionItem,
} from '@/features/collection/filters';
import { useWatched } from '@/features/collection/use-watched';
import { supabase } from '@/lib/supabase';
import { AdapterError, cacheSimilar } from '@/lib/tmdb-adapter';

import {
  ANCHOR_LIMIT,
  SLATE_SIZE,
  diversify,
  scoreSlate,
  tasteFrom,
  type Anchor,
  type Candidate,
  type Scored,
  type Taste,
} from './rank';
import { useRecommendationSeed } from './session-seed';

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

/**
 * A scored candidate, and nothing about the viewer's watchlist.
 *
 * **`saved` used to be on here and its removal is the founder's Preview bug.** The
 * bookmark on a For You poster is drawn from `useWatchlist` at the screen instead —
 * see the note on {@link useForYou} for why carrying it through the query made every
 * bookmark press reload the wall.
 */
export type ForYouItem = Scored;

/**
 * A candidate as the collection filter sheet sees it.
 *
 * The sheet was written for `CollectionItem` and its own header says the For You page
 * "is meant to reuse it rather than grow a second one". This is that reuse: a candidate
 * already carries the four facets the sheet filters on — genres, language, year and the
 * kind that decides anime — so the mapping is a widening rather than a translation.
 *
 * The three fields a candidate cannot have are null, and they are exactly the ones the
 * sheet is told not to offer here: nothing on a For You wall has been ranked, so there
 * is no bucket, no score and no watch date to filter by.
 */
export const asCollectionItem = (candidate: Candidate): CollectionItem => ({
  mediaItemId: candidate.mediaItemId,
  title: candidate.title,
  seriesTitle: null,
  kind: candidate.kind,
  year: candidate.year,
  posterPath: candidate.posterPath,
  genres: [...candidate.genres],
  language: candidate.language,
  runtimeMinutes: null,
  score: null,
  bucket: null,
  watchedOn: null,
});

/**
 * What the query caches: the scoring, and nothing about how it is arranged.
 *
 * The split is the freshness fix. Which titles are good is a function of the reader's
 * rankings and the provider cache and has one right answer, so it is cached for half an
 * hour. *Which arrangement of them is on screen* is a function of the session seed, so
 * it is derived in `select` — which reads the cache and never touches the network.
 * Refresh therefore costs one sort, not a round trip.
 */
export type ForYouScoring = {
  /**
   * Every eligible candidate, scored, in no particular order.
   *
   * The whole set rather than the top twenty, because {@link ForYouSlate.items} is drawn
   * from a pool three times the wall's size and a Refresh has to be able to reach the
   * part of it that is not currently on screen.
   */
  scored: Scored[];
  /**
   * Every candidate considered, *before* the reader's filters.
   *
   * The filter sheet builds its options from this, so a wall filtered to Comedy still
   * offers Horror — the sheet's own rule is that the options describe the whole set
   * rather than what is currently on screen.
   */
  candidatePool: CollectionItem[];
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

/**
 * What the screen reads: the scoring, plus the wall drawn from it.
 *
 * `items` is not cached. It is derived from {@link ForYouScoring.scored} and the session
 * seed every time either moves, which is what makes Refresh instant and what makes a
 * bookmark not move it at all.
 */
export type ForYouSlate = ForYouScoring & {
  /** The wall, in order: at most `SLATE_SIZE`, under all three diversity ceilings. */
  items: ForYouItem[];
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
export function anchorsFrom(
  ranked: readonly RankedEntry[],
  medium: Medium,
  filters?: CollectionFilters,
): {
  mediaItemId: string;
  title: string;
  score: number;
}[] {
  /**
   * Band sizes from the **whole** category, before any narrowing.
   *
   * A score is a position within its band, so it is only meaningful against every
   * title in that band. Counting the filtered subset instead would make almost every
   * anchor rank last in a band of two or three and clamp to the band's floor — so a
   * reader who picked Comedy would find their anchors had all become equally weak,
   * for no reason they did anything to cause.
   */
  const sizes = bandSizes(ranked);
  const seen = new Set<string>();
  const anchors: { mediaItemId: string; title: string; score: number }[] = [];

  for (const entry of anchorScope(ranked, filters)) {
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

/**
 * A ranked entry as the filter model sees it.
 *
 * Only the facets the For You sheet actually offers matter here — genre, language,
 * decade and anime — and all four live on the entry already. Score is left null
 * because deriving one needs the whole band and nothing on this path filters by it.
 */
const rankedAsItem = (entry: RankedEntry): CollectionItem => ({
  mediaItemId: entry.mediaItemId,
  title: entry.title,
  seriesTitle: entry.seriesTitle,
  kind: entry.kind,
  year: entry.year,
  posterPath: entry.posterPath,
  genres: entry.genres,
  language: entry.language,
  runtimeMinutes: entry.runtimeMinutes,
  score: null,
  bucket: entry.bucket,
  watchedOn: null,
});

/**
 * The reader's own rankings, narrowed to what they have asked to see.
 *
 * **This is the bug the founder found.** The filters reached the candidate pool and
 * stopped there, so a wall narrowed to Comedy was still *anchored* on whatever the
 * reader loved most overall — a thriller, say — and then asked TMDB for comedies near
 * it. The wall said Comedy and the reasoning underneath it was about something else,
 * which is exactly the disconnect somebody notices without being able to name.
 *
 * Narrowing the anchors as well makes the two halves agree: filtered comedies, chosen
 * by the comedies this person loved. A reader who has loved nothing in the subset gets
 * no anchors at all and a popularity-led slate inside it, which is the honest answer
 * rather than a borrowed one.
 *
 * The taste vector is deliberately **not** narrowed. It is an affinity across every
 * genre and language the reader has ranked, and recomputing it over one filtered genre
 * would produce a vector that says "you like Comedy" — true, circular, and worth
 * nothing as a tie-break between two comedies.
 */
export function anchorScope(
  ranked: readonly RankedEntry[],
  filters: CollectionFilters | undefined,
): readonly RankedEntry[] {
  if (!filters || !isFiltered(filters)) return ranked;

  const kept = new Set(
    applyFilters(ranked.map(rankedAsItem), filters).map((item) => item.mediaItemId),
  );
  return ranked.filter((entry) => kept.has(entry.mediaItemId));
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

export function useForYou(userId: string, medium: Medium, filters?: CollectionFilters) {
  // Taste spans both media. Someone who ranks Japanese cinema highly means that about
  // television too, and splitting the affinity vector by medium would halve the
  // evidence behind every genre for no reason anybody could state.
  const movies = useRankedCollection(userId, 'movies');
  const seasons = useRankedCollection(userId, 'tv_seasons');

  // Read through its own hook rather than inside the query, so it is an *input* with a
  // key of its own rather than a hidden read inside a cached result. Already cached and
  // already invalidated by `invalidateAfterCollectionChange`.
  //
  // `useWatchlist` was read here too and no longer is: see the note on `inputs`.
  const watched = useWatched(userId);

  // Which arrangement this session is showing. Not part of the key — see `select`.
  const seed = useRecommendationSeed();

  const ranked = medium === 'movies' ? movies : seasons;
  // The filtered subset of *this* medium, which is what the founder asked the slate to
  // reason from: filtered movies for the Movies wall, filtered seasons for the TV one.
  const anchorSeeds = ranked.data ? anchorsFrom(ranked.data, medium, filters) : [];

  /**
   * Everything the *viewer* controls that changes this slate, as one string.
   *
   * The key carried only the selected medium's anchor ids, and independent review found
   * two ways that served a stale wall for half an hour: re-bucketing changes the taste
   * vector without changing which ids are anchors, and editing TV rankings changes the
   * taste behind the Movies wall, because taste spans both media. Both are in here.
   *
   * ## The watchlist is deliberately **not**, and that is the founder's Preview bug
   *
   * It was, as a third fingerprint, on the reasoning that saving a title "changes what
   * reads as Saved". That was true and it was the wrong place to fix it. The watchlist
   * is a key of this query, so bookmarking a poster invalidated the watchlist, which
   * refetched, which changed `inputs`, **which changed the query key** — and a changed
   * key is a different cache entry with no data in it. The screen fell to
   * `slate.isPending`, swapped the wall for a skeleton, and mounted a *new* `ScrollView`
   * when the data came back. That is the whole of what the founder saw: a white flash, a
   * reload, and the wall back at the top.
   *
   * A watchlisted title is not excluded from a slate — `buildSlate` says so explicitly —
   * so its membership changes exactly one thing, which bookmark is filled. That is
   * presentation, and presentation is read live from `useWatchlist` at the screen. The
   * canonical state still refreshes on every write; it just no longer discards twenty
   * scored candidates to redraw one icon.
   *
   * `watched` stays in the key and must: a logged title is excluded from the wall
   * outright, so the slate really is a different slate.
   *
   * What remains outside the key is the catalogue side — the `similar` facets and the
   * trending fallback. Those change on provider-cache clocks measured in hours
   * (trending: six) and weeks (`similar`), so the thirty-minute staleness below sits
   * comfortably inside them. Nothing the person using the app can do falls in that gap.
   */
  const inputs = [
    rankingFingerprint(movies.data ?? [], seasons.data ?? []),
    setFingerprint(watched.data ?? []),
  ].join('|');

  return useQuery({
    // The filters are part of the key: the same anchors and the same candidates with
    // a different genre picked are a different slate, and a shared key would serve
    // whichever the reader asked for first.
    queryKey: ['for-you', userId, medium, inputs, filters ?? emptyFilters()],
    enabled: Boolean(userId) && movies.isSuccess && seasons.isSuccess && watched.isSuccess,
    // See the note on `inputs`: everything the viewer can change is in the key, and
    // what is left changes on a six-hour clock at fastest.
    staleTime: 30 * 60_000,
    /**
     * The wall, derived from the cache rather than fetched.
     *
     * This is where the session seed enters, and where it must enter. Putting it in the
     * *key* would have made Refresh a different cache entry with no data in it — the
     * screen would fall to `isPending`, swap the wall for a skeleton and mount a fresh
     * `ScrollView`, which is precisely the flash-and-jump defect being fixed a few lines
     * above for bookmarks. `select` re-derives from data that is already there: no
     * network, no pending state, no remount.
     *
     * Memoised on the seed alone, so a re-render for any other reason returns the
     * identical `items` array and the wall does not so much as re-key.
     */
    select: useCallback(
      (scoring: ForYouScoring): ForYouSlate => ({
        ...scoring,
        items: diversify(scoring.scored, SLATE_SIZE, seed),
      }),
      [seed],
    ),
    queryFn: async (): Promise<ForYouScoring> => {
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

      /**
       * Filtered **before** scoring, not after.
       *
       * The difference matters and it is the founder's constraint. `buildSlate` is
       * where the diversity rules live — the franchise ceiling, the genre spread, the
       * saturating anchor term — and they operate over whatever it is given. Filtering
       * its *output* would take a slate those rules had balanced and cut it to whatever
       * survived, leaving four titles that might all be from one series. Filtering the
       * candidates lets the same rules do the same job inside the narrower pool.
       */
      const pool = filters
        ? candidates.filter((candidate) =>
            applyFilters([asCollectionItem(candidate)], filters).length > 0,
          )
        : candidates;

      // Scored, and stopping there. The arrangement is `select`'s job, so that changing
      // it costs a sort rather than everything above this line.
      return {
        scored: scoreSlate({ candidates: pool, anchors, taste, exclude }),
        candidatePool: candidates.map(asCollectionItem),
        anchorsUsed,
        lowData: anchorsUsed === 0,
        taste,
      };
    },
  });
}
