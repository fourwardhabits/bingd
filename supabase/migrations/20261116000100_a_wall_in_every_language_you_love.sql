-- Recommendation Engine V2, A1: candidate coverage (founder spec 2026-11-10, §3 and §8).
--
-- For You V1 draws every candidate from three places: the TMDB `similar` lists of the
-- reader's anchors, `social_candidates` (titles the people they follow loved), and the
-- English-heavy trending lists. Nothing in that set is chosen *for* a language or an era,
-- so a reader whose loved titles are a handful of Japanese films gets a pool that is almost
-- entirely English however the scorer weighs language — the scorer cannot select what was
-- never generated. This migration adds the server half of the fix:
--
--   recommendation_engine()   which scorer this reader gets. Default `v1` for everyone.
--   catalogue_candidates(...) a bounded, server-side source of catalogue titles in the
--                             languages and decades the client's behavioural profile
--                             (`profile.ts`) says the reader actually engages with.
--
-- ## Off by default, and how it is turned on
--
-- Three `app_config` keys, all inert as seeded:
--
--   recommendations.v2_engine           "v1" | "v2_metadata". "v1" means V2 is off.
--   recommendations.v2_rollout_percent  0–100. Deterministic per-account cohort.
--   recommendations.v2_allowlist        [uuid, ...]. Dogfood/staging accounts, regardless
--                                       of the percentage.
--   recommendations.v2_allowlist_engine null, or an engine the allowlist gets instead of
--                                       `v2_engine` — so one engine can run on a small
--                                       percentage while a more experimental one is
--                                       dogfooded on the allowlist (independent review,
--                                       2026-11-11). Null means "the same as v2_engine".
--
-- **`v2_engine` is the master switch.** While it is "v1", `recommendation_engine()` answers
-- 'v1' for every caller, allowlisted or not, whatever the override says, and
-- `catalogue_candidates` returns nothing, so this migration changes no behaviour until an
-- operator writes the key. Rollback is writing "v1" back: clients re-read the engine on
-- their next For You fetch (30-minute stale time) and fall to V1, which never stopped
-- shipping in the binary. An unknown engine value is also 'v1', on both sides.
--
-- Cohorts are `md5(user id || salt)`, not `hashtext`, which is an undocumented internal
-- whose output Postgres does not promise across versions. Raising the percentage only
-- ever adds accounts: a reader in the 5% cohort is in the 10% one.

insert into app_config (key, value) values
  ('recommendations.v2_engine',           '"v1"'::jsonb),
  ('recommendations.v2_rollout_percent',  '0'::jsonb),
  ('recommendations.v2_allowlist',        '[]'::jsonb),
  ('recommendations.v2_allowlist_engine', 'null'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The cohort, as a number 0–99. Internal: it takes an identity.
-- ---------------------------------------------------------------------------
create or replace function _recommendation_cohort(p_user_id uuid)
returns integer
language sql
immutable
set search_path = public
as $$
  select (('x' || substr(md5(p_user_id::text || ':recommendations.v2'), 1, 7))::bit(28)::integer) % 100;
$$;

revoke execute on function _recommendation_cohort(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Which engine scores this reader's For You. Always about the caller.
-- ---------------------------------------------------------------------------
create or replace function recommendation_engine()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me       uuid := auth.uid();
  v_engine   text;
  v_override text;
  v_allow    jsonb;
  v_percent  numeric;
begin
  if v_me is null then
    return 'v1';
  end if;

  select value #>> '{}' into v_engine
    from app_config where key = 'recommendations.v2_engine';
  -- The engines this schema knows. Anything else, including a typo, is V1.
  if v_engine is null or v_engine not in ('v2_metadata') then
    return 'v1';
  end if;

  select value into v_allow
    from app_config where key = 'recommendations.v2_allowlist';
  if jsonb_typeof(v_allow) = 'array' and v_allow ? v_me::text then
    -- The allowlist's own engine when one is set and known; otherwise the cohort's.
    select value #>> '{}' into v_override
      from app_config where key = 'recommendations.v2_allowlist_engine';
    if v_override in ('v2_metadata') then
      return v_override;
    end if;
    return v_engine;
  end if;

  select case when jsonb_typeof(value) = 'number' then (value)::numeric end into v_percent
    from app_config where key = 'recommendations.v2_rollout_percent';
  if coalesce(v_percent, 0) > 0 and _recommendation_cohort(v_me) < least(v_percent, 100) then
    return v_engine;
  end if;

  return 'v1';
end;
$$;

revoke execute on function recommendation_engine() from public, anon;
grant execute on function recommendation_engine() to authenticated;

-- ---------------------------------------------------------------------------
-- The catalogue source.
-- ---------------------------------------------------------------------------
--
-- One index per question it asks, each in the order the question reads it, so a window is
-- the first rows of one index range rather than a sort of everything in a language or a
-- decade. Partial, because a season and a title with no poster can never be a For You tile,
-- and those are a large share of the table.
--
-- The era index keys on the decade itself (an immutable expression of the date), not the
-- date: an index on `(kind, release_date)` cannot hand back a decade in popularity order,
-- so every call read every title of the decade and sorted them (independent review,
-- 2026-11-11). The query below repeats the expression exactly, which is what lets the
-- planner use it.
--
-- **Building these on a large table.** `create index` without `concurrently` blocks writes
-- to `media_items` (catalogue upserts) while it runs, and Supabase runs a migration inside a
-- transaction, where `concurrently` is not allowed. On a large production catalogue, build
-- both by hand with `create index concurrently if not exists …` (same definitions) before
-- `db push`; these statements are then no-ops. `recommendations-v2.md` §1.5 has the steps.
create index if not exists media_items_catalogue_language
  on media_items (kind, original_language, popularity desc nulls last)
  where kind in ('movie', 'series') and poster_path is not null;

create index if not exists media_items_catalogue_decade
  on media_items (kind, ((extract(year from release_date)::integer / 10) * 10), popularity desc nulls last)
  where kind in ('movie', 'series') and poster_path is not null;

-- Candidates in the reader's languages and decades, for the wall they are looking at.
--
-- **The client chooses the languages and decades; the server bounds them.** They come
-- from the reader's own collection (`profile.ts` `sourceLanguages` / `sourceDecades`),
-- which the client already holds, so passing them costs nothing and reveals nothing the
-- caller does not own. At most five languages and three decades are read, and at most
-- forty titles per source.
--
-- **Popularity decides the window, a seeded hash decides within it.** The top `3 × per`
-- titles by TMDB popularity in each language (or decade) are the window, so nothing
-- obscure is pulled in on popularity alone; the seed then picks `per` of them, so a
-- reader whose language has two hundred titles in the catalogue does not see the same
-- forty for ever. The client's own selection still decides what reaches the wall.
--
-- Classics are not excluded: the era source reads whole decades, and nothing filters on
-- age. A title the caller has logged, ranked or (for a series) logged a season of is
-- excluded here so it does not spend a slot; the client excludes the same set again.
--
-- Returns nothing at all while the caller's engine is 'v1'.
create or replace function catalogue_candidates(
  p_kind       text,
  p_languages  text[]    default '{}',
  p_decades    integer[] default '{}',
  p_per_source integer   default 20,
  p_seed       integer   default 0
)
returns table (
  id                uuid,
  title             text,
  release_date      date,
  poster_path       text,
  kind              media_kind,
  genres            text[],
  original_language text,
  popularity        real,
  source            text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me        uuid := auth.uid();
  v_per       integer := least(greatest(coalesce(p_per_source, 20), 1), 40);
  v_window    integer;
  v_kind      media_kind;
  v_languages text[];
  v_decades   integer[];
  v_seed      text := coalesce(p_seed, 0)::text;
begin
  if v_me is null or p_kind is null or p_kind not in ('movie', 'series') then
    return;
  end if;
  if recommendation_engine() = 'v1' then
    return;
  end if;

  v_kind := p_kind::media_kind;
  v_window := v_per * 3;
  select coalesce(array_agg(code order by first_seen), '{}') into v_languages
    from (
      select code, min(ordinality) as first_seen
        from unnest(coalesce(p_languages, '{}')) with ordinality as l(code, ordinality)
       where code ~ '^[a-z]{2,3}$'
       group by code
       order by min(ordinality)
       limit 5
    ) picked;
  select coalesce(array_agg(decade order by first_seen), '{}') into v_decades
    from (
      select decade, min(ordinality) as first_seen
        from unnest(coalesce(p_decades, '{}')) with ordinality as d(decade, ordinality)
       where decade between 1900 and 2100 and decade % 10 = 0
       group by decade
       order by min(ordinality)
       limit 3
    ) picked;

  return query
  with language_window as (
    select l.code as source_key, m.*
      from unnest(v_languages) as l(code)
     cross join lateral (
       select mi.id, mi.title, mi.release_date, mi.poster_path, mi.kind, mi.genres,
              mi.original_language, mi.popularity
         from media_items mi
        where mi.kind = v_kind
          and mi.original_language = l.code
          and mi.poster_path is not null
          and mi.release_date is not null
          and mi.release_date <= current_date
          and not exists (select 1 from user_media um
                           where um.user_id = v_me and um.media_item_id = mi.id)
          and (v_kind <> 'series' or not exists (
                select 1 from media_items s
                  join user_media um on um.media_item_id = s.id and um.user_id = v_me
                 where s.parent_id = mi.id))
        order by mi.popularity desc nulls last
        limit v_window
     ) m
  ),
  era_window as (
    select d.decade::text as source_key, m.*
      from unnest(v_decades) as d(decade)
     cross join lateral (
       select mi.id, mi.title, mi.release_date, mi.poster_path, mi.kind, mi.genres,
              mi.original_language, mi.popularity
         from media_items mi
        where mi.kind = v_kind
          and mi.poster_path is not null
          -- Exactly the index expression, so the decade is one ordered index range.
          and ((extract(year from mi.release_date)::integer / 10) * 10) = d.decade
          and mi.release_date <= current_date
          and not exists (select 1 from user_media um
                           where um.user_id = v_me and um.media_item_id = mi.id)
          and (v_kind <> 'series' or not exists (
                select 1 from media_items s
                  join user_media um on um.media_item_id = s.id and um.user_id = v_me
                 where s.parent_id = mi.id))
        order by mi.popularity desc nulls last
        limit v_window
     ) m
  ),
  drawn as (
    select w.*, 'language:' || w.source_key as tag,
           row_number() over (partition by w.source_key
                              order by md5(w.id::text || ':' || v_seed)) as pick
      from language_window w
    union all
    select w.*, 'era:' || w.source_key as tag,
           row_number() over (partition by w.source_key
                              order by md5(w.id::text || ':' || v_seed)) as pick
      from era_window w
  )
  select distinct on (dr.id)
         dr.id, dr.title, dr.release_date, dr.poster_path, dr.kind, dr.genres,
         dr.original_language, dr.popularity, dr.tag
    from drawn dr
   where dr.pick <= v_per
   order by dr.id, dr.tag;
end;
$$;

revoke execute on function catalogue_candidates(text, text[], integer[], integer, integer)
  from public, anon;
grant execute on function catalogue_candidates(text, text[], integer[], integer, integer)
  to authenticated;
