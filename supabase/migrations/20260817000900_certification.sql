-- What a title is rated, so the metadata line can read `PG-13 · 95m · Nikolaj Arcel`.
-- Specification: founder acceptance corrections 2026-08-17, item 2.
--
-- ===========================================================================
-- WHY A COLUMN AND NOT A FACET
--
-- Every other provider extra lives in `media_cache` — credits, videos, reviews,
-- similar — because each is a list, is large, and is read by one surface. A
-- certification is a short scalar rendered in the *title's own metadata line*, beside
-- the year and the runtime, which are columns. Putting it in a facet would mean the
-- line that reads `2017` and `95m` from `media_items` had to wait on a second query to
-- read `PG-13`, and would make the certification arrive after the sentence it belongs
-- in had already drawn.
--
-- It is also provider data with the same retention obligation as the rest of the row,
-- and `media_refresh_due` already covers `media_items`. A facet would need its own TTL
-- for a value that changes about as often as a runtime does.
--
-- ===========================================================================
-- WHY IT IS ONE STRING AND NOT A REGION MAP
--
-- TMDB publishes a certification per country, and the honest general answer is a map.
-- V1 has one environment, one language (`language=en-US` is hardcoded in the adapter's
-- request builder) and a founder in one place, so a map would be a schema nobody reads
-- from and a fallback chain nobody exercises.
--
-- What is stored is therefore the **US certification**, chosen in the adapter, and the
-- column says so. When Bingd has a reason to be regional this becomes a map and the
-- adapter's selection moves into the read path; until then, a column with a documented
-- region is honest and a map with one key in it is not.
--
-- **Never fabricated.** If TMDB has no US certification for a title, or the value it
-- publishes is an empty string — which it does, often, for the countries it has a
-- release date for and no rating — the column stays null and the metadata line simply
-- does not have that part. An invented "NR" would be a claim about a film's content
-- that nobody made.
-- ===========================================================================

alter table media_items add column certification text;

comment on column media_items.certification is
  'The content certification TMDB publishes for the **US** region: `PG-13` for a movie (from release_dates), `TV-MA` for a series (from content_ratings). One string rather than a region map because V1 has one environment and one language; when Bingd is regional this becomes a map and the selection moves into the read path. Null when TMDB has none, which is common -- never a fabricated `NR`.';

-- ---------------------------------------------------------------------------
-- The upsert learns one more field
--
-- Reproduced in full, and the diff against `20260815000000` is the thing to read: two
-- added lines, `certification` in the insert list and its `coalesce` in the update. The
-- rest is that function verbatim.
--
-- Reproducing it is the hazard `20260817000200` records — `_assert_operation_rate` lost
-- its advisory lock exactly this way — so the two clauses most easily lost are called
-- out here rather than left to be noticed:
--
--   the **repeated predicate** on the conflict target, without which Postgres cannot
--   infer the partial index and this raises rather than choosing the wrong one;
--   the **genres case**, which exists because `'{}'` is not null and `coalesce` cannot
--   tell "TMDB said nothing" from "TMDB said no genres".
--
-- `certification` uses `coalesce` like every other scalar: a search result carries none,
-- so a search that runs after a detail call must not blank what the detail wrote.
-- ---------------------------------------------------------------------------

create or replace function tmdb_upsert_titles(p_items jsonb)
returns table (media_item_id uuid, item_kind media_kind, provider_id integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  insert into media_items as mi (
    kind, tmdb_id, title, original_title, release_date, runtime_minutes,
    overview, poster_path, backdrop_path, original_language, genres,
    popularity, certification, provenance, fetched_at
  )
  select (item ->> 'kind')::media_kind,
         (item ->> 'tmdb_id')::integer,
         item ->> 'title',
         item ->> 'original_title',
         -- TMDB sends '' for an unknown date, which is not a date.
         nullif(item ->> 'release_date', '')::date,
         (item ->> 'runtime_minutes')::integer,
         nullif(item ->> 'overview', ''),
         item ->> 'poster_path',
         item ->> 'backdrop_path',
         item ->> 'original_language',
         coalesce(
           (select array_agg(g) from jsonb_array_elements_text(item -> 'genres') as t(g)),
           '{}'
         ),
         (item ->> 'popularity')::real,
         -- '' is TMDB having a release record for the region and no rating on it,
         -- which is not a rating.
         nullif(item ->> 'certification', ''),
         'tmdb',
         now()
    from jsonb_array_elements(p_items) as item
   where item ->> 'title' is not null
     and (item ->> 'tmdb_id') is not null
     and (item ->> 'kind') in ('movie', 'series')
  -- The predicate is repeated so Postgres can infer the partial index. Drop it
  -- and this raises rather than choosing the wrong index.
  on conflict (kind, tmdb_id) where kind in ('movie', 'series')
  do update set
    title             = coalesce(excluded.title,             mi.title),
    original_title    = coalesce(excluded.original_title,    mi.original_title),
    release_date      = coalesce(excluded.release_date,      mi.release_date),
    runtime_minutes   = coalesce(excluded.runtime_minutes,   mi.runtime_minutes),
    overview          = coalesce(excluded.overview,          mi.overview),
    poster_path       = coalesce(excluded.poster_path,       mi.poster_path),
    backdrop_path     = coalesce(excluded.backdrop_path,     mi.backdrop_path),
    original_language = coalesce(excluded.original_language, mi.original_language),
    -- An empty array is TMDB saying nothing rather than saying "no genres",
    -- which the coalesce above cannot express because '{}' is not null.
    genres            = case when excluded.genres = '{}' then mi.genres else excluded.genres end,
    popularity        = coalesce(excluded.popularity,        mi.popularity),
    -- NEW (20260817000900). Coalesced like every other scalar: a search result carries
    -- no certification, so a search after a detail call must not blank it.
    certification     = coalesce(excluded.certification,     mi.certification),
    provenance        = 'tmdb',
    fetched_at        = now()
  returning mi.id, mi.kind, mi.tmdb_id;
end;
$$;

comment on function tmdb_upsert_titles is
  'Batch upsert of movie and series rows from the TMDB adapter, keyed on the partial unique index (kind, tmdb_id). Forces provenance to tmdb so an enriched Wikidata row starts observing the retention window in PRD §19. Carries the US content certification since 20260817000900. service_role only.';
