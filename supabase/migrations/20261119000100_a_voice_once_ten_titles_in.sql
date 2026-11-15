-- A voice once ten titles in: community-score contributor eligibility, and a whole show
-- counted once per person (WS-COMM, founder spec t168u §4, 2026-11-13).
--
-- ---------------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------------
--
-- Founder decision (t168u §4): a user's rankings contribute to bingd community scores for
-- a category only once that user has at least ten completed rankings in that category.
-- Movies and TV are independent categories. Personal scores are never suppressed; the
-- rule is about the aggregate alone.
--
--   movies : count(rankings where category = 'movies')                    >= k
--   tv     : count(rankings where category in ('tv_seasons','tv_shows'))  >= k
--
-- with k = app_config `score.contributor_min_rankings` (10). `rankings` holds exactly one
-- current, completed ranking per (user, title) (primary key), so that count already
-- excludes the watchlist, unranked logs (`user_media`), rewatches (a rewatch never adds a
-- row), unfinished sessions (`ranking_sessions`) and removed rankings (a removal deletes
-- the row) -- §4A and §4B's exclusion lists, with no extra predicate.
--
-- It is **not** `score.community_min_ratings`. That row (1 since 20260910000100) is a
-- per-title display threshold and keeps exactly its meaning (§4E): a title prints a number
-- once it has that many *eligible* contributors. The two rows are independent.
--
-- And a whole show's community score stops being "explicit show rankings only"
-- (20261114000400's header, now superseded by founder §4F). Each TV-eligible person
-- contributes at most one effective score for a show: their explicit show ranking if they
-- have one, otherwise the mean of their ranked seasons of it. Those per-person values are
-- then averaged with equal weight. Season rows are never averaged across the population
-- directly (that would weight people by how many seasons they ranked), and a season's own
-- community score still reads that season's rankings only (§4B).
--
-- ---------------------------------------------------------------------------
-- DESIGN
-- ---------------------------------------------------------------------------
--
-- Live, never stored. Eligibility is a count over `rankings` evaluated at read time, so a
-- 9 -> 10 crossing adds every earlier ranking in that category and a 10 -> 9 crossing
-- removes them, on the very next read, with nothing to backfill, refresh or forget (§4G).
--
-- Three internal helpers, revoked from every client role like `band_bounds_excluding`:
--
--   _contributor_min_rankings()            k, shape-tested like community_support_floor's
--                                          rows.
--   _effective_show_scores(show, users[])  the server half of the WS-COMM / WS-TVC
--                                          interface contract, set-based: for each user,
--                                          the explicit show score, else the unrounded
--                                          mean of their ranked seasons, else no row.
--   _effective_show_score(user, show)      the same rule for one user (a thin wrapper, so
--                                          there is one implementation of it).
--
-- Eligibility itself has no helper of its own. Every caller already needs each rater's
-- per-(user, category) bucket counts for the band arithmetic, so it reads eligibility off
-- the same grouped count: one index range per rater per category, never a per-row call.
-- (A per-row `_contributes_to_community(user, group)` predicate was the first draft and
-- measured 2.7x the base latency for a movie with a thousand raters, and 40x for a show;
-- see supabase/tests/perf/community-score-scale.mjs.)
--
-- Five client-reachable functions change body only; signatures and grants are untouched,
-- so every installed client keeps working:
--
--   community_score         raters restricted to eligible ones; a series aggregates
--                           effective show scores, one per person.
--   top_rated_titles,       the same eligibility on their rater population, computed once
--   starter_movies          per call from the per-(user, category) counts CTE they already
--                           build, so they still agree with community_score title by title.
--   community_support_floor the p90 over eligible contributors' per-title counts, so a
--                           title's eligible-only count is compared with an eligible-only
--                           percentile.
--
-- `group_picks` reads `community_score` through a lateral join and follows without edit.
-- Deliberately unchanged (§4I): following_score, following_ratings, public_scores,
-- taste_match, people_taste_matches, every personal-score path, onboarding (still five
-- rankings), Feed payloads.
--
-- Every function below is copied from its live definition and differs from it only where
-- a `-- 20261119000100:` comment says so:
--   community_score          20260816000100
--   community_support_floor  20260927000100
--   top_rated_titles         20260916000200
--   starter_movies           20260916000200
--
-- No N+1. The single-title path reads a bounded rater set (one title's raters, or one
-- show's raters plus its seasons' raters through `media_items_season`), counts each
-- rater's rankings once with an index range on `rankings_lookup (user_id, category,
-- position)`, and derives eligibility and band sizes from that one count.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. The config row
-- ===========================================================================

insert into app_config (key, value) values
  ('score.contributor_min_rankings', '10'::jsonb)
on conflict (key) do nothing;

-- ===========================================================================
-- 2. Internal helpers
-- ===========================================================================

create or replace function _contributor_min_rankings()
returns integer
language sql
stable
set search_path = public
as $$
  -- A scalar subquery over a missing row is null, so the coalesce applies the default
  -- (config-defaults.test.mjs polices that shape). Shape-tested before the cast, as in
  -- community_support_floor: anything that is not a JSON number is treated as absent,
  -- and the value is floored to a whole count and held in [1, 1000000] before the
  -- integer cast, so neither 2.5 nor 1e12 nor a string can raise on a read path.
  select least(
           greatest(
             floor(coalesce(
               (select case when jsonb_typeof(value) = 'number' then (value)::numeric end
                  from app_config where key = 'score.contributor_min_rankings'),
               10
             )),
             1
           ),
           1000000
         )::integer;
$$;

comment on function _contributor_min_rankings() is
  'How many completed rankings a user needs in a category (movies, or TV = tv_seasons + tv_shows) before those rankings contribute to bingd community scores: app_config score.contributor_min_rankings, default 10, clamped to [1, 1000000]. Not score.community_min_ratings, which is the per-title display threshold. Internal.';

revoke execute on function _contributor_min_rankings() from public, anon, authenticated;

create or replace function _effective_show_scores(p_show uuid, p_users uuid[])
returns table (
  user_id      uuid,
  score        numeric,
  source       text,
  season_count integer,
  tv_rankings  integer
)
language sql
stable
set search_path = public
as $$
  -- The WS-COMM / WS-TVC interface contract, server side, for a set of users at once:
  --   1. an explicit tv_shows ranking of the show: its canonical score (score_for against
  --      the owner's tv_shows bands, 1 dp as everywhere), source 'explicit';
  --   2. else the arithmetic mean of the canonical scores of the owner's ranked seasons of
  --      the show, NOT rounded, source 'average';
  --   3. else no row.
  -- Each season counts once (the rankings primary key guarantees it). Unranked seasons,
  -- watch events and placement snapshots are never read. season_count is the number of
  -- ranked seasons in both cases (informational for an explicit score). tv_rankings is the
  -- user's total TV rankings (seasons + shows), their contributor-eligibility count, read
  -- off the same scan so community_score need not count a show's raters a second time.
  with targets as (
    select p_show as id, 'tv_shows'::ranking_category as category
    union all
    select s.id, 'tv_seasons'::ranking_category
      from media_items s
     where s.parent_id = p_show
       and s.kind = 'season'
  ),
  -- Each owner's whole TV pools, once, with the band sizes of every row's own pool
  -- attached by a window: exactly band_bounds' arithmetic without a call per row, and
  -- without a join between two derived sets the planner cannot size.
  pool as (
    select c.user_id,
           c.category,
           c.media_item_id,
           c.bucket,
           c.position,
           (count(*) filter (where c.bucket = 'loved')      over w)::integer as loved,
           (count(*) filter (where c.bucket = 'fine')       over w)::integer as fine,
           (count(*) filter (where c.bucket = 'not_for_me') over w)::integer as nfm,
           (count(*) over (partition by c.user_id))::integer                as total
      from rankings c
     where c.user_id = any (p_users)
       and c.category in ('tv_seasons', 'tv_shows')
    window w as (partition by c.user_id, c.category)
  ),
  scored as (
    select x.user_id,
           x.category,
           x.total,
           score_for(
             x.bucket,
             (x.position - (case x.bucket when 'loved' then 1
                                          when 'fine'  then x.loved + 1
                                          else              x.loved + x.fine + 1 end) + 1)::integer,
             (case x.bucket when 'loved' then x.loved
                            when 'fine'  then x.fine
                            else              x.nfm end)
           ) as s
      from pool x
      join targets t
        on t.id = x.media_item_id
       and t.category = x.category
  )
  select sc.user_id,
         coalesce(max(sc.s) filter (where sc.category = 'tv_shows'),
                  avg(sc.s) filter (where sc.category = 'tv_seasons')),
         case when bool_or(sc.category = 'tv_shows') then 'explicit' else 'average' end,
         (count(*) filter (where sc.category = 'tv_seasons'))::integer,
         max(sc.total)
    from scored sc
   group by sc.user_id;
$$;

comment on function _effective_show_scores(uuid, uuid[]) is
  'For each of a set of users, their effective score for one show: their explicit tv_shows ranking''s canonical score (source explicit), else the unrounded mean of their ranked seasons'' canonical scores (source average); users with neither get no row. season_count is the number of ranked seasons; tv_rankings is the user''s total TV rankings (the eligibility count). The server half of the WS-COMM/WS-TVC contract, read by community_score for a series. Internal.';

revoke execute on function _effective_show_scores(uuid, uuid[]) from public, anon, authenticated;

create or replace function _effective_show_score(p_user uuid, p_show uuid)
returns table (
  score        numeric,
  source       text,
  season_count integer
)
language sql
stable
set search_path = public
as $$
  select e.score, e.source, e.season_count
    from _effective_show_scores(p_show, array[p_user]) e;
$$;

comment on function _effective_show_score(uuid, uuid) is
  'One user''s effective score for one show (explicit, else the unrounded season mean, else no row): _effective_show_scores for a single user, so the rule has one implementation. Internal.';

revoke execute on function _effective_show_score(uuid, uuid) from public, anon, authenticated;

-- ===========================================================================
-- 3. community_score (live definition: 20260816000100)
-- ===========================================================================

create or replace function community_score(p_media_item_id uuid)
returns table (
  score        numeric,
  rating_count integer,
  min_ratings  integer
)
language sql stable security definer
set search_path = public
as $$
  with threshold as (
    select coalesce(
      (select (value)::integer from app_config where key = 'score.community_min_ratings'),
      3
    ) as k
  ),
  -- 20261119000100: the title's kind decides whose rankings are read and which
  -- categories a rater's eligibility is counted over (movies, or TV = seasons + shows).
  -- A missing title has no row here, reads no rankings and answers (null, 0, k), exactly
  -- as before.
  item as (
    select m.kind,
           case m.kind when 'movie' then array['movies']::ranking_category[]
                       else array['tv_seasons', 'tv_shows']::ranking_category[] end as cats
      from media_items m
     where m.id = p_media_item_id
  ),
  -- 20261119000100: the titles whose rankings make someone a rater of this one: the title
  -- itself, and for a whole show its seasons too (media_items_season finds them), since a
  -- person who ranked only seasons contributes their season average (§4F).
  targets as (
    select p_media_item_id as id from item
    union all
    select s.id
      from item
      join media_items s
        on s.parent_id = p_media_item_id
       and s.kind = 'season'
     where item.kind = 'series'
  ),
  -- 20261119000100: the population filter, unchanged in substance, applied once per
  -- distinct rater (a show's rater may have ranked several of its seasons).
  raters as (
    select p.id as user_id
      from (
        select distinct r.user_id
          from targets
          join rankings r on r.media_item_id = targets.id
      ) u
      join profiles p
        on p.id = u.user_id
       and p.visibility = 'public'
       and p.status = 'active'
       -- Null caller: nobody has blocked anybody, so the whole public population
       -- counts. blocked_between short-circuits on a null argument anyway; stated
       -- because the anon case is the one a reader will wonder about.
     where (auth.uid() is null or not blocked_between(p.id, auth.uid()))
  ),
  -- 20261119000100: the contributor threshold, read once (materialized, so it is not
  -- inlined into every group below).
  contributor as materialized (
    select _contributor_min_rankings() as k
  ),
  -- 20261119000100: each rater's rankings in this title's categories, read once (one
  -- index range per rater per category on rankings_lookup) and grouped per pool: the
  -- bucket sizes are band_bounds' arithmetic, and the rater's own ranking of this item,
  -- if any, rides along in the same group, so no derived set is ever joined to another.
  counts as (
    select c.user_id,
           c.category,
           count(*) filter (where c.bucket = 'loved')::integer      as loved,
           count(*) filter (where c.bucket = 'fine')::integer       as fine,
           count(*) filter (where c.bucket = 'not_for_me')::integer as nfm,
           min(c.bucket)   filter (where c.media_item_id = p_media_item_id) as item_bucket,
           min(c.position) filter (where c.media_item_id = p_media_item_id) as item_position
      from raters u
     cross join item
      join rankings c
        on c.user_id = u.user_id
       and c.category = any (item.cats)
     -- A whole show counts its raters inside _effective_show_scores instead (below).
     where item.kind in ('movie', 'season')
     group by c.user_id, c.category
  ),
  -- 20261119000100: only raters with score.contributor_min_rankings in the category
  -- (summed across a TV rater's two pools).
  eligible as (
    select x.*
      from (
        select counts.*,
               sum(counts.loved + counts.fine + counts.nfm)
                 over (partition by counts.user_id) as total
          from counts
      ) x
     cross join contributor km
     where x.total >= km.k
  ),
  -- Movies and seasons: each eligible rater's own ranking of exactly this item, scored
  -- against their own bands (a season is never derived from a show ranking, §4B).
  own_scores as (
    select score_for(
             e.item_bucket,
             (e.item_position - (case e.item_bucket when 'loved' then 1
                                                    when 'fine'  then e.loved + 1
                                                    else              e.loved + e.fine + 1 end) + 1)::integer,
             (case e.item_bucket when 'loved' then e.loved
                                 when 'fine'  then e.fine
                                 else              e.nfm end)
           ) as s
      from eligible e
     cross join item
     where e.item_position is not null
       and item.kind in ('movie', 'season')
  ),
  -- 20261119000100: a whole show. One effective score per rater who is TV-eligible
  -- (§4F); the helper reads each rater's TV pools once and returns both the effective
  -- score and the eligibility count, so a show's raters are never scanned twice.
  show_scores as (
    select x.score as s
      from item
     cross join contributor km
     cross join lateral _effective_show_scores(
             p_media_item_id,
             (select array_agg(raters.user_id) from raters)
           ) x
     where item.kind = 'series'
       and x.tv_rankings >= km.k
  ),
  rated as (
    -- 20261119000100: over the contributions above. Each value is one person, equal
    -- weight (§4E), and the count is the eligible contributors actually included.
    select
      round(avg(c.s), 1) as avg_score,
      count(*)::integer as n
      from (select s from own_scores union all select s from show_scores) c
  )
  select case when rated.n >= threshold.k then rated.avg_score end,
         rated.n,
         threshold.k
    from rated, threshold;
$$;

comment on function community_score(uuid) is
  'The mean canonical score for exactly one media item, over the public active accounts the caller could also read individually and that are eligible contributors (at least app_config score.contributor_min_rankings rankings in the title''s category: movies, or TV = seasons + shows, since 20261119000100), with the number of contributors included. A movie or season reads that item''s own rankings; a series reads one effective score per person (explicit show ranking, else the mean of their ranked seasons). Null score below app_config score.community_min_ratings. Excludes accounts blocked in either direction, because rankings_read already hides those rows and including them in the mean makes a blocked user''s rating recoverable by subtraction.';

grant execute on function community_score(uuid) to authenticated;

-- ===========================================================================
-- 4. community_support_floor (live definition: 20260927000100)
-- ===========================================================================

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
  -- 20261119000100: the contributor threshold and the categories it is counted over.
  v_min       integer;
  v_cats      ranking_category[];
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

  -- **The minimum is the medium's own** (20260927000100). Movies 3, TV seasons 2, each
  -- with its own row and its own written default; any other kind -- a series, which has no
  -- ranking -- keeps the old 3.
  v_floor_raw := (select case when jsonb_typeof(value) = 'number' then (value)::numeric end
                    from app_config where key = 'discovery.support_min_ratings.' || p_kind::text);
  v_floor := least(
    greatest(floor(coalesce(v_floor_raw, case p_kind when 'season' then 2 else 3 end)), 1),
    1000000
  )::integer;

  -- 20261119000100: the distribution is over eligible contributors only, so a title's
  -- eligible-only count is compared with an eligible-only percentile. Movies count movie
  -- rankings; seasons (and series, which no caller asks for) count TV rankings.
  v_min  := _contributor_min_rankings();
  v_cats := case p_kind
              when 'movie' then array['movies']::ranking_category[]
              else array['tv_seasons', 'tv_shows']::ranking_category[]
            end;

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
         -- 20261119000100: only raters with v_min rankings in this kind's group.
         and r.user_id in (
           select e.user_id
             from rankings e
            where e.category = any (v_cats)
            group by e.user_id
           having count(*) >= v_min
         )
       group by r.media_item_id
    ) rated;

  return greatest(coalesce(v_k, 0), v_floor);
end;
$$;

comment on function community_support_floor(media_kind) is
  'How many eligible ratings a title needs before a surface may rank it by its community score: max(percentile_disc(app_config discovery.support_percentile, default 0.9) of per-title rating count over titles of this kind with at least one rating from a public active eligible contributor (score.contributor_min_rankings rankings in the kind''s category, since 20261119000100), app_config discovery.support_min_ratings.<kind>, default 3 for a movie and 2 for a season since 20260927000100). Each medium is its own distribution and its own minimum. The distribution is the platform''s and ignores the caller''s blocks, so the cutoff is the same for every reader. Used by top_rated_titles and starter_movies so the two cannot drift. Internal.';

revoke execute on function community_support_floor(media_kind) from public, anon, authenticated;

-- ===========================================================================
-- 5. top_rated_titles (live definition: 20260916000200)
-- ===========================================================================

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
  -- 20261119000100: the contributor threshold, read once per call.
  v_min   integer;
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
  v_min := _contributor_min_rankings();

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
  -- 20261119000100: each rater's eligibility per group, from the counts already built.
  -- A group with no rows sums to null, and null >= k is not true: ineligible.
  eligible as (
    select c.user_id,
           coalesce(sum(c.loved + c.fine + c.nfm)
                      filter (where c.category = 'movies'), 0) >= v_min as movies,
           coalesce(sum(c.loved + c.fine + c.nfm)
                      filter (where c.category in ('tv_seasons', 'tv_shows')), 0) >= v_min as tv
      from counts c
     group by c.user_id
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
      -- 20261119000100: only eligible contributors for this wall's group.
      join eligible e
        on e.user_id = r.user_id
       and (case v_kind when 'movie'::media_kind then e.movies else e.tv end)
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
  'One page of the catalogue ordered by the community score community_score computes for a single title, over the same public active unblocked eligible-contributor population (score.contributor_min_rankings in the category, since 20261119000100), for movies or for TV seasons. Eligibility is community_support_floor(kind) — shared with starter_movies — and deliberately not the display threshold score.community_min_ratings. Supported titles are filtered first and the survivors sorted by (score desc, rating_count desc, id asc); keyset paginated on those three, and the cursor is all three values or none.';

-- ===========================================================================
-- 6. starter_movies (live definition: 20260916000200)
-- ===========================================================================

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
  -- 20261119000100: the contributor threshold, read once per call.
  v_min   integer;
begin
  if auth.uid() is null then
    raise exception 'starter_movies answers for a signed-in caller'
      using errcode = '42501';
  end if;

  v_k := community_support_floor('movie'::media_kind);
  v_min := _contributor_min_rankings();

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
  -- 20261119000100: movie-eligible raters, from the counts already built.
  eligible as (
    select c.user_id
      from counts c
     where c.category = 'movies'
       and c.loved + c.fine + c.nfm >= v_min
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
      -- 20261119000100: only movie-eligible contributors.
      join eligible e on e.user_id = r.user_id
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
  'The first-run picker''s supply of movies: community-scored titles (eligible contributors only, score.contributor_min_rankings movie rankings, since 20261119000100) whose ranking count clears community_support_floor(''movie'') — the same floor Top Rated uses — ordered by that score then by how many people ranked them, topped up from media_items.popularity when the platform has too few supported titles. Rows the caller has already ranked are excluded, because the surface is a picker that must reach five distinct rankings. min_ratings is the threshold actually applied and source says which rule admitted each row.';
