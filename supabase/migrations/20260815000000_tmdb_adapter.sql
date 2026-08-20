-- ===========================================================================
-- Write path for the TMDB adapter
--
-- AD-8 puts every TMDB call behind one Edge Function. This is the other half of
-- that: the function holds the key and speaks HTTP, and the database holds the
-- writes. Nothing here calls TMDB, and the adapter contains no SQL beyond
-- selecting these functions — which is the same split the rest of the schema
-- uses, where a client speaks to RPCs rather than to tables.
--
-- Three of the four functions exist because a plain upsert from the adapter
-- would have been wrong rather than merely inelegant:
--
--   media_items_tmdb is a PARTIAL unique index (`where kind in ('movie',
--   'series')`). PostgREST's upsert cannot name an index predicate, so
--   `.upsert({ onConflict: 'kind,tmdb_id' })` fails to infer it and raises
--   "no unique or exclusion constraint matching the ON CONFLICT specification".
--
--   A season's identity is (parent_id, season_number) and not its tmdb id, so
--   seasons need a different conflict target from the titles above them.
--
--   media_cache.expires_at is not nullable and AD-8 requires it to come from
--   app_config rather than from a constant. Computing it in the adapter would
--   put the retention window in TypeScript, which is exactly where a change in
--   TMDB's terms would fail to reach it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Titles
--
-- jsonb in, rows out. The signature is a payload rather than twelve parameters
-- because every field TMDB adds later would otherwise be a new migration *and*
-- a changed signature — and function-grants.test.mjs pins signatures, so the
-- churn would reach a test that has nothing to do with the catalogue.
--
-- A batch, because a search page is twenty titles and twenty round trips from
-- an Edge Function to Postgres is the slowest part of the request.
--
-- WHY EVERY UPDATE IS coalesce(new, old)
--
-- TMDB omits fields it does not have, and a refresh must not blank a column
-- that already holds something. The new value wins whenever there is one; the
-- old value survives when there is not. Without this, one detail call that
-- happened to omit `runtime` would erase a runtime the search call had set.
--
-- WHY provenance IS FORCED TO 'tmdb'
--
-- This is the compliance-relevant line in the file. The seed catalogue is
-- Wikidata's — CC0, no attribution, no retention window — and those rows carry
-- provenance 'wikidata' so that media_refresh_due never offers them for
-- refresh. The moment one of them is enriched here it is carrying TMDB's
-- overview, poster path and genres, and PRD §19's six-month window starts
-- applying to it. Leaving provenance alone would exempt real TMDB data from
-- the window by an accident of where the row came from originally.
-- wikidata_qid is deliberately kept: it is still true, and it is how a row can
-- be traced back if the tmdb_id turns out to be wrong.
-- ---------------------------------------------------------------------------

-- The output columns are named media_item_id / item_kind / provider_id rather
-- than the obvious id / kind / tmdb_id. A RETURNS TABLE column is a plpgsql
-- variable, and a variable sharing a name with a column makes every unqualified
-- reference to it ambiguous — including the `kind` inside the ON CONFLICT
-- predicate, which cannot be alias-qualified to disambiguate.
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
    popularity, provenance, fetched_at
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
    provenance        = 'tmdb',
    fetched_at        = now()
  returning mi.id, mi.kind, mi.tmdb_id;
end;
$$;

comment on function tmdb_upsert_titles is
  'Batch upsert of movie and series rows from the TMDB adapter, keyed on the partial unique index (kind, tmdb_id). Forces provenance to tmdb so an enriched Wikidata row starts observing the retention window in PRD §19. service_role only.';

-- ---------------------------------------------------------------------------
-- 2. Seasons
--
-- Keyed on (parent_id, season_number), which is media_items_season. A season's
-- tmdb id is not unique across the catalogue in the way a film's is, and the
-- table's own constraint already says a season is identified by its parent and
-- its ordinal.
--
-- Season 0 is TMDB's convention for specials. It is accepted rather than
-- filtered here, because deciding what a user should see is the client's job
-- and dropping rows in the write path would leave nothing able to change its
-- mind later.
-- ---------------------------------------------------------------------------

-- Output columns renamed for the same reason as tmdb_upsert_titles above.
create or replace function tmdb_upsert_seasons(p_parent_id uuid, p_seasons jsonb)
returns table (media_item_id uuid, season_no integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A season under a film, or under a season, would satisfy every column
  -- constraint on the table and be meaningless.
  if not exists (select 1 from media_items where media_items.id = p_parent_id and kind = 'series') then
    raise exception 'tmdb_upsert_seasons: parent % is not a series', p_parent_id
      using errcode = '22023';
  end if;

  return query
  insert into media_items as mi (
    kind, parent_id, season_number, tmdb_id, title,
    release_date, overview, poster_path, provenance, fetched_at
  )
  select 'season',
         p_parent_id,
         (season ->> 'season_number')::integer,
         (season ->> 'tmdb_id')::integer,
         coalesce(
           nullif(season ->> 'title', ''),
           'Season ' || (season ->> 'season_number')
         ),
         nullif(season ->> 'release_date', '')::date,
         nullif(season ->> 'overview', ''),
         season ->> 'poster_path',
         'tmdb',
         now()
    from jsonb_array_elements(p_seasons) as season
   where (season ->> 'season_number') is not null
  on conflict (parent_id, season_number) where kind = 'season'
  do update set
    tmdb_id      = coalesce(excluded.tmdb_id,      mi.tmdb_id),
    title        = coalesce(excluded.title,        mi.title),
    release_date = coalesce(excluded.release_date, mi.release_date),
    overview     = coalesce(excluded.overview,     mi.overview),
    poster_path  = coalesce(excluded.poster_path,  mi.poster_path),
    provenance   = 'tmdb',
    fetched_at   = now()
  returning mi.id, mi.season_number;
end;
$$;

comment on function tmdb_upsert_seasons is
  'Batch upsert of the seasons under one series, keyed on (parent_id, season_number). Refuses a parent that is not a series. service_role only.';

-- ---------------------------------------------------------------------------
-- 3. Facet cache
--
-- expires_at is computed here, from app_config, so that changing a TTL is an
-- operator action rather than a redeploy of the adapter (AD-8).
--
-- ONE INCONSISTENCY, RECORDED RATHER THAN PAPERED OVER
--
-- The seeded tmdb.cache_ttl_hours in 20260813000100 has keys
-- {availability, credits, keywords, similar}, and media_cache's check
-- constraint allows facets {credits, keywords, providers, similar}. So
-- 'availability' names no facet and 'providers' has no configured TTL — the two
-- were written for each other and do not meet. Rather than edit the seeded
-- config, which is live in two deployed projects, 'providers' reads
-- 'availability' as an alias. The fallback below covers a facet with neither.
--
-- The 3600-hour ceiling is PRD §19's six months expressed where it cannot be
-- configured away: a cache TTL longer than the retention window would mean a
-- facet outliving the row it hangs from.
-- ---------------------------------------------------------------------------

create or replace function tmdb_put_facet(p_media_item_id uuid, p_facet text, p_payload jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ttl     jsonb;
  v_hours   integer;
  v_expires timestamptz;
begin
  v_ttl := (select value from app_config where key = 'tmdb.cache_ttl_hours');

  v_hours := coalesce(
    (v_ttl ->> p_facet)::integer,
    -- 'providers' is configured under its old name. See the header above.
    case when p_facet = 'providers' then (v_ttl ->> 'availability')::integer end,
    -- Reached when the config row is absent entirely, which is the failure mode
    -- 20260813002100 exists to warn about: a missing row makes a subquery return
    -- no rows, not null, and an unguarded coalesce never runs.
    24
  );

  v_hours := least(v_hours, 3600);

  insert into media_cache (media_item_id, facet, payload, fetched_at, expires_at)
  values (p_media_item_id, p_facet, p_payload, now(), now() + (v_hours * interval '1 hour'))
  on conflict (media_item_id, facet)
  do update set payload    = excluded.payload,
                fetched_at = excluded.fetched_at,
                expires_at = excluded.expires_at
  returning expires_at into v_expires;

  return v_expires;
end;
$$;

comment on function tmdb_put_facet is
  'Writes one cached facet with an expiry derived from app_config.tmdb.cache_ttl_hours, capped at the six-month retention window. service_role only.';

-- ---------------------------------------------------------------------------
-- 4. Per-user request ceiling
--
-- api.md §9 lists tmdb-adapter as rate limited and leaves the threshold to
-- configuration. The quota being protected is not Bingd's own: TMDB publishes
-- no SLA and the catalogue is a hard dependency, so one client in a retry loop
-- is a risk to every user rather than to itself.
--
-- Counted in fixed hourly windows rather than a rolling one. A rolling window
-- needs a row per request; this needs a row per user per hour, and the
-- difference at the boundary — briefly allowing up to twice the cap — does not
-- matter for a ceiling whose job is to catch a runaway loop.
--
-- 53400 is api.md §8's SQLSTATE for a configured per-user ceiling, surfacing as
-- BG429. The note there applies: PostgREST renders it as a 500, so the adapter
-- maps it to 429 itself rather than letting it through.
-- ---------------------------------------------------------------------------

create table tmdb_request_log (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  requests     integer     not null default 0,
  primary key (user_id, window_start)
);

-- No policy is declared, so RLS denies everything and only service_role — which
-- bypasses it — can read or write. A user's search volume is not their business
-- to read and is nobody else's at all.
alter table tmdb_request_log enable row level security;

insert into app_config (key, value) values ('tmdb.max_requests_per_hour', '120'::jsonb)
  on conflict (key) do nothing;

create or replace function tmdb_note_request(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz := date_trunc('hour', now());
  v_cap    integer;
  v_count  integer;
begin
  v_cap := coalesce(
    (select (value)::integer from app_config where key = 'tmdb.max_requests_per_hour'),
    120
  );

  insert into tmdb_request_log (user_id, window_start, requests)
  values (p_user_id, v_window, 1)
  on conflict (user_id, window_start)
  do update set requests = tmdb_request_log.requests + 1
  returning requests into v_count;

  -- Two windows is enough to serve the current one and be obviously bounded.
  delete from tmdb_request_log
   where user_id = p_user_id and window_start < v_window - interval '2 hours';

  if v_count > v_cap then
    raise exception 'tmdb request limit reached'
      using errcode = '53400';
  end if;

  return v_count;
end;
$$;

comment on function tmdb_note_request is
  'Counts one adapter request against the caller''s hourly ceiling and raises 53400 past it. Protects the provider quota, which is shared by every user. service_role only.';

-- ---------------------------------------------------------------------------
-- 5. What the backfill drains
--
-- media_refresh_due answers "what has expired". This answers the different
-- question the alpha actually has: which rows have a tmdb id and have never
-- been enriched, so the seed catalogue can be given posters without walking it
-- again on every run.
--
-- Films and series only. A season's poster arrives with its parent's detail
-- call, so listing seasons here would spend one request each on rows that
-- another request is about to fill.
--
-- security_invoker, like every other view in the schema (api.md §10). The
-- backfill runs as service_role and sees everything; a client selecting from it
-- sees exactly what media_items already shows them, which is all of it.
-- ---------------------------------------------------------------------------

create view tmdb_enrich_due with (security_invoker = true) as
select mi.id,
       mi.kind,
       mi.tmdb_id,
       mi.title,
       mi.provenance
  from media_items mi
 where mi.tmdb_id is not null
   and mi.kind in ('movie', 'series')
   and mi.poster_path is null;

comment on view tmdb_enrich_due is
  'Catalogue rows carrying a tmdb id that have never been enriched, which is the whole Wikidata seed. Drained by the tmdb-adapter backfill, which runs as service_role.';

-- ---------------------------------------------------------------------------
-- 6. Privileges
--
-- Every function here is reachable only by the adapter. Postgres grants EXECUTE
-- to PUBLIC on creation, so the revoke is what does the work and the grant
-- merely records the intent — see the header of 20260813001800 and
-- function-grants.test.mjs, which fails on any of these becoming reachable.
-- ---------------------------------------------------------------------------

revoke execute on function tmdb_upsert_titles(jsonb)              from public, anon, authenticated;
revoke execute on function tmdb_upsert_seasons(uuid, jsonb)       from public, anon, authenticated;
revoke execute on function tmdb_put_facet(uuid, text, jsonb)      from public, anon, authenticated;
revoke execute on function tmdb_note_request(uuid)                from public, anon, authenticated;

grant execute on function tmdb_upsert_titles(jsonb)               to service_role;
grant execute on function tmdb_upsert_seasons(uuid, jsonb)        to service_role;
grant execute on function tmdb_put_facet(uuid, text, jsonb)       to service_role;
grant execute on function tmdb_note_request(uuid)                 to service_role;
