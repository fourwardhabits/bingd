import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useMyScores, type MyScore } from '@/features/collection/use-score';
import { posterUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';
import { compactName } from '@/lib/titles';
import { cacheSimilar } from '@/lib/tmdb-adapter';
import type { PosterTile } from '@/ui/components';

/**
 * How many similar titles the tab draws.
 *
 * Nine, and the number is a shape rather than a preference: `PosterGrid` is three
 * across (`theme.layout.posterGrid`), so nine is exactly three rows and the tab ends
 * where a phone screen does. The provider hands back up to twenty (`SIMILAR_SIZE` in
 * the adapter) and the rest are dropped here rather than paged — a title page is where
 * somebody is deciding about *this* film, and a second screenful of other films is the
 * recommendations tab wearing a disguise.
 */
export const SIMILAR_BUDGET = 9;

/**
 * How long the resolved candidate list stays fresh on the device.
 *
 * An hour, which is what `useTitleVideos` and `useSeasonEpisodes` use, and the same
 * argument applies with room to spare: the thing underneath is the `similar` facet in
 * `media_cache`, whose TTL is **168 hours** (`tmdb.cache_ttl_hours`, seeded in
 * 20260813000100). So a refetch inside the provider's own week costs one `media_cache`
 * read and one `media_items` read and reaches TMDB never. The hour is about the
 * *catalogue* rows moving — a candidate acquiring a poster because somebody else opened
 * it — rather than about the association list, which does not move for a week.
 */
const SIMILAR_STALE_MS = 60 * 60_000;

export const similarKey = (facetId: string) => ['similar', facetId] as const;

type FacetRow = { payload: { ids?: unknown } | null; expires_at: string | null };

type CandidateRow = {
  id: string;
  title: string;
  release_date: string | null;
  poster_path: string | null;
  kind: 'movie' | 'series' | 'season';
};

/** One similar title, as much of it as a poster tile needs. */
export type SimilarCandidate = {
  mediaItemId: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  kind: 'movie' | 'series';
};

export type SimilarSource = {
  /** The row the reader is looking at. Excluded from its own results. */
  sourceId: string | null;
  kind: 'movie' | 'series' | 'season' | null;
  /**
   * Whose `similar` facet answers for this page.
   *
   * A season's is its **parent series'**, because TMDB publishes recommendations for a
   * series and none for a season — the adapter resolves it the same way server-side
   * (`handleSimilar`), and this is the client half of the same rule.
   *
   * **Null is allowed and is not the end of the tab.** It means a season whose parent
   * embed did not come back, and the answer is to ask the adapter, which resolves the
   * parent itself and returns the row it wrote the facet against. See `similarIds`.
   */
  facetId: string | null;
  userId: string;
  /** False until Similar is the tab being shown. */
  enabled: boolean;
};

/**
 * The titles TMDB associates with this one, in TMDB's own order.
 *
 * ## What is reused, and what is deliberately not built
 *
 * Nothing server-side is added. The `similar` action has existed on the adapter since
 * 20260815000000 as the candidate source behind For You: it resolves a season to its
 * series, spends at most one provider request under `tmdb_claim_facet`, and writes the
 * ordered ids into `media_cache` for a week. This hook is a *reader* of that facet,
 * exactly as `use-for-you.ts` is, plus the one call that fills it when it is cold.
 *
 * ## The order is the provider's, and nothing else touches it
 *
 * **Founder decision, 2026-09-12, and it is the whole shape of V1.** An earlier version
 * reranked these through `rank.ts`' `scoreCandidate` with the source title as a single
 * anchor, which is the same scorer For You uses. Independent review 79 worked out what
 * that actually cost: with one anchor the position term spans about 0.30 down to 0.09
 * across a twenty-title list, while genre, language and popularity affinity are together
 * worth up to 0.40 — so a candidate low in TMDB's ordering could reach the top of the
 * grid mostly because it suited the reader's general taste.
 *
 * That is the wrong question answered well. This tab asks **"what else is like THIS"**;
 * "what else would I generally like" is the For You wall, which exists, is reachable in
 * two taps, and is better at it. So the order here is the provider's relevance order
 * after four things and only those four:
 *
 *   1. resolving each id to a catalogue row,
 *   2. removing the title the reader is on (and, for a season, the series above it),
 *   3. dropping repeats,
 *   4. dropping ids the catalogue cannot resolve, or that are the other medium.
 *
 * **The popularity prior is gone with the rest of the scorer**, deliberately: it is
 * weighted 0.10 in `rank.ts` and two adjacent provider positions differ by less than that
 * near the top, so keeping it "just as a tie-break" would in fact have reordered the list.
 * TMDB's own ordering already accounts for popularity; applying ours on top was counting
 * it twice.
 *
 * ## The personalisation V1 does have
 *
 * A candidate the reader has already ranked keeps its score chip — `PosterGrid`'s own,
 * the one the Collection wall draws, from `useMyScores`. That is the founder's line for
 * V1: it changes what a tile *says*, never where it sits.
 *
 * Only a film can carry one. A similar *series* is never itself rankable (AD-1), so the
 * TV half of this tab has no chips by construction rather than by omission.
 *
 * ## What a later bounded rerank would need
 *
 * Left open rather than built. `scoreCandidate(candidate, [anchor], taste)` is still the
 * function to use and needs no new schema; reinstating it means widening the select below
 * to `genres, original_language, popularity`, normalising the genres through
 * `productGenres` (the taste vector is built from rows that have been through
 * `resolveMetadata`, so a candidate still saying Animation would score against a genre
 * the vector has never heard of), and building the vector with `tasteFrom` over
 * `useRankedCollection` for **both** media. What it would also need, and what V1 does not
 * attempt, is a bound: a rule saying how far a candidate may move from the position TMDB
 * gave it. Without one this lands back where review 79 found it.
 *
 * ## Already-ranked candidates are kept
 *
 * Unlike For You, which excludes the whole collection outright. The question this tab
 * answers is "what else is like this", and "the one you gave 9.1" is a good answer to
 * it — it tells the reader the association is sound. The chip is what says so.
 */
export function useSimilarTitles({ sourceId, kind, facetId, userId, enabled }: SimilarSource) {
  /**
   * Whether there is anything to ask, at all.
   *
   * Read again below, because **a disabled query reports `isPending`**: React Query's
   * `status` is `pending` until data arrives and a query that will never run never
   * arrives, so `isPending` alone is true forever. A tab nobody has opened would sit
   * under a skeleton that nothing was ever going to replace.
   */
  const asking = enabled && Boolean(sourceId);

  /**
   * The catalogue half, and only that.
   *
   * Keyed on the facet's owner, so every season of a show shares one entry — they share
   * one facet server-side too. The viewer's own rankings are deliberately **outside**
   * this key: that is the lesson written at length in `use-for-you.ts`' `inputs`, where
   * putting a per-viewer set in the key turned a bookmark tap into a new cache entry, a
   * skeleton and a lost scroll position. Ranking something from this very page must not
   * blank the grid it was ranked from — it only lights up a chip.
   *
   * A season whose parent embed did not come back keys on **itself**, because that is the
   * only identity it has: the adapter is asked who the facet belongs to, and until it
   * answers there is no series id to share an entry with.
   */
  const candidates = useQuery({
    queryKey: similarKey(facetId ?? sourceId ?? ''),
    enabled: asking,
    staleTime: SIMILAR_STALE_MS,
    queryFn: async (): Promise<SimilarCandidate[]> => {
      const { owner, ids } = await similarIds(facetId, sourceId!);
      // The page's own two identities. TMDB does not put a title in its own
      // recommendations, but a season page's facet belongs to the series above it and
      // nothing in the data model forbids either appearing.
      const wanted = ids.filter((id) => id !== sourceId && id !== owner);
      if (wanted.length === 0) return [];

      const { data, error } = await supabase
        .from('media_items')
        .select('id, title, release_date, poster_path, kind')
        .in('id', wanted)
        // The kind this page is about. A film's list is nearly all films and a series'
        // nearly all shows, but TMDB will put one of the other in either, and a show
        // under a film's Similar reads as a bug. `season` can never match: the adapter
        // normalises every association to `movie` or `series`.
        .eq('kind', kind === 'movie' ? 'movie' : 'series');
      if (error) throw error;

      const byId = new Map(
        ((data ?? []) as unknown as CandidateRow[]).map((row) => [row.id, row]),
      );

      /**
       * Rebuilt in the provider's order, and **deduplicated by the walk itself**.
       *
       * This walk is the whole of the ordering now. PostgREST promises nothing about row
       * order, so the order has to come from the facet — and since nothing downstream
       * sorts, what the facet said is what the reader sees. Walking the list also drops
       * every id the catalogue could not resolve — a row lost to the retention window, or
       * one of the other kind — without a second filter, and a repeated id resolves to
       * the same row twice, which `seen` is what stops.
       */
      const seen = new Set<string>();
      const resolved: SimilarCandidate[] = [];
      for (const id of wanted) {
        if (seen.has(id)) continue;
        const row = byId.get(id);
        if (!row) continue;
        seen.add(id);
        resolved.push({
          mediaItemId: row.id,
          title: row.title,
          year: row.release_date ? Number(row.release_date.slice(0, 4)) : null,
          posterPath: row.poster_path,
          kind: row.kind === 'series' ? 'series' : 'movie',
        });
      }
      return resolved;
    },
  });

  /**
   * The reader's own score for each title they have ranked, for the chip.
   *
   * `useMyScores` rather than `useRankedCollection`, and that is the cheaper read of the
   * two by some way: four columns of `rankings`, no joins, no posters, no parent embed,
   * paged through `read-all` so a thousand-row account is not silently truncated into
   * wrong band sizes. A score is not stored — it is a position within a band divided by
   * the size of that band — and this is the one place in the app that answers that
   * question for a *list* of titles.
   *
   * Gated on the tab, and usually already warm: Search reads the same key.
   */
  const myScores = useMyScores(userId, enabled);

  const tiles = useMemo(
    // Sliced and nothing else. The order arrived from the provider and leaves unchanged.
    () =>
      (candidates.data ?? [])
        .slice(0, SIMILAR_BUDGET)
        .map((candidate) => tileFor(candidate, myScores.data)),
    [candidates.data, myScores.data],
  );

  /**
   * Memoised, because the title page puts this object in a dependency array.
   *
   * Its pull-to-refresh callback lists every query the gesture reaches, and a hook that
   * returned a fresh object literal every render would hand `RefreshControl` a new
   * `onRefresh` on every re-render of the page — the thing the comment at that call site
   * exists to prevent.
   */
  return useMemo(
    () => ({
      tiles,
      /**
       * The catalogue query's states, and **only** its states.
       *
       * `useMyScores` is deliberately not folded in. It decides what a tile *says*, not
       * whether there is a grid, so a slow or failed one costs the chips and nothing
       * else. Making it gate the tab would mean waiting on the reader's whole ranking
       * history to be shown what TMDB already said.
       */
      isPending: asking && candidates.isPending,
      isError: candidates.isError,
      /**
       * The page's pull-to-refresh, which the empty and failed states both invite.
       *
       * **A no-op unless the tab is open, and that is the lazy gate rather than tidiness.**
       * `refetch` is imperative: React Query runs it on a disabled query too, so handing
       * the page an unconditional one would mean pulling down on Cast spends the provider
       * request that this whole hook exists to defer. Returning a settled promise keeps
       * the caller's array of refreshes uniform without giving it that power.
       */
      refetch: asking ? candidates.refetch : noRefresh,
    }),
    [asking, candidates.isError, candidates.isPending, candidates.refetch, tiles],
  );
}

/** A refresh that is already finished, for a tab nobody has opened. Module-level so it
 *  is the same function every render and cannot move a dependency array. */
const noRefresh = async () => undefined;

/**
 * Which row the facet lives on, and the ids on it — filling it first when it is cold.
 *
 * `media_cache` can be in three states and they are three different answers. Collapsing
 * any two of them is how this either asks TMDB forever or never asks at all:
 *
 *   - **`ready`** — a payload carrying `ids`, **even `[]`**. TMDB was asked and had
 *     nothing to say, which is a real answer the adapter writes deliberately: an obscure
 *     film has no recommendations, and caching that fact is the whole point.
 *   - **`cold`** — no row, or an expired one. Nobody has asked, or the week has run out.
 *   - **`filling`** — `tmdb_claim_facet`'s two-minute placeholder, which carries a
 *     `claimed_at` and no `ids`. Somebody else is fetching this very facet right now.
 *
 * `filling` **after our own attempt is a failure and is thrown**, and that is the one
 * thing that cannot be got wrong here. We asked the adapter, it lost the claim to the
 * holder and returned without fetching, and the row still says nothing. Returning `[]`
 * there would put "No similar titles yet" on screen about a title that has plenty, and
 * React Query would hold that answer for the hour above — the reader would be told the
 * wrong thing and then not shown the right one. Thrown, it is the quiet error state with
 * a pull-to-refresh behind it, and the retry costs no provider request because the
 * adapter refuses the claim again.
 *
 * That is a real distinction rather than a defensive one: the migration's own header
 * notes that a claim turns old data into no data while a refresh runs, and says the trade
 * is right *because `similar` is never rendered directly*. This tab renders it directly,
 * so the tab is where that assumption has to be paid for.
 *
 * ## The facet's owner is the adapter's answer when we do not know it
 *
 * `facetId` is null for a season whose parent embed did not come back. The old shape gave
 * up there; it does not need to. `handleSimilar` takes the **season's** id, resolves the
 * parent itself and returns `id` — the row it wrote against — so one call both fills the
 * facet and says whose it is. A season that is genuinely malformed comes back as itself
 * with nothing written, which is the empty tab, and it costs no provider request:
 * `handleSimilar` validates the parent before it claims.
 *
 * A provider failure is left to throw, for the same reason as `filling`.
 *
 * **A title the adapter cannot ask about writes no facet**, which means this asks again
 * the next time the tab is opened. That is a seed-catalogue row with no `tmdb_id`, and
 * the repeat is cheap on the side that is scarce: `handleSimilar` checks the id *before*
 * claiming, so it returns `no_tmdb_id` without spending a provider request or holding a
 * claim. The hour of `staleTime` above is what keeps it from being asked twice in one
 * sitting.
 */
async function similarIds(
  facetId: string | null,
  sourceId: string,
): Promise<{ owner: string | null; ids: string[] }> {
  if (facetId) {
    const first = await readFacet(facetId);
    if (first.state === 'ready') return { owner: facetId, ids: first.ids };
  }

  // The **source** id, not the facet's. The adapter takes what the reader is looking at
  // and resolves a season to its series itself, which is both the call the server
  // documents and the only way to learn the owner when the parent embed is missing.
  const filled = await cacheSimilar(sourceId);
  const owner = facetId ?? filled.id ?? null;
  if (!owner) return { owner: null, ids: [] };

  const second = await readFacet(owner);
  if (second.state === 'ready') return { owner, ids: second.ids };
  if (second.state === 'filling') {
    throw new Error('similar: another refresh holds this facet');
  }
  // Cold after our own attempt: the adapter declined to ask — no tmdb id, or a malformed
  // season. Nothing is cached, and the next open will ask again for the price of one
  // edge-function call and no provider request.
  return { owner, ids: [] };
}

type FacetState =
  | { state: 'ready'; ids: string[] }
  | { state: 'cold' }
  | { state: 'filling' };

async function readFacet(facetId: string): Promise<FacetState> {
  const { data, error } = await supabase
    .from('media_cache')
    .select('payload, expires_at')
    .eq('media_item_id', facetId)
    .eq('facet', 'similar')
    .maybeSingle();
  if (error) throw error;

  const row = data as FacetRow | null;
  if (!row) return { state: 'cold' };
  // Read here rather than as a `.gt()` on the request, so "absent" and "expired" are one
  // branch in one place. An expired claim is cold too, which is the two-minute promise
  // being broken and the right thing to do about it.
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return { state: 'cold' };

  const ids = row.payload?.ids;
  // Unexpired and carrying no ids is the live claim, and nothing else writes that shape.
  if (!Array.isArray(ids)) return { state: 'filling' };
  return { state: 'ready', ids: ids.filter((id): id is string => typeof id === 'string') };
}

function tileFor(
  candidate: SimilarCandidate,
  myScores: ReadonlyMap<string, MyScore> | undefined,
): PosterTile {
  const mine = myScores?.get(candidate.mediaItemId);
  return {
    id: candidate.mediaItemId,
    // The app's one naming rule. A candidate here is a film or a series grouping and
    // never a season, so this is the entity's own name either way — `compactName` is
    // called rather than `.title` read so that stays true if the shape ever widens.
    title: compactName({ kind: candidate.kind, title: candidate.title }) ?? candidate.title,
    year: candidate.year,
    posterUri: posterUri(candidate.posterPath, 'card'),
    // Only where the reader has one. `PosterGrid`'s own chip, the same treatment the
    // Collection wall and For You use, and nothing new drawn for this tab. It changes
    // what a tile says and never where it sits, which is the founder's line for V1.
    score: mine?.score ?? null,
    bucket: mine?.bucket ?? null,
  };
}
