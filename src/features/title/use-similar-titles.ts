import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { bandSizes, scoreFor, type Bucket } from '@/features/collection/score';
import { useRankedCollection, type RankedEntry } from '@/features/collection/use-collection';
import {
  scoreCandidate,
  tasteFrom,
  type Anchor,
  type Candidate,
  type Taste,
} from '@/features/recommendations/rank';
import { posterUri } from '@/lib/images';
import { productGenres } from '@/lib/media-metadata';
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
  genres: string[] | null;
  original_language: string | null;
  popularity: number | null;
};

export type SimilarSlate = {
  tiles: PosterTile[];
  /**
   * Whether the viewer had a taste vector behind this grid at all.
   *
   * **Not a claim that the order came out different.** It is `sampleSize > 0`: the reader
   * has ranked something, so the genre and language terms were live. They may still have
   * been flat across these candidates and changed nothing — which is common, because a
   * similar list mostly shares one genre — and that is exactly the case this flag is for
   * telling apart from a reader who could not be personalised for at all.
   *
   * False is not a degraded state. It is the provider's relevance order under the same
   * popularity prior For You uses, which is what this tab ships when there is nothing to
   * personalise with.
   */
  personalized: boolean;
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
  /** What the anchor is called. Never rendered; it completes the `Anchor` shape. */
  sourceTitle: string;
  userId: string;
  /** False until Similar is the tab being shown. */
  enabled: boolean;
};

/**
 * The titles TMDB associates with this one, ordered for this reader.
 *
 * ## What is reused, and what is deliberately not built
 *
 * Nothing server-side is added. The `similar` action has existed on the adapter since
 * 20260815000000 as the candidate source behind For You: it resolves a season to its
 * series, spends at most one provider request under `tmdb_claim_facet`, and writes the
 * ordered ids into `media_cache` for a week. This hook is a *reader* of that facet,
 * exactly as `use-for-you.ts` is, plus the one call that fills it when it is cold.
 *
 * The ordering is `rank.ts`' own `scoreCandidate`, unchanged and with no new weight,
 * with **the source title as the single anchor**. That is what keeps the hierarchy the
 * right way up:
 *
 *   - the candidate *set* is the provider's association list and nothing else, so no
 *     For You candidate can appear here however well it would score;
 *   - the anchor term carries the provider's own position (`positionWeight` decays down
 *     the list) at `WEIGHTS.anchor` — 0.6, the largest weight in the system;
 *   - genre, language and popularity affinity move titles *within* that list.
 *
 * The anchor's `score` is a flat 10 rather than the reader's own rating of the film
 * they are looking at. A rating would scale the anchor term uniformly across every
 * candidate — it cannot reorder anything — and all it would actually do is quietly hand
 * more of the ordering to taste on a film the reader disliked, which is not a rule
 * anybody asked for. The source title is the *constraint* here, not a preference.
 *
 * **How much taste can actually move a title, stated rather than left latent.** With one
 * anchor the anchor term saturates at `0.6 × saturate(1) = 0.30` for the provider's first
 * suggestion and falls to about `0.09` for its twentieth, so position is worth roughly
 * 0.21 across the whole list. The three taste terms are worth up to `0.18 + 0.12 + 0.10 =
 * 0.40` — nominally more. In practice they are nearly constant across a *similar* list,
 * which is what keeps position in front: these candidates share the source's genres and
 * language with each other, so the terms that could reorder them mostly do not vary. The
 * cases where they do vary are the cases where reranking is the point. It is worth
 * knowing that the bound is a soft one: a strongly on-taste candidate low in the list can
 * reach the top of the grid. Nothing outside the list ever can, which is the invariant
 * that matters, and it is asserted below.
 *
 * ## What the viewer's own data is read for
 *
 * Two ranked collections, both gated on the tab being open, and both usually already
 * cached — Collection, Profile and this page's own rank line read the same keys. They
 * give the taste vector (`tasteFrom`, spanning both media for the reason its own header
 * states) and, from the same rows, the score chip on a candidate the reader has already
 * ranked. No third read, and no new "score" of any kind: the chip is
 * `scoreFor(bucket, position, bandSizes)`, which is what every other surface shows.
 *
 * Only a film can carry one. A similar *series* is never itself rankable (AD-1), so the
 * TV half of this tab has no chips by construction rather than by omission.
 *
 * ## Already-ranked candidates are kept
 *
 * Unlike For You, which excludes the whole collection outright. The question this tab
 * answers is "what else is like this", and "the one you gave 9.1" is a good answer to
 * it — it tells the reader the association is sound. The chip is what says so.
 */
export function useSimilarTitles({
  sourceId,
  kind,
  facetId,
  sourceTitle,
  userId,
  enabled,
}: SimilarSource) {
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
   * one facet server-side too. The viewer's taste and rankings are deliberately
   * **outside** this key: that is the lesson written at length in `use-for-you.ts`'
   * `inputs`, where putting a per-viewer set in the key turned a bookmark tap into a new
   * cache entry, a skeleton and a lost scroll position. Ranking something from this very
   * page must not blank the grid it was ranked from.
   *
   * A season whose parent embed did not come back keys on **itself**, because that is the
   * only identity it has: the adapter is asked who the facet belongs to, and until it
   * answers there is no series id to share an entry with.
   */
  const candidates = useQuery({
    queryKey: similarKey(facetId ?? sourceId ?? ''),
    enabled: asking,
    staleTime: SIMILAR_STALE_MS,
    queryFn: async (): Promise<Candidate[]> => {
      const { owner, ids } = await similarIds(facetId, sourceId!);
      // The page's own two identities. TMDB does not put a title in its own
      // recommendations, but a season page's facet belongs to the series above it and
      // nothing in the data model forbids either appearing.
      const wanted = ids.filter((id) => id !== sourceId && id !== owner);
      if (wanted.length === 0) return [];

      const { data, error } = await supabase
        .from('media_items')
        .select(
          'id, title, release_date, poster_path, kind, genres, original_language, popularity',
        )
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
       * PostgREST promises nothing about row order, so the order has to come from the
       * facet. Walking the facet list also drops every id the catalogue could not
       * resolve — a row lost to the retention window, or one of the other kind —
       * without a second filter, and a repeated id resolves to the same row twice,
       * which `seen` is what stops.
       */
      const seen = new Set<string>();
      const resolved: Candidate[] = [];
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
          // The product's genres rather than the provider's, for the reason
          // `use-for-you.ts` gives at its own call: the taste vector is built from rows
          // that have been through `resolveMetadata` and therefore say Anime, so a
          // candidate still saying Animation would score against a genre the vector has
          // never heard of.
          genres: productGenres({
            kind: row.kind,
            genres: row.genres,
            language: row.original_language,
          }),
          language: row.original_language,
          popularity: row.popularity,
        });
      }
      return resolved;
    },
  });

  // Taste spans both media, which is `useForYou`'s rule and its reasoning: somebody who
  // ranks Japanese cinema highly means that about television too. Both gated on the tab,
  // and both are keys the Collection and Profile screens have usually filled already.
  const movies = useRankedCollection(userId, 'movies', { enabled });
  const seasons = useRankedCollection(userId, 'tv_seasons', { enabled });

  const taste = useMemo(
    () => tasteFrom(signalsFrom(movies.data, seasons.data)),
    [movies.data, seasons.data],
  );

  /**
   * The reader's own score for each ranked **film**, for the chip.
   *
   * Derived from rows already in hand rather than from a fourth query, and derived the
   * way every other surface derives it: a score is not stored, it is a position within a
   * band divided by the size of that band (`use-score.ts`). Movies only — the TV
   * candidates here are series, and a series is not a rankable unit.
   */
  const myScores = useMemo(() => scoresOf(movies.data), [movies.data]);

  const slate = useMemo((): SimilarSlate => {
    const pool = candidates.data ?? [];
    if (pool.length === 0) return { tiles: [], personalized: false };

    const anchor: Anchor = {
      // Read by nothing that matters — `scoreCandidate` separates candidates on
      // `similarIds.indexOf`, and the hit's id only reaches an explanation this tab
      // discards. Still the page's own identity rather than a blank, so the shape is not
      // quietly wrong for whatever reads it next.
      mediaItemId: facetId ?? sourceId ?? '',
      title: sourceTitle,
      // See the header: the source is the constraint, not a rating.
      score: 10,
      similarIds: pool.map((candidate) => candidate.mediaItemId),
    };

    return {
      tiles: ordered(pool, anchor, taste)
        .slice(0, SIMILAR_BUDGET)
        .map((candidate) => tileFor(candidate, myScores)),
      personalized: taste.sampleSize > 0,
    };
  }, [candidates.data, facetId, myScores, sourceId, sourceTitle, taste]);

  /**
   * Memoised, because the title page puts this object in a dependency array.
   *
   * Its pull-to-refresh callback lists every query the gesture reaches, and a hook that
   * returned a fresh object literal every render would hand `RefreshControl` a new
   * `onRefresh` on every re-render of the page — the thing the comment at that call site
   * exists to prevent.
   */
  return useMemo(() => ({
    slate,
    /**
     * The catalogue query's states, and **only** its states.
     *
     * The two ranked collections are deliberately not folded in. They are an ordering
     * input, so a slow or failed one costs the personalisation and nothing else — a grid
     * in provider order is the shipped V1, not a failure. Making them gate the tab would
     * mean a reader with no rankings waiting on two reads to be told what TMDB already
     * said.
     */
    isPending: asking && candidates.isPending,
    isError: candidates.isError,
    /**
     * The page's pull-to-refresh, which the empty and failed states both invite.
     *
     * **A no-op unless the tab is open, and that is the lazy gate rather than tidiness.**
     * `refetch` is imperative: React Query runs it on a disabled query too, so handing
     * the page an unconditional one would mean pulling down on Cast spends the provider
     * request that this whole hook exists to defer. Returning a settled promise keeps the
     * caller's array of refreshes uniform without giving it that power.
     */
    refetch: asking ? candidates.refetch : noRefresh,
  }), [asking, candidates.isError, candidates.isPending, candidates.refetch, slate]);
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

/** The ranked rows as `rank.ts` wants them: a derived score, genres and a language. */
function signalsFrom(
  movies: readonly RankedEntry[] | undefined,
  seasons: readonly RankedEntry[] | undefined,
) {
  // Banded separately and then pooled, because a band is a band *within* Movies or
  // within TV seasons — one set of sizes over both would score a film against the
  // television it shares a bucket name with (`use-score.ts`).
  return [movies ?? [], seasons ?? []].flatMap((entries) => {
    const sizes = bandSizes(entries);
    return entries.map((entry) => ({
      score: scoreFor(entry.bucket, entry.position, sizes),
      genres: entry.genres,
      language: entry.language,
    }));
  });
}

function scoresOf(movies: readonly RankedEntry[] | undefined) {
  const entries = movies ?? [];
  const sizes = bandSizes(entries);
  return new Map<string, { score: number; bucket: Bucket }>(
    entries.map((entry) => [
      entry.mediaItemId,
      { score: scoreFor(entry.bucket, entry.position, sizes), bucket: entry.bucket },
    ]),
  );
}

/**
 * The provider's list, reordered by one candidate score each.
 *
 * `sort` is stable in every engine this runs on and the input is already in the
 * provider's order — so two candidates the scorer cannot separate keep the order TMDB
 * gave them.
 *
 * **What a reader with no rankings actually gets, stated exactly.** `tasteFrom([])`
 * returns empty affinity maps, so the genre and language terms are zero — but the
 * popularity prior is not part of taste and does not switch off. What is left is
 * `positionWeight` down the provider's list plus `WEIGHTS.popularity` (0.10), and since
 * two adjacent provider positions differ by less than that near the top, a markedly more
 * popular candidate a place or two down can rise. That is `rank.ts` unmodified rather
 * than a rule invented here, and it is pinned by a test rather than left to be discovered:
 * "provider order" for this tab means the provider's order as the existing scorer reads
 * it, not a verbatim copy of the facet.
 */
function ordered(pool: readonly Candidate[], anchor: Anchor, taste: Taste): Candidate[] {
  return pool
    .map((candidate) => ({
      candidate,
      total: scoreCandidate(candidate, [anchor], taste).explanation.total,
    }))
    .sort((a, b) => b.total - a.total)
    .map((entry) => entry.candidate);
}

function tileFor(
  candidate: Candidate,
  myScores: ReadonlyMap<string, { score: number; bucket: Bucket }>,
): PosterTile {
  const mine = myScores.get(candidate.mediaItemId);
  return {
    id: candidate.mediaItemId,
    // The app's one naming rule. A candidate here is a film or a series grouping and
    // never a season, so this is the entity's own name either way — `compactName` is
    // called rather than `.title` read so that stays true if the shape ever widens.
    title: compactName({ kind: candidate.kind, title: candidate.title }) ?? candidate.title,
    year: candidate.year,
    posterUri: posterUri(candidate.posterPath, 'card'),
    // Only where the reader has one. `PosterGrid`'s own chip, the same treatment the
    // Collection wall and For You use, and nothing new drawn for this tab.
    score: mine?.score ?? null,
    bucket: mine?.bucket ?? null,
  };
}
