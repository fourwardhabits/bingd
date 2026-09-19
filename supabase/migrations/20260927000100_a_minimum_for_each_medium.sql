-- A minimum for each medium.
--
-- ---------------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------------
--
-- Top Rated TV showed one title. Nothing was broken: `community_support_floor(kind)`
-- (20260916000200) already takes its 90th percentile over each medium's own
-- distribution. What the two media shared was the hard minimum under it,
-- `discovery.support_min_ratings` = 3 -- and TV's percentile is 2, so for TV the shared
-- minimum was the whole bar. The read-only production aggregate in 20260916000200's
-- header shows the shape: 114 rated seasons, p90 2, max 3, one season at three raters.
--
-- TV is thin by construction rather than by accident. The season is the ranking unit, so
-- a show's opinions are split across its seasons, and the same absolute bar is stricter
-- for a season than for a film.
--
-- ---------------------------------------------------------------------------
-- THE RULE (founder decision, 2026-09-19)
-- ---------------------------------------------------------------------------
--
--   floor(movie)  = max( p90 of per-title rating count over rated movies,  3 )
--   floor(season) = max( p90 of per-title rating count over rated seasons, 2 )
--
-- Unchanged: the percentile (`discovery.support_percentile`, 0.9), the two independent
-- distributions, the community score as the only order once a title is eligible, rater
-- count as eligibility only, and the season as TV's unit. Two is the lowest bar that is
-- still not one person's opinion: a title with a single rater stays off both walls.
--
-- Deliberately not done: lowering the bar until some number of titles qualify. That makes
-- a title's eligibility depend on how many *other* titles cleared it.
--
-- ---------------------------------------------------------------------------
-- WHAT MOVES
-- ---------------------------------------------------------------------------
--
-- Movies: nothing. The movie minimum is still 3, so Top Rated Movies and `starter_movies`
-- (which asks for movies only) return exactly what they did.
-- TV: seasons with two eligible raters join the wall whenever TV's p90 is at or below 2.
--
-- ---------------------------------------------------------------------------
-- DESIGN
-- ---------------------------------------------------------------------------
--
-- One row per medium, keyed `discovery.support_min_ratings.<media_kind>`, read by the one
-- function both surfaces already call -- so the rule still cannot drift between them. The
-- shared row is deleted rather than left behind: a tuning row that nothing reads is a knob
-- somebody will turn and watch do nothing (20260916000200's own reason). Each row keeps
-- the shape test and the clamps, and each medium has its own written default, so a missing
-- or malformed row costs that medium its documented minimum and never raises.
--
-- `community_support_floor` is rebuilt in full from its only definition, 20260916000200,
-- and differs from it only in where the minimum is read and what its default is.
-- `top_rated_titles` and `starter_movies` are unchanged.
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values
  ('discovery.support_min_ratings.movie',  '3'::jsonb),
  ('discovery.support_min_ratings.season', '2'::jsonb)
on conflict (key) do nothing;

delete from app_config where key = 'discovery.support_min_ratings';

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

  -- **The minimum is the medium's own** (20260927000100). Movies 3, TV seasons 2, each
  -- with its own row and its own written default; any other kind -- a series, which has no
  -- ranking -- keeps the old 3.
  v_floor_raw := (select case when jsonb_typeof(value) = 'number' then (value)::numeric end
                    from app_config where key = 'discovery.support_min_ratings.' || p_kind::text);
  v_floor := least(
    greatest(floor(coalesce(v_floor_raw, case p_kind when 'season' then 2 else 3 end)), 1),
    1000000
  )::integer;

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
  'How many eligible ratings a title needs before a surface may rank it by its community score: max(percentile_disc(app_config discovery.support_percentile, default 0.9) of per-title rating count over titles of this kind with at least one rating from a public active account, app_config discovery.support_min_ratings.<kind>, default 3 for a movie and 2 for a season since 20260927000100). Each medium is its own distribution and its own minimum. The distribution is the platform''s and ignores the caller''s blocks, so the cutoff is the same for every reader. Used by top_rated_titles and starter_movies so the two cannot drift. Internal.';

revoke execute on function community_support_floor(media_kind) from public, anon, authenticated;
