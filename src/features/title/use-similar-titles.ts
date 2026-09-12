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
   * Whether the viewer's own taste moved the order.
   *
   * False for somebody who has ranked nothing, which is not a degraded state: it is
   * the provider's own relevance order, which is what this tab ships when there is
   * nothing to personalise with.
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
   * (`handleSimilar`), and this is the client half of the same rule. Null for a season
   * whose parent did not come back, which is the one shape that degrades to an empty
   * tab rather than to a wrong one.
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
   * The catalogue half, and only that.
   *
   * Keyed on the facet's owner, so every season of a show shares one entry — they share
   * one facet server-side too. The viewer's taste and rankings are deliberately
   * **outside** this key: that is the lesson written at length in `use-for-you.ts`'
   * `inputs`, where putting a per-viewer set in the key turned a bookmark tap into a new
   * cache entry, a skeleton and a lost scroll position. Ranking something from this very
   * page must not blank the grid it was ranked from.
   */
  /**
   * Whether there is anything to ask, at all.
   *
   * Read again below, because **a disabled query reports `isPending`**: React Query's
   * `status` is `pending` until data arrives and a query that will never run never
   * arrives, so `isPending` alone is true forever. A season with no parent to ask about
   * would sit under a skeleton that nothing was ever going to replace — which is what
   * "degrades gracefully" cannot mean.
   */
  const asking = enabled && Boolean(facetId) && Boolean(sourceId);

  const candidates = useQuery({
    queryKey: similarKey(facetId ?? ''),
    enabled: asking,
    staleTime: SIMILAR_STALE_MS,
    queryFn: async (): Promise<Candidate[]> => {
      const ids = await similarIds(facetId!, sourceId!);
      // The page's own two identities. TMDB does not put a title in its own
      // recommendations, but a season page's facet belongs to the series above it and
      // nothing in the data model forbids either appearing.
      const wanted = ids.filter((id) => id !== sourceId && id !== facetId);
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
      mediaItemId: facetId ?? '',
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
  }, [candidates.data, facetId, myScores, sourceTitle, taste]);

  return {
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
    refetch: candidates.refetch,
  };
}

/**
 * The facet's ids, filling it first when it is cold.
 *
 * The three answers `media_cache` can give are all different, and the difference is what
 * stops this asking TMDB forever:
 *
 *   - **no row, or an expired one** — nobody has asked, or the week has run out. Ask.
 *   - **a row whose payload has `ids`, even `[]`** — TMDB was asked and had nothing to
 *     say. That is a real answer and the adapter writes it deliberately; an obscure film
 *     has no recommendations, and caching that fact is the whole point.
 *   - **a row with no `ids` at all** — `tmdb_claim_facet`'s two-minute placeholder:
 *     somebody else is fetching right now. Asking again is free (the adapter loses the
 *     claim and returns `cached` without spending a request), and the re-read below is
 *     what picks up their answer if it landed in between.
 *
 * A provider failure is left to throw. The tab's error state is quiet and the page
 * around it stays usable, which is a better answer than an empty grid saying "no similar
 * titles" about a request that was refused.
 */
async function similarIds(facetId: string, sourceId: string): Promise<string[]> {
  const first = await readFacet(facetId);
  if (first) return first;

  // The **source** id, not the facet's. The adapter takes what the reader is looking at
  // and resolves a season to its series itself; handing it the series directly would be
  // the same call, but handing it the season is the call the server documents.
  await cacheSimilar(sourceId);
  return (await readFacet(facetId)) ?? [];
}

async function readFacet(facetId: string): Promise<string[] | null> {
  const { data, error } = await supabase
    .from('media_cache')
    .select('payload, expires_at')
    .eq('media_item_id', facetId)
    .eq('facet', 'similar')
    .maybeSingle();
  if (error) throw error;

  const row = data as FacetRow | null;
  if (!row) return null;
  // Read here rather than as a `.gt()` on the request, so "absent" and "expired" are one
  // branch in one place.
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;

  const ids = row.payload?.ids;
  if (!Array.isArray(ids)) return null;
  return ids.filter((id): id is string => typeof id === 'string');
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
 * gave them. That is the fallback the tab ships on for a reader with no rankings:
 * `tasteFrom([])` returns empty affinity maps, every genre and language term is zero,
 * and what is left is `positionWeight` down the provider's own list.
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
