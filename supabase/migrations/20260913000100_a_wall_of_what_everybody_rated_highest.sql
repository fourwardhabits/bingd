-- A wall of what everybody rated highest.
-- Founder decision, 2026-09-09.
--
-- ===========================================================================
-- WHAT THIS IS
--
-- For You has answered one question since it existed: *what should this reader watch
-- next*, computed from their own taste. `Top Rated` answers a different one, and the
-- founder's brief is that it is a peer of Movies and TV in the same selector rather
-- than a shelf inside them: **what has this community actually rated highest.**
--
-- The number is not new and must not be. `community_score` (20260816000000,
-- 20260816000100) already computes the authoritative mean for one title, over exactly
-- the population a reader is allowed to be aggregated with, and the title page prints
-- it. This function is that same arithmetic asked about the catalogue instead of about
-- one row, and every clause it copies is copied deliberately:
--
--   * public, active accounts only -- a private ranking is not community evidence;
--   * accounts blocked in either direction excluded, so the mean here cannot be
--     differenced against the mean there to recover a blocked account's rating;
--   * `score_for` over `band_bounds`, which is the one definition of a score in this
--     product and is already shared with `src/features/collection/score.ts`.
--
-- **No new scoring model.** If this function and `community_score` ever disagree about
-- one title, this function is wrong, and `top-rated.test.mjs` is where they are held
-- to each other over randomised collections.
--
-- ---------------------------------------------------------------------------
-- WHY THE BANDS ARE COMPUTED IN A CTE RATHER THAN THROUGH band_bounds()
--
-- `community_score` reaches `band_bounds` through a lateral, which is correct and cheap
-- when the question is about one title: the lateral runs once per ranking row of that
-- title. Asked about the whole catalogue the same lateral runs once per ranking row in
-- the database, and each run is its own aggregate over that user's rankings -- an
-- O(rankings^2 / users) shape that gets slower exactly as the product succeeds.
--
-- `counts` computes the three bucket sizes for every (rater, category) in one grouped
-- pass and `bands` turns them into the same `lo`/`size` pair `band_bounds` returns. The
-- arithmetic is `band_bounds`' own, transcribed.
--
-- ---------------------------------------------------------------------------
-- THE THRESHOLD IS ITS OWN CONFIG ROW, AND THAT IS THE POINT
--
-- `score.community_min_ratings` is 1 and answers a display question: how many ratings
-- before a title page may print a number at all. Discovery is a different question with
-- a different answer -- one person's 10.0 is a true score and a false recommendation --
-- so it gets `discovery.top_rated_min_ratings`, seeded 5.
--
-- Overloading the display threshold would have coupled them: raising the discovery bar
-- to five would have blanked the score on every title page with four ratings, which is
-- most of the catalogue in a beta. Two questions, two rows.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT EXCLUDED, AND WHY
--
-- Titles this reader has already watched or ranked are **in** these results. For You's
-- slate subtracts them because it is a recommendation and recommending something
-- somebody has seen is a defect. This is a rating order over the catalogue, and a wall
-- whose first position depended on who was looking would not be one: two readers would
-- see different answers to "what is rated highest", and one of them would be looking at
-- number two under a heading that says otherwise.
--
-- The result is still viewer-relative in one respect -- blocks -- and that is inherited
-- from `community_score` rather than chosen here. It is why the client keys this query
-- by account, the same rule `useCommunityScore` records.
--
-- ---------------------------------------------------------------------------
-- TV MEANS SEASONS
--
-- `rankable_category` maps `season -> tv_seasons` and refuses a series (PRD §10), so a
-- season is the only television unit that has ever carried a score. For You's own TV
-- wall holds *series*, because TMDB answers "similar" about a show; this one cannot,
-- because a series has no rating to order by. That difference is real and is the
-- reason the two are separate entries in the selector rather than a toggle.
-- ===========================================================================

insert into app_config (key, value) values
  ('discovery.top_rated_min_ratings', '5'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The wall
--
-- Keyset rather than offset, over the total order the wall is drawn in. An offset into
-- an aggregate that moves every time anybody ranks anything hands page two a row page
-- one already showed, and the reader sees a duplicate poster rather than a missing one
-- -- which is the failure `use-feed.ts` records for the activity feed and the reason
-- it is keyed on `(causal_at, causal_step, id)` there.
--
-- The cursor is the whole sort key: `(score, rating_count)` descending and then the
-- media item's own id ascending. The id is the tie-break because it is the one column
-- in this result that cannot change -- a title's score moves, its rating count moves,
-- and its primary key does not. `popularity` was the obvious alternative and is not
-- one: it is provider metadata refreshed on a schedule, so a wall ordered by it would
-- reshuffle itself under a reader for reasons nothing in this product caused.
-- ---------------------------------------------------------------------------

create or replace function top_rated_titles(
  p_medium      text,
  p_limit       integer default 20,
  p_after_score numeric default null,
  p_after_count integer default null,
  p_after_id    uuid    default null
)
returns table (
  media_item_id uuid,
  score         numeric,
  rating_count  integer,
  min_ratings   integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_kind  media_kind;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  if p_medium is null or p_medium not in ('movies', 'tv') then
    raise exception 'top_rated_titles answers for movies or tv'
      using errcode = '22023';
  end if;

  v_kind := case p_medium when 'movies' then 'movie'::media_kind
                          else 'season'::media_kind end;

  -- A cursor is all three values or none of them. Postgres compares a row containing
  -- NULL to NULL rather than to false, so a half-supplied cursor would filter every
  -- row and return an empty page that looks exactly like the end of the wall.
  if (p_after_id is null) <> (p_after_score is null)
     or (p_after_id is null) <> (p_after_count is null) then
    raise exception 'a top_rated_titles cursor is score, count and id together'
      using errcode = '22023';
  end if;

  return query
  with threshold as (
    select coalesce(
      (select (value)::integer from app_config where key = 'discovery.top_rated_min_ratings'),
      5
    ) as k
  ),
  -- Exactly community_score's population. See the header.
  raters as (
    select p.id
      from profiles p
     where p.visibility = 'public'
       and p.status = 'active'
       and (auth.uid() is null or not blocked_between(p.id, auth.uid()))
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
    select r.media_item_id,
           round(avg(score_for(r.bucket, (r.position - b.lo + 1)::integer, b.size)), 1) as avg_score,
           count(*)::integer as n
      from rankings r
      join raters on raters.id = r.user_id
      join bands b
        on b.user_id  = r.user_id
       and b.category = r.category
       and b.bucket   = r.bucket
      join media_items m on m.id = r.media_item_id
     where m.kind = v_kind
     group by r.media_item_id
  )
  select rated.media_item_id,
         rated.avg_score,
         rated.n,
         threshold.k
    from rated, threshold
   where rated.n >= threshold.k
     and (
       p_after_id is null
       or (rated.avg_score, rated.n) < (p_after_score, p_after_count)
       or ((rated.avg_score, rated.n) = (p_after_score, p_after_count)
           and rated.media_item_id > p_after_id)
     )
   order by rated.avg_score desc, rated.n desc, rated.media_item_id asc
   limit v_limit;
end;
$$;

comment on function top_rated_titles(text, integer, numeric, integer, uuid) is
  'One page of the catalogue ordered by the community score community_score computes for a single title, over the same public active unblocked population, for movies or for TV seasons. Eligibility starts at app_config discovery.top_rated_min_ratings, which is deliberately not the display threshold score.community_min_ratings. Keyset paginated on (score desc, rating_count desc, id asc); the cursor is all three values or none.';

-- Postgres grants EXECUTE to PUBLIC on a new function, so the revoke is the
-- restriction and the grant only names who is left (20260813001800).
revoke execute on function top_rated_titles(text, integer, numeric, integer, uuid)
  from public, anon;
grant execute on function top_rated_titles(text, integer, numeric, integer, uuid)
  to authenticated;
