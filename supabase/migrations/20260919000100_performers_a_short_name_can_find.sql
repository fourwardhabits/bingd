-- Performers a short name can find.
-- Specification: founder brief 2026-09-14 ("Cast relevance: name relevance is the gate;
-- popularity ranks valid matches"), measured on staging the same day.
--
-- ---------------------------------------------------------------------------
-- 1. Why Cast search needs a list of its own
--
-- Cast search is TMDB's /search/person, page 1. That route ranks a person whose name has
-- a word EQUAL to the query ahead of every person whose name only STARTS with it, and only
-- then weighs popularity. So a query that is itself a common first name buries the star:
--
--   "leo"      10,000 results. Leonardo DiCaprio (popularity 8.2) is not in the first
--              200 (ten pages) -- they are all people named Leo, most of them below 2.
--   "leonar"   no person is named "Leonar", so he is #2.
--   "jen", "margo", "kean" behave like "leo": the people typed toward are not on page 1.
--
-- Paging cannot fix that: the star is past any bound worth spending a user's hourly
-- ceiling on. What does contain him is TMDB's /person/popular: its first fifty pages
-- (1,000 people, popularity >= 3.6 on the day measured) held every star tried -- DiCaprio
-- #122, Robbie #257, Chalamet #389 -- and exactly one person whose name starts "Leo".
--
-- So the nightly trending refresh also reads those fifty pages into one row here, and the
-- adapter merges the entries whose NAME matches a Cast query into TMDB's answer. The name
-- is the gate; popularity only orders what passed it. No per-search request is added: the
-- fifty requests are the job's, on the service role, once a night per project.
--
-- 2. Why a row in provider_list_cache
--
-- It is a provider list that belongs to no single title -- the case this table's own
-- comment names ("trending, and whatever follows it"). What differs is the payload: a
-- list of people, not media_items ids, because a person is not a catalogue row and the
-- search result needs the name, face and known-for line to draw without a second read.
-- It is TMDB's public person data, the same fields search-people already returns to any
-- signed-in caller, so world-readable is no change in what is exposed.
--
-- Every existing reader asks for its keys by name (`.eq` / `.in` on list_key, and the
-- group-picks function by literal key), so a fifth row reaches none of them.
-- ---------------------------------------------------------------------------

alter table provider_list_cache drop constraint provider_list_cache_known_key;

alter table provider_list_cache add constraint provider_list_cache_known_key
  check (list_key in ('trending.movie.day',  'trending.movie.week',
                      'trending.series.day', 'trending.series.week',
                      'popular.people'));

-- The people row carries people. `tmdb_put_list` still accepts any known key with an ids
-- array, so without this a caller could write ids under the people key and every search
-- would read an empty index without saying why. `is not distinct from`, not `=`: a missing
-- key is a null type, and a CHECK that evaluates to null passes.
alter table provider_list_cache add constraint provider_list_cache_people_shape
  check (list_key <> 'popular.people'
         or jsonb_typeof(payload -> 'people') is not distinct from 'array');

comment on column provider_list_cache.payload is
  'For the trending keys, an ordered list of media_items ids: {"ids": ["...", "..."]}, most trending first. For popular.people, TMDB performers most popular first: {"people": [{"id": <tmdb person id>, "name": "...", "profile_path": "..."|null, "known_for": ["..."], "popularity": <number>|null}]}.';

-- ---------------------------------------------------------------------------
-- 3. Writing it
--
-- Shaped like tmdb_put_list: one row replaced whole, expiry from app_config, service_role
-- only. Its own TTL key, because the refresh is nightly rather than six-hourly: 48 hours
-- leaves one missed night before the row reads as stale. The adapter also refuses an
-- index older than 14 days, so a job that stops for good degrades Cast search to TMDB's
-- own order rather than to a snapshot of who was famous a month ago.
-- ---------------------------------------------------------------------------

update app_config
   set value = value || '{"popular_people": 48}'::jsonb
 where key = 'tmdb.cache_ttl_hours'
   and not (value ? 'popular_people');

create or replace function tmdb_put_people_index(p_payload jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hours   integer;
  v_expires timestamptz;
begin
  if jsonb_typeof(p_payload -> 'people') is distinct from 'array' then
    raise exception 'tmdb_put_people_index: payload must carry a people array'
      using errcode = '22023';
  end if;

  v_hours := coalesce(
    (select (value ->> 'popular_people')::integer from app_config
      where key = 'tmdb.cache_ttl_hours'),
    48
  );

  v_hours := least(v_hours, 3600);

  insert into provider_list_cache (list_key, payload, fetched_at, expires_at)
  values ('popular.people', p_payload, now(), now() + (v_hours * interval '1 hour'))
  on conflict (list_key)
  do update set payload    = excluded.payload,
                fetched_at = excluded.fetched_at,
                expires_at = excluded.expires_at
  returning expires_at into v_expires;

  return v_expires;
end;
$$;

comment on function tmdb_put_people_index is
  'Replaces the popular.people provider list whole, with an expiry from app_config.tmdb.cache_ttl_hours -> popular_people (48 when absent), capped at the retention window. Written by the nightly trending refresh; read by the adapter to find performers a short Cast query cannot reach on TMDB''s first page. service_role only.';

revoke execute on function tmdb_put_people_index(jsonb) from public, anon, authenticated;
grant  execute on function tmdb_put_people_index(jsonb) to service_role;
