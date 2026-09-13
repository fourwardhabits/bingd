-- One support floor for every surface that ranks titles by the community score.
--
-- ---------------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------------
--
-- Two surfaces order the catalogue by `community_score`, and each had its own idea of
-- how many ratings a title needs before that score is worth ranking by:
--
--   * `top_rated_titles` (20260913000100) — a fixed `discovery.top_rated_min_ratings` = 5.
--   * `starter_movies`   (20260915000100) — max(90th percentile of rating count over rated
--     movies, `discovery.starter_min_ratings` = 3).
--
-- They answer the same question — is this number carried by enough people to put a
-- title in front of somebody on the strength of it — and they answered it differently,
-- with nothing tying the two together. The founder's decision (2026-09-13) is one answer,
-- used by both, and a dynamic one: filter for sufficiently supported titles first, then
-- sort the survivors by score.
--
-- `score.community_min_ratings` is untouched and remains a different question: whether a
-- title page may print a number at all (1 since 20260910000100). This migration is about
-- ranking by the number, not about showing it.
--
-- ---------------------------------------------------------------------------
-- THE RULE
-- ---------------------------------------------------------------------------
--
--   floor(kind) = max( percentile_disc(p) of per-title rating count over titles of that
--                      kind with at least one eligible rating,
--                      min_ratings )
--
-- with p = `discovery.support_percentile` (0.9) and min_ratings =
-- `discovery.support_min_ratings` (3). Movies and TV seasons are separate distributions,
-- because they are separate walls and TV is far thinner.
--
-- WHY THE 90TH PERCENTILE — the read-only production aggregate of 2026-09-13, over
-- public active raters (22 of them), counts only, no identities:
--
--                       titles 1+   p50  p70  p75  p80  p90  max   eligible at max(p, 3)
--   movies                  274       1    1    2    2    3   10     29 at every p
--   TV seasons              114       1    1    1    1    2    3      1 at every p
--
-- Every candidate percentile from p50 to p90 sits at or below the floor of 3, so today
-- they are the same rule and admit the same 29 movies and 1 season. Where two options are
-- equivalent the brief is to prefer the more conservative, and that is the highest — but
-- the shape of the distribution is the better reason. Rating counts are a long tail
-- (median 1, maximum 10), so the lower percentiles sit on 1 and 2 and would stay masked by
-- the floor for as long as that shape holds: a p75 rule is a parameter that does nothing.
-- p90 is the only candidate that lifts above the floor first as the community grows, which
-- is the whole point of a dynamic floor. It is not chosen because onboarding already used
-- it; that is a coincidence this migration makes into a rule.
--
-- WHAT MOVES. Top Rated's bar was a fixed 5 and becomes max(p90, 3), which is 3 today:
-- movies 14 -> 29 eligible, TV seasons 0 -> 1. Onboarding's `starter_movies` rule is
-- unchanged in value; what changes is that its distribution is now the platform's rather
-- than the caller's (see below).
--
-- ---------------------------------------------------------------------------
-- DESIGN
-- ---------------------------------------------------------------------------
--
-- A single function, `community_support_floor(media_kind)`, called by both surfaces. Not a
-- shared constant restated twice — the failure being fixed is exactly two copies drifting.
--
-- **The distribution is the platform's, not the caller's.** It is computed over public
-- active raters without the caller's block list. A support floor is a property of the
-- catalogue; if it moved with whom the reader had blocked, two readers could see different
-- cutoffs for the same wall. Each surface still counts a title's own ratings over the
-- caller's population (blocks excluded, as `community_score` does), so blocking a rater can
-- still drop a title below the floor *for that reader* — which is correct: that rating is
-- not part of what they are shown.
--
-- Internal. It is revoked from every client role and reached only inside the two definer
-- functions, which run as the owner. It discloses nothing either of them does not already
-- return in `min_ratings`, but a floor is not a product surface of its own.
--
-- The operator values are shape-tested and clamped rather than trusted: a row that is not a
-- JSON number is treated as absent, a percentile outside [0, 1] would make `percentile_disc`
-- raise and take both walls down with it, a floor below 1 would admit unrated rows, and a
-- fractional or enormous floor must not raise in the integer cast.
--
-- The two superseded rows are deleted rather than left behind. A tuning row that nothing
-- reads is a knob somebody will turn and watch do nothing.
--
-- Signatures of both callers are unchanged, so every shipped client keeps working against
-- this migration and against the one before it. Only eligibility differs.
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values
  ('discovery.support_percentile', '0.9'::jsonb),
  ('discovery.support_min_ratings', '3'::jsonb)
on conflict (key) do nothing;

delete from app_config
 where key in ('discovery.top_rated_min_ratings', 'discovery.starter_min_ratings');

create or replace function community_support_floor(p_kind media_kind)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_pct       numeric;
  v_floor_raw numeric;
  v_floor     integer;
  v_k         integer;
begin
  -- `select ... into` from a subquery that can return no row leaves the variable null, and
  -- the coalesce afterwards is what applies the default. Written this way on purpose: the
  -- `coalesce` inside a `from app_config where key = ...` form is never evaluated when the
  -- row is absent (config-defaults.test.mjs exists to police that shape).
  --
  -- **Shape-tested before the cast, and that is the point of this function being shared**
  -- (independent review 81). Two surfaces now stand on these two rows, so a row that raised
  -- would take Top Rated and the onboarding picker down together. A jsonb string ("0.9"),
  -- an object, a boolean or null casts to numeric with an error, not a null — so anything
  -- that is not a JSON number is treated as absent and the default applies. A JSON number
  -- cannot be NaN or infinite, so what survives the type test is a finite value, and the
  -- clamps below finish the job: a percentile into [0, 1], and a minimum floored to a whole
  -- count and held in [1, 1000000] *before* the integer cast, so neither 2.5 nor 1e12 can
  -- raise on the way in.
  v_pct := (select case when jsonb_typeof(value) = 'number' then (value)::numeric end
              from app_config where key = 'discovery.support_percentile');
  v_pct := least(greatest(coalesce(v_pct, 0.9), 0), 1);

  v_floor_raw := (select case when jsonb_typeof(value) = 'number' then (value)::numeric end
                    from app_config where key = 'discovery.support_min_ratings');
  v_floor := least(greatest(floor(coalesce(v_floor_raw, 3)), 1), 1000000)::integer;

  select percentile_disc(v_pct) within group (order by rated.n)
    into v_k
    from (
      select count(*)::integer as n
        from rankings r
        join profiles p
          on p.id = r.user_id
         and p.visibility = 'public'
         and p.status = 'active'
        join media_items m on m.id = r.media_item_id
       where m.kind = p_kind
       group by r.media_item_id
    ) rated;

  return greatest(coalesce(v_k, 0), v_floor);
end;
$$;

comment on function community_support_floor(media_kind) is
  'How many eligible ratings a title needs before a surface may rank it by its community score: max(percentile_disc(app_config discovery.support_percentile, default 0.9) of per-title rating count over titles of this kind with at least one rating from a public active account, app_config discovery.support_min_ratings, default 3). The distribution is the platform''s and ignores the caller''s blocks, so the cutoff is the same for every reader. Used by top_rated_titles and starter_movies so the two cannot drift. Internal.';

revoke execute on function community_support_floor(media_kind) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- top_rated_titles: the fixed threshold becomes the shared floor. Nothing else changes —
-- population, arithmetic, ordering, cursor and grants are exactly 20260913000100's.
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
  v_k     integer;
begin
  if p_medium is null or p_medium not in ('movies', 'tv') then
    raise exception 'top_rated_titles answers for movies or tv'
      using errcode = '22023';
  end if;

  v_kind := case p_medium when 'movies' then 'movie'::media_kind
                          else 'season'::media_kind end;

  if (p_after_id is null) <> (p_after_score is null)
     or (p_after_id is null) <> (p_after_count is null) then
    raise exception 'a top_rated_titles cursor is score, count and id together'
      using errcode = '22023';
  end if;

  -- Once per call, before the query, so a page and the page after it are cut at the same
  -- bar even though each call recomputes it.
  v_k := community_support_floor(v_kind);

  return query
  with raters as (
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
         v_k
    from rated
   where rated.n >= v_k
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
  'One page of the catalogue ordered by the community score community_score computes for a single title, over the same public active unblocked population, for movies or for TV seasons. Eligibility is community_support_floor(kind) — shared with starter_movies — and deliberately not the display threshold score.community_min_ratings. Supported titles are filtered first and the survivors sorted by (score desc, rating_count desc, id asc); keyset paginated on those three, and the cursor is all three values or none.';

-- ---------------------------------------------------------------------------
-- starter_movies: the local p90 cutoff becomes the shared floor. The popularity fallback,
-- the caller's own exclusions, the tiering and the grants are exactly 20260915000100's.
-- ---------------------------------------------------------------------------

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
  v_k     integer;
begin
  if auth.uid() is null then
    raise exception 'starter_movies answers for a signed-in caller'
      using errcode = '42501';
  end if;

  v_k := community_support_floor('movie'::media_kind);

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
  mine as (
    select r.media_item_id as id
      from rankings r
     where r.user_id = auth.uid()
  ),
  -- Each half carries its own position; see 20260915000100 for why a single sort over the
  -- union would put every popularity row in id order.
  community as (
    select rated.id,
           rated.avg_score as score,
           rated.n         as rating_count,
           row_number() over (
             order by rated.avg_score desc, rated.n desc, rated.id asc
           ) as ord
      from rated
     where rated.n >= v_k
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
         v_k,
         merged.source
    from merged
   order by merged.tier asc, merged.ord asc;
end;
$$;

comment on function starter_movies(integer) is
  'The first-run picker''s supply of movies: community-scored titles whose ranking count clears community_support_floor(''movie'') — the same floor Top Rated uses — ordered by that score then by how many people ranked them, topped up from media_items.popularity when the platform has too few supported titles. Rows the caller has already ranked are excluded, because the surface is a picker that must reach five distinct rankings. min_ratings is the threshold actually applied and source says which rule admitted each row.';
