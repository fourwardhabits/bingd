-- Somewhere to keep a provider list, which is not a facet of any one title.
-- Specification: founder decision 2026-08-16 · PRD §19 ("Trending and popular | Hours").
--
-- ---------------------------------------------------------------------------
-- 1. Why this is not a row in media_cache
--
-- The decision was to reuse the existing facet cache rather than add a table, on
-- the grounds that trending is ephemeral external cache data and not durable Bingd
-- product data. That grounds is right and this table keeps it. The mechanism did
-- not survive contact with the schema:
--
--   media_cache is `primary key (media_item_id, facet)` with media_item_id
--   `not null references media_items(id)`. Every facet in the closed set answers
--   "what does TMDB say about *this title*" — credits, keywords, providers,
--   similar, videos. Trending answers "what is TMDB featuring right now", which is
--   a property of the request, not of any title. There is no id to be the key.
--
-- Two ways round it were considered and are worse:
--
--   A sentinel media_items row to hang the list from. media_items is world-readable
--   (20260813000400 — the one unrestricted read in the schema, deliberately), so the
--   sentinel would appear in search, and both media_refresh_due and tmdb_enrich_due
--   would have to learn to skip it. A fake title to satisfy a foreign key is a fake
--   title in the catalogue.
--
--   One 'trending' facet row per trending title, carrying its rank. The key holds
--   and the row is real, but the list stops being a thing that can be replaced: the
--   twentieth title dropping out leaves its row behind until expiry, so refresh N+1
--   overlaps generation N and two ranks collide. Fixing that needs a sweep function,
--   which is the new write path this table was supposed to avoid.
--
-- So: a sibling, not a child. Same lifecycle contract as media_cache — jsonb
-- payload, fetched_at, expires_at derived from app_config, a closed set of keys,
-- world-readable because it is catalogue data and not user data — keyed on the list
-- instead of on a title. One row, replaced whole, so there is no generation to
-- retire.
--
-- WHY THE PAYLOAD HOLDS IDS AND NOT TITLES
--
-- The trending call returns full title records, and the adapter writes them through
-- tmdb_upsert_titles like any other title before it writes this row. So the poster,
-- overview and genres live in media_items, where they already observe the retention
-- window and the refresh job, and this payload holds only the ordering — which is
-- the one part that is genuinely ephemeral. Copying the metadata in here would
-- create a second copy expiring on a different clock.
--
-- WHY media_kind AND NOT ranking_category IN THE KEY
--
-- TMDB's /trending/tv returns series. `ranking_category` splits ('movies',
-- 'tv_seasons') because a season is the rankable unit (PRD §10), and a trending
-- list of seasons is not a thing TMDB has. Naming these after media_kind says what
-- the payload actually contains.
-- ---------------------------------------------------------------------------

create table provider_list_cache (
  list_key   text        not null,
  payload    jsonb       not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (list_key),

  -- Closed, for the reason media_cache_known_facet is closed: an unknown key
  -- should be a failed write rather than a row nothing ever reads.
  constraint provider_list_cache_known_key
    check (list_key in ('trending.movie.day',  'trending.movie.week',
                        'trending.series.day', 'trending.series.week'))
);

comment on table provider_list_cache is
  'Provider lists that belong to no single title — trending, and whatever follows it. Sibling of media_cache with the same lifecycle (jsonb payload, expires_at from app_config, closed key set, world-readable); keyed on the list because media_cache is keyed on a media_item_id that a global list does not have. The payload holds ordered media_items ids only: the titles themselves are written through tmdb_upsert_titles first, so their metadata expires on the retention clock rather than on this one.';

comment on column provider_list_cache.payload is
  'An ordered list of media_items ids: {"ids": ["...", "..."]}, most trending first.';

-- No index. Four rows at most, and the primary key is the only lookup there is.

-- ---------------------------------------------------------------------------
-- 2. Reading it
--
-- World-readable, exactly like media_cache and media_items. This is catalogue
-- metadata: it says what TMDB is featuring, and nothing about any account. The
-- comment on 20260813000400's policies applies unchanged.
--
-- A reader must filter `expires_at > now()` itself. That is how media_cache
-- behaves too — expiry marks a row as stale for the refresh job, and nothing
-- deletes it out from under a client mid-render.
-- ---------------------------------------------------------------------------

alter table provider_list_cache enable row level security;

create policy provider_list_cache_read on provider_list_cache for select using (true);

-- ---------------------------------------------------------------------------
-- 3. Writing it
--
-- Shaped like tmdb_put_facet, and for the same two reasons stated in
-- 20260815000000: expires_at is not nullable, and AD-8 requires the TTL to come
-- from app_config rather than from a constant in the adapter — where a change in
-- TMDB's terms would fail to reach it.
--
-- The TTL key is added to the existing tmdb.cache_ttl_hours object rather than
-- given a config row of its own, so there stays one place an operator looks. Six
-- hours is PRD §19's "Hours" for trending and popular. The merge is written as
-- `value || key` so it survives whatever the two deployed projects currently hold
-- in that object — the inconsistency 20260815000000 records ('availability' naming
-- no facet, 'providers' having no TTL) is left exactly as it is.
--
-- The 3600-hour ceiling is carried over unchanged. It cannot bind on a six-hour
-- list, and it is here so that no future key can configure its way past the
-- retention window.
-- ---------------------------------------------------------------------------

update app_config
   set value = value || '{"trending": 6}'::jsonb
 where key = 'tmdb.cache_ttl_hours';

insert into app_config (key, value)
values ('tmdb.cache_ttl_hours', '{"trending": 6}'::jsonb)
on conflict (key) do nothing;

create or replace function tmdb_put_list(p_list_key text, p_payload jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hours   integer;
  v_expires timestamptz;
begin
  -- The payload is the contract this table's readers rely on, and a definer
  -- function is the only writer, so the shape is checked here rather than left to
  -- whichever caller gets it wrong. A check constraint could express this too, but
  -- it would report as a 23514 with no indication of which half was wrong.
  if jsonb_typeof(p_payload -> 'ids') is distinct from 'array' then
    raise exception 'tmdb_put_list: payload must carry an ids array'
      using errcode = '22023';
  end if;

  v_hours := coalesce(
    (select (value ->> 'trending')::integer from app_config
      where key = 'tmdb.cache_ttl_hours'),
    -- Reached only if the config row is absent entirely, which is the failure mode
    -- 20260813002100 exists to warn about: a missing row makes the subquery return
    -- no rows rather than null, and an unguarded coalesce never runs.
    6
  );

  v_hours := least(v_hours, 3600);

  insert into provider_list_cache (list_key, payload, fetched_at, expires_at)
  values (p_list_key, p_payload, now(), now() + (v_hours * interval '1 hour'))
  on conflict (list_key)
  do update set payload    = excluded.payload,
                fetched_at = excluded.fetched_at,
                expires_at = excluded.expires_at
  returning expires_at into v_expires;

  return v_expires;
end;
$$;

comment on function tmdb_put_list is
  'Replaces one provider list whole, with an expiry derived from app_config.tmdb.cache_ttl_hours -> trending, capped at the six-month retention window. Replacing rather than merging is what keeps the list free of a previous generation. service_role only.';

-- ---------------------------------------------------------------------------
-- 4. Privileges
--
-- Reachable only by the adapter, like every other tmdb_ function. Postgres grants
-- EXECUTE to PUBLIC on creation, so the revoke does the work and the grant records
-- the intent — see 20260813001800 and function-grants.test.mjs, which fails on this
-- becoming reachable by a client.
--
-- Clients read the table directly under the policy above; they have no reason to
-- write one and no way to.
-- ---------------------------------------------------------------------------

revoke execute on function tmdb_put_list(text, jsonb) from public, anon, authenticated;
grant  execute on function tmdb_put_list(text, jsonb) to service_role;
