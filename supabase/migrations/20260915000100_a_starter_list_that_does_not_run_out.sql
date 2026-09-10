-- A starter list that does not run out.
-- Founder physical QA, iOS 1.0.1 build 9, 2026-09-09.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- The first screen of the product asks somebody to name movies they have seen, and the
-- grid it offered to start them off was `useTrending` -- `provider_list_cache`, TMDB's
-- `trending.movie.day` and `trending.series.day` mixed together and cut to
-- `TRENDING_SHELF_SIZE` (12) *before* the screen filtered the series out. A first-run
-- picker therefore held somewhere between five and twelve movies, drawn from whatever was
-- trending on a film database the day the adapter last ran, and the founder exhausted it
-- after four titles on a physical device.
--
-- Two separate defects sit in that sentence and both are answered here:
--
--   * **it is too short**, because a shelf's twelve and a picker's supply are not the
--     same requirement; and
--   * **it is not about this product**. What is trending on TMDB today is not what the
--     people on bingd. have actually watched and rated, and the first list somebody sees
--     should be the second thing.
--
-- ---------------------------------------------------------------------------
-- WHAT REPLACES IT: POPULAR ENOUGH TO HAVE SIGNAL, THEN BEST-RATED WITHIN THAT
--
-- The founder's definition, in the order the two halves have to be applied:
--
--   1. take every **movie** anybody has ranked, with its ranking count;
--   2. eligibility is `max(90th percentile of that count, discovery.starter_min_ratings)`
--      -- roughly the top tenth of the most-ranked catalogue, and never a title carried
--      by one or two ratings however high they are;
--   3. order what survives by community score descending, then ranking count descending,
--      then the media item's own id -- the same total order `top_rated_titles` is drawn
--      in, and for the same reason: the id is the only column in the result that cannot
--      move under a reader.
--
-- Step 2 is the whole point. A single 10.0 from one account is a true score and a false
-- recommendation, and the head of the first list somebody ever sees is the most expensive
-- place in the product to be wrong.
--
-- The percentile is taken over **the titles that have rankings**, not over the catalogue.
-- `media_items` is a cache of everything anybody ever searched for, so its median row has
-- no ratings at all and a percentile over that population would be zero for ever -- which
-- would make the floor the only rule and delete step 2.
--
-- **The score is not new and must not be.** `rated` below is `top_rated_titles`' own
-- aggregate, transcribed clause for clause: the same public/active/unblocked population
-- `community_score` defines, the same `score_for` over the same band arithmetic, and the
-- same reason for computing the bands in a CTE rather than through a per-row lateral (an
-- O(rankings^2 / users) shape that gets slower exactly as the product succeeds). If this
-- function and `community_score` ever disagree about one title, this function is wrong,
-- and `starter-movies.test.mjs` is where they are held to each other.
--
-- ---------------------------------------------------------------------------
-- THE SPARSE-DATA FALLBACK, WHICH IS THE CASE THE PRODUCT IS ACTUALLY IN
--
-- On a beta with a handful of accounts the eligible pool is small and can be empty: three
-- titles with one rating each give a 90th percentile of 1, the floor raises it to 3, and
-- nothing clears it. That is the correct answer to "what has this community rated
-- highest" and a useless answer to "what might you have seen" -- and an empty first
-- screen is the defect this migration exists to remove, not a state it may return to.
--
-- So the shortfall is topped up from `media_items.popularity`: provider metadata the
-- catalogue already carries, for every movie in it rather than for twelve, which is
-- exactly the signal the trending grid was reaching for by a much narrower road.
--
-- The two halves are **labelled** rather than blended. `source` says which rule admitted
-- each row, so a client can tell a community answer from a catalogue one and a report can
-- say how close the platform is to not needing the fallback at all. Blending them would
-- need a scale on which "9.4 from eleven people" and "popularity 61.2" are comparable,
-- and there is no such scale.
--
-- `poster_path is not null` on the fallback only. A community row earned its place by
-- being ranked and is shown whatever artwork it has; a catalogue row is being offered
-- purely as something to recognise, and a poster is how somebody recognises it.
--
-- ---------------------------------------------------------------------------
-- WHY IT EXCLUDES WHAT THE CALLER HAS ALREADY RANKED, AND top_rated_titles DOES NOT
--
-- `top_rated_titles` deliberately keeps them: it is a wall whose heading claims a fact
-- about the catalogue, and a wall whose first position depended on who was looking would
-- not be one.
--
-- This is not a wall. It is the supply for a picker whose whole job is to reach five
-- *distinct* rankings, and offering a title the caller has already placed is a step that
-- cannot advance -- on a flow with no other exit, a reader who picked the same movie
-- twice would sit at four of five for as long as they kept picking it. The exclusion is
-- a correctness requirement of the surface rather than a preference, and it belongs here
-- rather than in the client, where the list would still have been short by however many
-- rows it then dropped.
--
-- ---------------------------------------------------------------------------
-- ADDITIVE. Nothing is dropped, nothing is altered, and `top_rated_titles`,
-- `provider_list_cache` and the Trending shelf are untouched.
-- ===========================================================================

insert into app_config (key, value) values
  ('discovery.starter_min_ratings', '3'::jsonb)
on conflict (key) do nothing;

create or replace function starter_movies(p_limit integer default 60)
returns table (
  media_item_id uuid,
  score         numeric,
  rating_count  integer,
  min_ratings   integer,
  source        text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_floor integer;
begin
  -- `security definer` over `rankings` and `profiles`, so the caller's identity is the
  -- only thing standing between this and a readable digest of private collections. The
  -- grant below says `authenticated`; this says the same thing to a session that reached
  -- the function some other way.
  if auth.uid() is null then
    raise exception 'starter_movies answers for a signed-in caller'
      using errcode = '42501';
  end if;

  v_floor := coalesce(
    (select (value)::integer from app_config where key = 'discovery.starter_min_ratings'),
    3
  );

  return query
  with raters as (
    select p.id
      from profiles p
     where p.visibility = 'public'
       and p.status = 'active'
       and not blocked_between(p.id, auth.uid())
  ),
  counts as (
    select r.user_id,
           r.category,
           count(*) filter (where r.bucket = 'loved')::integer      as loved,
           count(*) filter (where r.bucket = 'fine')::integer       as fine,
           count(*) filter (where r.bucket = 'not_for_me')::integer as nfm
      from rankings r
      join raters on raters.id = r.user_id
     group by r.user_id, r.category
  ),
  -- band_bounds()'s arithmetic, once per (rater, category) instead of once per row.
  bands as (
    select user_id, category, 'loved'::taste_bucket as bucket,
           1                as lo, loved as size from counts
    union all
    select user_id, category, 'fine'::taste_bucket,
           loved + 1        as lo, fine  as size from counts
    union all
    select user_id, category, 'not_for_me'::taste_bucket,
           loved + fine + 1 as lo, nfm   as size from counts
  ),
  rated as (
    select r.media_item_id as id,
           round(avg(score_for(r.bucket, (r.position - b.lo + 1)::integer, b.size)), 1) as avg_score,
           count(*)::integer as n
      from rankings r
      join raters on raters.id = r.user_id
      join bands b
        on b.user_id  = r.user_id
       and b.category = r.category
       and b.bucket   = r.bucket
      join media_items m on m.id = r.media_item_id
     where m.kind = 'movie'::media_kind
     group by r.media_item_id
  ),
  cutoff as (
    select greatest(
             coalesce(percentile_disc(0.9) within group (order by rated.n), 0),
             v_floor
           )::integer as k
      from rated
  ),
  mine as (
    select r.media_item_id as id
      from rankings r
     where r.user_id = auth.uid()
  ),
  /**
   * Each half carries its own position, because the two are ordered by different things
   * and the final sort has to preserve both. A single `order by score desc, count desc,
   * id` over the union would put every catalogue row in *id* order -- they all have a
   * null score and a zero count, so those two clauses tie and the id decides -- which
   * silently discards the popularity ordering the fallback exists to supply.
   *
   * `row_number()` is evaluated before `limit`, so the rows that survive the limit carry
   * 1..n in the order the window was computed in, which is the order beside it.
   */
  community as (
    select rated.id,
           rated.avg_score as score,
           rated.n         as rating_count,
           row_number() over (
             order by rated.avg_score desc, rated.n desc, rated.id asc
           ) as ord
      from rated, cutoff
     where rated.n >= cutoff.k
       and not exists (select 1 from mine where mine.id = rated.id)
     order by rated.avg_score desc, rated.n desc, rated.id asc
     limit v_limit
  ),
  topup as (
    select m.id,
           null::numeric as score,
           0             as rating_count,
           row_number() over (order by m.popularity desc nulls last, m.id asc) as ord
      from media_items m
     where m.kind = 'movie'::media_kind
       and m.poster_path is not null
       and not exists (select 1 from community c where c.id = m.id)
       and not exists (select 1 from mine where mine.id = m.id)
     order by m.popularity desc nulls last, m.id asc
     limit greatest(v_limit - (select count(*) from community), 0)
  ),
  merged as (
    select 0 as tier, community.id, community.score, community.rating_count,
           community.ord, 'community'::text as source
      from community
    union all
    select 1 as tier, topup.id, topup.score, topup.rating_count,
           topup.ord, 'popularity'::text as source
      from topup
  )
  select merged.id,
         merged.score,
         merged.rating_count,
         (select cutoff.k from cutoff),
         merged.source
    from merged
   -- The community rows first in their own order, the catalogue rows after them in
   -- theirs. `tier` says that rather than relying on 'community' < 'popularity', which is
   -- true and is a coincidence of spelling.
   order by merged.tier asc, merged.ord asc;
end;
$$;

comment on function starter_movies(integer) is
  'The first-run picker''s supply of movies: community-scored titles whose ranking count clears max(90th percentile over ranked movies, app_config discovery.starter_min_ratings), ordered by that score then by how many people ranked them, topped up from media_items.popularity when the platform has too few eligible titles. Rows the caller has already ranked are excluded, because the surface is a picker that must reach five distinct rankings. min_ratings is the threshold actually applied and source says which rule admitted each row.';

-- Postgres grants EXECUTE to PUBLIC on a new function, so the revoke is the restriction
-- and the grant only names who is left (20260813001800).
revoke execute on function starter_movies(integer) from public, anon;
grant execute on function starter_movies(integer) to authenticated;
