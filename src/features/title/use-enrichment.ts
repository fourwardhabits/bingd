import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { queryKeys } from '@/lib/query';
import { enrichTitle } from '@/lib/tmdb-adapter';

import { episodesKey } from './use-season-episodes';

/** The subset of a catalogue row that decides whether the provider is worth asking. */
export type EnrichableTitle = {
  id: string;
  kind: 'movie' | 'series' | 'season';
  tmdb_id: number | null;
  poster_path: string | null;
  overview: string | null;
  runtime_minutes: number | null;
};

/**
 * A row is thin when the screen has visible holes in it.
 *
 * Artwork and an overview are what the title screen is mostly made of, so either
 * being absent is reason enough. Runtime is checked for the two rankable kinds
 * because `TitleMetadata` renders it beside the year and a missing one leaves a
 * stray separator.
 *
 * A season is allowed through without a tmdb id of its own: TMDB reaches a season
 * as /tv/{series}/season/{n}, so what matters is the id on its parent, and the
 * adapter is where that lookup belongs.
 */
function isThin(title: EnrichableTitle) {
  if (title.kind !== 'season' && !title.tmdb_id) return false;
  if (!title.poster_path) return true;
  if (!title.overview) return true;
  if (title.kind !== 'series' && !title.runtime_minutes) return true;
  return false;
}

/**
 * Asks the adapter to fill one row in, at most once per mount.
 *
 * The guard is not optional. Enrichment invalidates the queries that decide whether
 * enrichment is needed, so without it a title TMDB genuinely has no artwork for
 * would ask again on every render — spending the ceiling in api.md §9 on a row that
 * will never change.
 *
 * A failure is deliberately silent. The screen has a title, a year and the user's
 * own ranking already, and an error banner over working content would be a worse
 * screen than one missing a poster.
 *
 * **`enriching` is true on the first render, before the effect has run.**
 *
 * It used to be a `useState(false)` that the effect flipped, which meant one render
 * where a request was about to be made and nothing said so. That was harmless while
 * the flag only drove a "Fetching details…" line. It stopped being harmless when the
 * Episodes tab began using it as a gate: `useSeasonEpisodes` is enabled when no
 * enrichment is running, so a single render claiming "not enriching" was enough for
 * the tab to fire its fallback request alongside the enrichment that was about to
 * seed it — two provider requests where the design promises none.
 *
 * So it is derived rather than announced: an id that needs enriching is enriching
 * until its attempt has settled, which is knowable during the very first render.
 */
function useEnrichOnce(id: string | null | undefined, needed: boolean) {
  const queryClient = useQueryClient();
  // The ids whose attempt has finished, successfully or not. State rather than a ref
  // because finishing has to re-render: it is what releases the gate above.
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    if (!id || !needed || attempted.current.has(id)) return;
    attempted.current.add(id);

    let cancelled = false;

    enrichTitle(id)
      .then(async (result) => {
        if (cancelled || !result.enriched) return;

        /**
         * The Episodes tab, seeded rather than invalidated.
         *
         * A season's enrichment reads `/tv/{series}/season/{n}`, and that response
         * carries the episodes: the adapter now returns them instead of counting
         * them and throwing the rest away. Writing them here is what makes the
         * Episodes tab free — the reader who opens it is served out of the cache,
         * and `useSeasonEpisodes` never reaches its fallback fetch.
         *
         * `setQueryData` and emphatically not `invalidateQueries`. Invalidating the
         * key would mark the data we are holding as stale and send the tab off to
         * fetch what we have in hand, which is the opposite of the point.
         *
         * Absent for a film and a series, which have no episodes to send. Guarded on
         * the array rather than on the kind, so an adapter that has not been
         * redeployed yet simply seeds nothing and the tab falls back.
         */
        if (result.episodes) queryClient.setQueryData(episodesKey(id), result.episodes);

        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.title(id) }),
          queryClient.invalidateQueries({ queryKey: ['credits', id] }),
          queryClient.invalidateQueries({ queryKey: queryKeys.seasons(id) }),
          // Both facets the same call writes. Without these the Videos tab and the
          // TMDB Reviews section stay absent until the screen is left and re-entered,
          // because the query that decides whether to render them was resolved
          // against a `media_cache` that had no row yet.
          queryClient.invalidateQueries({ queryKey: ['videos', id] }),
          queryClient.invalidateQueries({ queryKey: ['tmdb-reviews', id] }),
        ]);
      })
      .catch(() => {})
      .finally(() => {
        /**
         * Recorded on failure as well as on success, and **without the `cancelled`
         * guard the writes above use.**
         *
         * The two flags answer different questions. `cancelled` means "this effect
         * has been superseded, do not touch the cache" — a claim about freshness.
         * This is a claim about history: the one attempt `attempted` permits for this
         * id has finished, and it has finished whether or not anybody still wants its
         * result.
         *
         * Guarding it would let the two disagree. An effect re-run that lands while a
         * request is in flight cancels it, and the re-run then finds the id already
         * in `attempted` and does nothing — so nothing would ever mark it settled,
         * `enriching` would stay true for good, and the Episodes tab would be gated
         * behind a request that finished long ago. A permanent skeleton, from a
         * one-word guard.
         */
        setSettled((previous) => (previous.has(id) ? previous : new Set(previous).add(id)));
      });

    return () => {
      cancelled = true;
    };
  }, [id, needed, queryClient]);

  const enriching = Boolean(id) && needed && !settled.has(id!);

  return { enriching };
}

/**
 * Fills a title in from the provider the first time someone opens it.
 *
 * The alpha catalogue is a Wikidata seed with no artwork, no overviews and no
 * credits, so most rows arrive thin and are completed on first view. This is the
 * on-demand half of that; `tmdb-adapter`'s `enrich` action is the bulk half, and a
 * title someone has already visited will have been filled by whichever ran first.
 */
export function useTitleEnrichment(
  title: EnrichableTitle | null | undefined,
  /**
   * A second reason to ask, independent of whether the row looks thin.
   *
   * It exists for the Phase E deployment. `isThin` asks about artwork, an overview and
   * a runtime — everything a title screen was made of before videos and TMDB reviews
   * existed — so the five hundred rows already enriched on nonprod were complete by
   * that measure and would never have been asked about the two new facets. The
   * deployment would have reached only titles discovered after it.
   *
   * The caller passes "no videos facet row at all", which is a question about whether
   * TMDB has *been asked*, not about whether it had anything to say. The adapter writes
   * the facet even when the list is empty, so one enrichment settles it permanently and
   * this cannot become a request per mount for a film with no trailer.
   */
  alsoWhen = false,
) {
  return useEnrichOnce(title?.id, title ? isThin(title) || alsoWhen : false);
}

/**
 * How old a season list may be before it is worth re-reading.
 *
 * **Seven days, and deliberately not `tmdb.metadata_max_age_days`.** That config value
 * is 150 and governs a catalogue row's *description* — a poster, an overview, a genre
 * list — which is stable for months. A season list is the one field on a series that
 * **grows**, and it grows on the provider's schedule rather than on ours. Judging it by
 * the descriptive window would mean a show that gained a season in September was still
 * short of it in February.
 *
 * A constant here rather than an `app_config` row because this is a client decision and
 * the client cannot read `app_config`. What bounds the cost is the same thing that
 * bounds every other provider call from a screen: `useEnrichOnce` asks at most once per
 * id per mount, so this is one request per stale series per time somebody opens it,
 * against the `tmdb.max_requests_per_hour` ceiling every other call observes.
 */
export const SEASON_LIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a series' season list is old enough to be worth asking about again.
 *
 * **The founder's report, 2026-08-30: a series showing fewer seasons than it has.** The
 * gate here used to be "this series has no seasons at all", which meant a season list
 * was written exactly once — by whichever enrichment first reached the series — and
 * never revisited. `media_refresh_due` exists for the general version of this problem
 * and is drained by no schedule, so nothing else was going to ask either. A show that
 * gained a season after somebody first opened it stayed short of it for good.
 *
 * The signal is the **newest** `fetched_at` across the season rows, and independent
 * review 77 is why it is not the oldest. The oldest reads better as semantics — after a
 * whole-list write every row shares an instant, so the minimum is when the list was last
 * written *whole* — but it does not terminate. `tmdb_upsert_seasons` writes the seasons
 * the provider named and is silent about the rest, so a season TMDB has since dropped
 * from its answer keeps its old timestamp forever: the minimum never moves, the list is
 * permanently stale, and every single open of that series spends a provider request that
 * cannot change anything.
 *
 * The newest terminates unconditionally — any write at all moves it — at the cost of
 * one season's own refresh vouching for the list for up to a week. That is the right
 * trade by a wide margin: the defect being fixed is a series short of a season for
 * *months*, and a bounded seven-day delay is not that.
 *
 * A series with no seasons is **not** stale — that is the other gate's question, and
 * answering it here as well would ask twice. An unparseable or missing timestamp reads
 * as stale: asking once more is cheap, and a rule that quietly stopped asking is the
 * defect this replaces.
 *
 * **The limit of this signal, stated because review 77b named it.** A season enriched on
 * its own also moves the maximum, so a series with one permanently thin season that
 * somebody opens weekly could hold the whole list fresh while it is not. That is narrow
 * — a season stops being thin the moment it is enriched, so it needs a season TMDB has
 * no artwork or overview for at all — and the server-side reconciliation
 * (`season_hydration_due`) is the belt to this brace. Closing it properly needs a record
 * of when the *list* was last asked for, which is a column this table does not have and
 * is not worth adding on the strength of that case.
 */
export function seasonListIsStale(
  seasons: readonly { fetched_at?: string | null }[],
  now: number = Date.now(),
): boolean {
  if (!seasons.length) return false;

  let newest = -Infinity;
  for (const season of seasons) {
    const at = season.fetched_at ? Date.parse(season.fetched_at) : NaN;
    if (Number.isNaN(at)) return true;
    if (at > newest) newest = at;
  }
  return now - newest > SEASON_LIST_MAX_AGE_MS;
}

/**
 * Fetches a series' seasons the first time someone opens its picker, and again once the
 * list that was written has gone stale.
 *
 * A series that arrived through search has no season rows at all: TMDB's search
 * response does not carry them, and fetching them for every result would spend a
 * provider request per row to fill a list most of them will never open. So the
 * picker is where they arrive — which is also the first moment they are needed,
 * since a series cannot be logged and picking a season is the only thing to do
 * with one (AD-1, PRD §10).
 *
 * Without this the picker offers "No seasons yet" for every series the local
 * catalogue has never seen, which is a dead end at the exact point the user is
 * trying to log something.
 *
 * Re-asking is safe by construction: `tmdb_upsert_seasons` is an upsert keyed on
 * (parent, season number) that deletes nothing, so a repeat writes the same rows with
 * the same ids and every ranking, watch state and progress stays attached to the season
 * it was attached to. What a repeat can add is a season the provider has published
 * since — and the episode counts, for rows written before the adapter sent them.
 */
export function useSeasonEnrichment(
  seriesId: string | null,
  hasNoSeasons: boolean,
  seasonsAreStale = false,
) {
  return useEnrichOnce(seriesId, hasNoSeasons || seasonsAreStale);
}
