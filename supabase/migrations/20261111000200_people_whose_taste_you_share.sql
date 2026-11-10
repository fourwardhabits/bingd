-- Recommendation Engine V2, A2: taste-compatible collaborative evidence (founder spec
-- 2026-11-10, §3 A2).
--
-- V1's only people-based source is `social_candidates`: what the accounts a reader
-- *follows* loved. The spec rules that following alone is no evidence about taste, and asks
-- instead for evidence from people whose taste matches the reader's — strangers included —
-- chosen and weighted by the same Taste logic the Match % uses, computed server-side, and
-- never by comparing the reader against every account. This migration adds that:
--
--   _scored_rankings(users[])      every ranking of a set of users as its 0–10 score, in one
--                                  pass (taste_match's `band_bounds` lateral is per row).
--   _taste_matches(reader, users[]) taste_match's arithmetic, unchanged, for one reader
--                                  against many at once. Equality is tested.
--   _refresh_taste_neighbours(reader)  bounded neighbour retrieval into a cache.
--   collaborative_candidates(kind, limit)  titles those neighbours rate highly, as ids and an
--                                  aggregate only, for engine `v2_hybrid` only.
--
-- ## Who may be a neighbour
--
-- A **public**, active account the reader may discover (not blocked either way), with at
-- least `taste.min_common` exact shared ranked titles. Following plays no part: a followed
-- account counts exactly as much as a stranger with the same Match, and a *private* account
-- is never a neighbour even when the reader follows it — otherwise following would decide
-- whose evidence counts. Re-checked on every read, so a cached neighbour who goes private,
-- blocks, or is suspended stops counting at once.
--
-- ## Bounded, by construction
--
-- Retrieval probes at most `recommendations.neighbour_probe_titles` (40) of the reader's
-- most opinionated ranked titles, and from each takes at most
-- `recommendations.neighbour_raters_per_title` (50) raters from a rotating point in the
-- `(media_item_id, user_id)` index — so a title ranked by a million people costs fifty index
-- rows, not a million. At most 200 of those (most co-occurrences first) are scored, and the
-- best `recommendations.neighbour_limit` (40) are cached for
-- `recommendations.neighbour_ttl_hours` (24). Nothing here scans every account, and nothing
-- runs on a write path.
--
-- ## Off by default
--
-- `collaborative_candidates` answers empty unless the caller's engine is `v2_hybrid`, which
-- `recommendation_engine()` returns only when `recommendations.v2_engine` says so. Until then
-- the cache is never filled.

insert into app_config (key, value) values
  ('recommendations.neighbour_probe_titles',     '40'::jsonb),
  ('recommendations.neighbour_raters_per_title', '50'::jsonb),
  ('recommendations.neighbour_limit',            '40'::jsonb),
  ('recommendations.neighbour_ttl_hours',        '24'::jsonb),
  ('recommendations.neighbour_min_match',        '55'::jsonb)
on conflict (key) do nothing;

-- The engines this schema knows, now including v2_hybrid. Otherwise unchanged.
create or replace function recommendation_engine()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_engine  text;
  v_allow   jsonb;
  v_percent numeric;
begin
  if v_me is null then
    return 'v1';
  end if;

  select value #>> '{}' into v_engine
    from app_config where key = 'recommendations.v2_engine';
  if v_engine is null or v_engine not in ('v2_metadata', 'v2_hybrid') then
    return 'v1';
  end if;

  select value into v_allow
    from app_config where key = 'recommendations.v2_allowlist';
  if jsonb_typeof(v_allow) = 'array' and v_allow ? v_me::text then
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

-- Rater sampling walks this from a rotating user id, so a popular title is never read whole.
create index if not exists rankings_by_media_user on rankings (media_item_id, user_id);

-- ---------------------------------------------------------------------------
-- Scores, set-based
-- ---------------------------------------------------------------------------
--
-- `band_bounds` + `score_for`, for many users in one pass: a band's start is the count of
-- the bands above it, so a title's rank within its band is its position less that count.
create or replace function _scored_rankings(p_users uuid[])
returns table (user_id uuid, media_item_id uuid, category ranking_category, score numeric)
language sql
stable
set search_path = public
as $$
  with counts as (
    select r.user_id, r.category,
           count(*) filter (where r.bucket = 'loved')      as loved,
           count(*) filter (where r.bucket = 'fine')       as fine,
           count(*) filter (where r.bucket = 'not_for_me') as nfm
      from rankings r
     where r.user_id = any(p_users)
     group by r.user_id, r.category
  )
  select r.user_id, r.media_item_id, r.category,
         round(score_for(
           r.bucket,
           (r.position - case r.bucket when 'loved' then 0
                                       when 'fine'  then c.loved
                                       else c.loved + c.fine end)::integer,
           (case r.bucket when 'loved' then c.loved
                          when 'fine'  then c.fine
                          else c.nfm end)::integer
         ), 1)
    from rankings r
    join counts c on c.user_id = r.user_id and c.category = r.category
   where r.user_id = any(p_users);
$$;

revoke execute on function _scored_rankings(uuid[]) from public, anon, authenticated;

-- `taste_match`'s arithmetic — proximity, midrank Spearman, the n/(n+p) shrink — for one
-- reader against many. **No visibility check**: it takes identities, is granted to nobody,
-- and every caller filters who it is asked about. Score is null below `taste.min_common`.
create or replace function _taste_matches(p_reader uuid, p_others uuid[])
returns table (other_id uuid, score integer, common_count integer)
language sql
stable
set search_path = public
as $$
  with threshold as (
    select
      coalesce((select (value)::integer from app_config where key = 'taste.min_common'), 5) as k,
      coalesce((select (value)::integer from app_config where key = 'taste.shrink_prior'), 5) as p
  ),
  mine as (
    select s.media_item_id, s.score as a from _scored_rankings(array[p_reader]) s
  ),
  theirs as (
    select s.user_id, s.media_item_id, s.score as b
      from _scored_rankings(p_others) s
     where s.user_id <> p_reader
  ),
  common as (
    select t.user_id, m.a, t.b from mine m join theirs t on t.media_item_id = m.media_item_id
  ),
  ranked as (
    select user_id, a, b,
           rank() over (partition by user_id order by a)
             + (count(*) over (partition by user_id, a) - 1) / 2.0 as ra,
           rank() over (partition by user_id order by b)
             + (count(*) over (partition by user_id, b) - 1) / 2.0 as rb
      from common
  ),
  stats as (
    select user_id, count(*)::integer as n, avg(abs(a - b)) as mean_gap, corr(ra, rb) as rho
      from ranked
     group by user_id
  ),
  parts as (
    select stats.user_id, stats.n, threshold.k, threshold.p,
           greatest(0, least(100, 100 * (1 - coalesce(stats.mean_gap, 7) / 7))) as proximity,
           case when stats.rho is null then null else 50 * (stats.rho + 1) end as agreement,
           0.25 * greatest(0, least(1, (stats.n - 8) / 12.0)) as w
      from stats, threshold
  )
  select parts.user_id,
         case when parts.n >= parts.k then
           round(50 + (
             case when parts.agreement is null then parts.proximity
                  else (1 - parts.w) * parts.proximity + parts.w * parts.agreement end - 50
           ) * (parts.n::numeric / (parts.n + parts.p)))::integer
         end,
         parts.n
    from parts;
$$;

revoke execute on function _taste_matches(uuid, uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The neighbour cache. Server-only: RLS on, no policy, no grant.
-- ---------------------------------------------------------------------------
create table if not exists taste_neighbours (
  reader_id    uuid not null references profiles(id) on delete cascade,
  neighbour_id uuid not null references profiles(id) on delete cascade,
  match        integer not null,
  common_count integer not null,
  -- 0–1. How much this neighbour's opinions count, before anything about titles.
  weight       real not null,
  computed_at  timestamptz not null default now(),
  primary key (reader_id, neighbour_id)
);
create index if not exists taste_neighbours_neighbour on taste_neighbours (neighbour_id);

-- One row per reader once computed, so "computed, nobody qualified" is not recomputed per read.
create table if not exists taste_neighbour_refresh (
  reader_id    uuid primary key references profiles(id) on delete cascade,
  refreshed_at timestamptz not null default now(),
  neighbours   integer not null default 0
);

alter table taste_neighbours        enable row level security;
alter table taste_neighbour_refresh enable row level security;
revoke all on taste_neighbours, taste_neighbour_refresh from anon, authenticated;

-- How much a neighbour's opinions count.
--
-- **Lift above a floor, times reliability.** Match is already shrunk toward 50 by n/(n+5),
-- so a two-title 100% match cannot exist; this adds a second, stricter reliability term so a
-- neighbour on the minimum overlap cannot outweigh a cohort of well-evidenced ones (spec:
-- "a weak high Match must not dominate a reliable cohort"). Below the floor the weight is
-- **zero, not negative**: low compatibility is not opposite taste, and a neighbour's dislikes
-- are not read as the reader's likes.
create or replace function _taste_neighbour_weight(p_match integer, p_common integer, p_floor integer)
returns real
language sql
immutable
set search_path = public
as $$
  select (greatest(0, p_match - p_floor)::numeric / greatest(1, 100 - p_floor)
          * (p_common::numeric / (p_common + 10)))::real;
$$;

revoke execute on function _taste_neighbour_weight(integer, integer, integer) from public, anon, authenticated;

create or replace function _refresh_taste_neighbours(p_reader uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_probe   integer;
  v_per     integer;
  v_limit   integer;
  v_floor   integer;
  v_pivot   uuid;
  v_kept    integer;
  v_now     timestamptz := clock_timestamp();
begin
  if p_reader is null then
    return 0;
  end if;
  -- One refresh per reader at a time; a second caller waits and then reads the fresh rows.
  perform pg_advisory_xact_lock(hashtextextended('taste_neighbours:' || p_reader::text, 0));

  select least(greatest(coalesce((value)::integer, 40), 5), 100) into v_probe
    from app_config where key = 'recommendations.neighbour_probe_titles';
  select least(greatest(coalesce((value)::integer, 50), 5), 200) into v_per
    from app_config where key = 'recommendations.neighbour_raters_per_title';
  select least(greatest(coalesce((value)::integer, 40), 1), 100) into v_limit
    from app_config where key = 'recommendations.neighbour_limit';
  select least(greatest(coalesce((value)::integer, 55), 50), 95) into v_floor
    from app_config where key = 'recommendations.neighbour_min_match';
  v_probe := coalesce(v_probe, 40);
  v_per   := coalesce(v_per, 50);
  v_limit := coalesce(v_limit, 40);
  v_floor := coalesce(v_floor, 55);
  -- A different slice of every popular title's raters each day.
  v_pivot := md5(p_reader::text || ':' || current_date::text)::uuid;

  insert into taste_neighbours (reader_id, neighbour_id, match, common_count, weight, computed_at)
  with probe as (
    -- The reader's strongest opinions first, the less popular first among equals: a shared
    -- love of an obscure film says more about two people than a shared love of a hit.
    select s.media_item_id
      from _scored_rankings(array[p_reader]) s
      join media_items m on m.id = s.media_item_id
     order by abs(s.score - 5) desc, m.popularity asc nulls first, s.media_item_id
     limit v_probe
  ),
  sampled as (
    select r.user_id
      from probe
     cross join lateral (
       (select rk.user_id from rankings rk
         where rk.media_item_id = probe.media_item_id and rk.user_id > v_pivot
         order by rk.user_id limit v_per)
       union all
       (select rk.user_id from rankings rk
         where rk.media_item_id = probe.media_item_id and rk.user_id <= v_pivot
         order by rk.user_id limit v_per)
       limit v_per
     ) r
     where r.user_id <> p_reader
  ),
  hits as (
    select user_id, count(*) as hits from sampled group by user_id
  ),
  -- Counted first, so visibility is checked once per account rather than once per title.
  shortlist as (
    select h.user_id
      from hits h
      join profiles p on p.id = h.user_id
     where p.visibility = 'public'
       and can_discover_profile(p_reader, h.user_id)
     order by h.hits desc, h.user_id
     limit 200
  ),
  matched as (
    select tm.other_id, tm.score, tm.common_count
      from _taste_matches(p_reader, array(select user_id from shortlist)) tm
     where tm.score is not null
  ),
  weighted as (
    select other_id, score, common_count,
           _taste_neighbour_weight(score, common_count, v_floor) as weight
      from matched
  )
  select p_reader, other_id, score, common_count, weight, v_now
    from weighted
   where weight > 0
   order by weight desc, other_id
   limit v_limit
  on conflict (reader_id, neighbour_id) do update
    set match = excluded.match, common_count = excluded.common_count,
        weight = excluded.weight, computed_at = excluded.computed_at;

  -- Whoever this pass did not keep is no longer a neighbour.
  delete from taste_neighbours
   where reader_id = p_reader and computed_at <> v_now;

  select count(*)::integer into v_kept from taste_neighbours where reader_id = p_reader;
  insert into taste_neighbour_refresh (reader_id, refreshed_at, neighbours)
  values (p_reader, v_now, v_kept)
  on conflict (reader_id) do update
    set refreshed_at = excluded.refreshed_at, neighbours = excluded.neighbours;
  return v_kept;
end;
$$;

revoke execute on function _refresh_taste_neighbours(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The read
-- ---------------------------------------------------------------------------
--
-- Titles the reader's taste neighbours rate, as **an id, an aggregate and a count** — never
-- a person, a score of one person, or a neighbour id.
--
-- `support` is a confidence-weighted, shrunk mean valence: Σ weight × (score − 5)/5 over
-- neighbours who ranked it, divided by Σ weight plus a prior of one full-weight neutral
-- opinion. Neighbours' dislikes count against a title (spec: consider negatives). A title
-- needs at least two neighbours who scored it 7 or more, so no single person's ranking is
-- ever the reason a title appears. On TV, a neighbour's seasons count once per show, at the
-- best season.
create or replace function collaborative_candidates(p_kind text, p_limit integer default 40)
returns table (media_item_id uuid, support real, endorsers integer)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_ttl   integer;
  v_limit integer := least(greatest(coalesce(p_limit, 40), 1), 100);
  v_fresh boolean;
begin
  if v_me is null or p_kind is null or p_kind not in ('movie', 'series') then
    return;
  end if;
  if recommendation_engine() <> 'v2_hybrid' then
    return;
  end if;

  select least(greatest(coalesce((value)::integer, 24), 1), 24 * 14) into v_ttl
    from app_config where key = 'recommendations.neighbour_ttl_hours';
  v_ttl := coalesce(v_ttl, 24);
  select exists (
    select 1 from taste_neighbour_refresh
     where reader_id = v_me and refreshed_at > now() - make_interval(hours => v_ttl)
  ) into v_fresh;
  if not v_fresh then
    -- Two stale reads at once (two tabs, a retry) refresh once: the second waits on the lock
    -- the refresh itself takes, then finds the first one's rows fresh. Advisory locks are
    -- re-entrant within a session, so the refresh taking it again does not deadlock.
    perform pg_advisory_xact_lock(hashtextextended('taste_neighbours:' || v_me::text, 0));
    select exists (
      select 1 from taste_neighbour_refresh
       where reader_id = v_me and refreshed_at > clock_timestamp() - make_interval(hours => v_ttl)
    ) into v_fresh;
    if not v_fresh then
      perform _refresh_taste_neighbours(v_me);
    end if;
  end if;

  return query
  with nb as (
    select n.neighbour_id, n.weight
      from taste_neighbours n
      join profiles p on p.id = n.neighbour_id
     where n.reader_id = v_me
       and p.visibility = 'public'
       and can_discover_profile(v_me, n.neighbour_id)
  ),
  opinions as (
    select case when p_kind = 'series' then coalesce(m.parent_id, m.id) else m.id end as item,
           s.user_id, max(s.score) as score
      from _scored_rankings(array(select neighbour_id from nb)) s
      join media_items m on m.id = s.media_item_id
     where (p_kind = 'movie' and m.kind = 'movie')
        or (p_kind = 'series' and m.kind in ('season', 'series'))
     group by 1, 2
  ),
  agg as (
    select o.item,
           sum(nb.weight * ((o.score - 5) / 5.0)) as pull,
           sum(nb.weight) as mass,
           count(*) filter (where o.score >= 7) as lovers
      from opinions o
      join nb on nb.neighbour_id = o.user_id
     group by o.item
  )
  select agg.item, (agg.pull / (agg.mass + 1.0))::real, agg.lovers::integer
    from agg
   where agg.lovers >= 2
     and agg.pull > 0
     and not exists (select 1 from user_media um where um.user_id = v_me and um.media_item_id = agg.item)
     and not exists (select 1 from rankings rk where rk.user_id = v_me and rk.media_item_id = agg.item)
     and (p_kind <> 'series' or not exists (
           select 1 from media_items s
             join user_media um on um.media_item_id = s.id and um.user_id = v_me
            where s.parent_id = agg.item))
   order by agg.pull / (agg.mass + 1.0) desc, agg.item
   limit v_limit;
end;
$$;

revoke execute on function collaborative_candidates(text, integer) from public, anon;
grant execute on function collaborative_candidates(text, integer) to authenticated;
