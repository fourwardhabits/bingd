-- A season carries how many episodes it has, so the feed can say `8 episodes`
-- where a film says `148m`.
-- Specification: founder Feed finalization 2026-08-20, items 7, 8, 9.
--
-- ===========================================================================
-- WHY A SEASON CANNOT BORROW THE NUMBER IT NEEDS
--
-- The founder's standardised feed subheading is:
--
--     movie   PG-13 · 148m · Science Fiction · Adventure
--     season  TV-MA · 8 episodes · Action · Animation
--
-- and it is explicit that a season must **not** show a runtime and must **not** show
-- a series-level episode total. Both halves of that were unavailable before this file.
--
-- `media_items.runtime_minutes` on a *series* holds `episode_run_time[0]` -- the
-- typical length of one episode (`normalize.ts`) -- and a season row carries no
-- runtime at all. So the only number a season could have inherited was one that
-- would have rendered as `50m`, describing a single episode while sitting in the
-- slot the reader is scanning for "how long is this thing". That is worse than an
-- absence, and it is why the client does not fall back for this field even though it
-- does fall back for genres and certification.
--
-- The right number therefore has to be stored, and TMDB already sends it: every entry
-- in a series detail's `seasons` array carries `episode_count`, on a response the
-- adapter is already fetching and already normalising. Nothing new is requested, no
-- credential moves, and the enrichment path is the one that exists. That is what makes
-- this the smallest consistent route rather than new adapter architecture.
--
-- **A column, for the reason `20260817000900` gives for `certification`.** It is a
-- short scalar rendered in a metadata line beside the year and the genres, which are
-- columns. A facet would mean the line that reads `2021` from `media_items` had to
-- wait on a second query to read `8`, and the count would arrive after the sentence
-- it belongs to had drawn. It also has the same retention obligation as the rest of
-- the row, which `media_refresh_due` already covers.
--
-- **Nullable, and never fabricated.** Every season already in the catalogue has no
-- count until it is next enriched -- the seeded rows in `20260814001131` never had
-- one, and `tmdb_upsert_seasons` was not writing one before now. A null renders as an
-- omitted segment, so the line degrades to `TV-MA · Action · Animation` with no empty
-- separator, which the client tests pin. Deriving a count from anything else -- the
-- length of a credits facet, an episode number seen elsewhere -- would be a claim
-- about a season that nobody made.
--
-- **On `media_items` rather than a seasons-only table** because there is no
-- seasons-only table: a season is a `media_items` row with a `parent_id`, and every
-- other descriptive field it has lives here. The column is null for a movie and for a
-- series by construction, and the comment says so rather than a check constraint
-- doing it -- a constraint would make `tmdb_upsert_titles` raise if TMDB ever
-- returned a stray field, which is a worse failure than a number nobody reads.
-- ===========================================================================

alter table media_items add column episode_count integer;

comment on column media_items.episode_count is
  'How many episodes a season has, from TMDB''s per-season episode_count on the series detail. Set for seasons only -- a movie has none and a series total is not what the feed shows, since the rankable unit is the season (PRD 10). Null until a season is next enriched, which renders as an omitted segment rather than a zero: never fabricated.';

-- ---------------------------------------------------------------------------
-- The season upsert learns one more field
--
-- Reproduced in full, and the diff against `20260815000000` is two added lines:
-- `episode_count` in the insert list and its `coalesce` in the update. The rest is
-- that function verbatim.
--
-- Reproducing a definer function is the hazard `20260817000200` records, so the two
-- clauses most easily lost are called out rather than left to be noticed:
--
--   the **parent kind check**, without which a season could be hung under a film or
--   under another season and satisfy every column constraint on the table;
--   the **repeated predicate** on the conflict target, without which Postgres cannot
--   infer the partial index and this raises rather than choosing the wrong one.
--
-- `episode_count` uses `coalesce` like every other scalar here. It matters more than
-- it does for the others: `fromSeasonDetail` -- the shape written when a *season* is
-- enriched directly through /tv/{id}/season/{n} -- can legitimately carry no count,
-- and without the coalesce that path would blank a number the series detail had
-- already supplied.
-- ---------------------------------------------------------------------------

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
    release_date, overview, poster_path, episode_count, provenance, fetched_at
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
         -- NEW (20260820000400). A season TMDB reports as having zero episodes is one
         -- that has not aired; nullif keeps it out of the metadata line rather than
         -- rendering "0 episodes", which reads as a fact about the show.
         nullif((season ->> 'episode_count')::integer, 0),
         'tmdb',
         now()
    from jsonb_array_elements(p_seasons) as season
   where (season ->> 'season_number') is not null
  on conflict (parent_id, season_number) where kind = 'season'
  do update set
    tmdb_id       = coalesce(excluded.tmdb_id,      mi.tmdb_id),
    title         = coalesce(excluded.title,        mi.title),
    release_date  = coalesce(excluded.release_date, mi.release_date),
    overview      = coalesce(excluded.overview,     mi.overview),
    poster_path   = coalesce(excluded.poster_path,  mi.poster_path),
    -- NEW (20260820000400). Coalesced so that enriching one season directly, through
    -- a payload that carries no count, does not blank what the series detail wrote.
    episode_count = coalesce(excluded.episode_count, mi.episode_count),
    provenance    = 'tmdb',
    fetched_at    = now()
  returning mi.id, mi.season_number;
end;
$$;

comment on function tmdb_upsert_seasons is
  'Batch upsert of the seasons under one series, keyed on (parent_id, season_number). Refuses a parent that is not a series. Carries episode_count since 20260820000400, coalesced so a direct season enrichment does not blank it. service_role only.';
