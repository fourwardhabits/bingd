-- A show ranked on its own (TV show & season ranking, WS1: category and foundations).
--
-- Product decision (founder brief, 2026-11-11): movies, whole TV shows and TV seasons are
-- three independent comparison pools. A reader may rank a show, its seasons, or both, in
-- any order. Shows compare with shows, seasons with seasons, movies with movies.
--
-- **Nothing is ever derived across the two TV levels.** No show score is computed from
-- its seasons, no season placement creates a show ranking, and neither level is moved
-- because the other changed. That holds structurally here: a show's ranking is a
-- `rankings` row with `category = 'tv_shows'` and `media_item_id` = the series, and every
-- write path (I1-I7, docs/architecture/ranking.md) already keys on (user, category).
-- Band sizes, scores, sessions, the placement ledger, Refine and the backlog are
-- per-category, so a show's bucket sizes can never contaminate a season's.
--
-- What changes, and nothing else:
--
--   1. `rankable_category('series')` is `tv_shows` (20261114000100 added the value).
--      Every ranking RPC resolves its category through this one function, so this is the
--      whole of "series are rankable" for rank_start, rank_again, rank_rebucket,
--      rank_backlog_start, refine_start and recommend_title. `_rank_start_impl`'s refusal
--      of a kind with no category stays, and is now unreachable for any catalogue kind.
--   2. `_assert_loggable` no longer refuses a series. Ranking writes the collection row
--      (I3), and the log, rewatch, bucket and date writers share this guard, so a show is
--      logged, rewatched and dated exactly as a film is.
--   3. A comparison must be between two titles of one category. The session engine only
--      ever offers a pivot from the subject's own band, so this is already true by
--      construction; the trigger makes a regression loud rather than silent.
--   4. `_viewer_has_seen` counts a logged show as seen (it already counted its seasons).
--   5. `profile_title_counts.tv` counts seasons, plus a show none of whose seasons is
--      ranked: Candidate A's collection precedence, applied to the profile's count so the
--      number matches the wall it sits beside. Rankings themselves are untouched.
--   6. The rankings award (`rating-rascal`) counts a ranked show. The season and genre
--      awards, watch goals and the monthly board stay on movies and seasons: a show-level
--      log next to its seasons' logs would otherwise count one series twice.
--
-- Old clients: no signature changes here. An installed build never asks to rank a series,
-- so it sees nothing new; a series it already shows still shows. Every function below is
-- copied from its live definition and changed only where a 20261114000200 comment says so.

-- ===========================================================================
-- 1. Category resolution: a series is a show, ranked in its own pool
-- ===========================================================================

create or replace function rankable_category(k media_kind)
 RETURNS ranking_category
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case k
    when 'movie'  then 'movies'::ranking_category
    when 'season' then 'tv_seasons'::ranking_category
    -- 20261114000200: a whole show is ranked in its own pool, never with its seasons.
    when 'series' then 'tv_shows'::ranking_category
    else null  -- nothing else is rankable
  end;
$function$;


-- ===========================================================================
-- 2. The explicit series refusal, removed
-- ===========================================================================

create or replace function _assert_loggable(p_media_item_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- 20261114000200: a whole show is loggable and rankable (category tv_shows), so every
  -- kind in the catalogue is. What remains is the existence check, which every caller
  -- relied on for its P0002.
  perform _media_kind(p_media_item_id);
end;
$function$;


-- ===========================================================================
-- 3. A comparison stays inside one category
--
-- `comparisons` has no category column: it is derived, like everything else here. A row
-- pairing a show with one of its seasons, or a season with a film, would be evidence
-- Refine (`_refine_support`) and any future recalibration read as a preference between
-- two titles that were never in one pool. Nothing writes one today; this keeps it so.
-- ===========================================================================

create or replace function _comparison_within_one_category()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if rankable_category((select kind from media_items where id = new.winner_id))
     is distinct from
     rankable_category((select kind from media_items where id = new.loser_id)) then
    raise exception 'a comparison is between two titles of one category'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke execute on function _comparison_within_one_category() from public, anon, authenticated;

drop trigger if exists comparisons_within_one_category on comparisons;
create trigger comparisons_within_one_category
  before insert or update of winner_id, loser_id on comparisons
  for each row execute function _comparison_within_one_category();

-- ===========================================================================
-- 4. Reads that ask whether somebody has seen a show
-- ===========================================================================

create or replace function _viewer_has_seen(p_viewer uuid, p_media_item_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case
    when p_viewer is null then false
    else coalesce((
      select case m.kind
        when 'movie' then exists (
          select 1 from user_media um
           where um.user_id = p_viewer and um.media_item_id = m.id
        )
        when 'season' then exists (
          select 1 from user_media um
           where um.user_id = p_viewer
             and um.media_item_id = m.id
             and um.progress is distinct from 'watching'
        )
        -- 20261114000200: the show itself, logged or ranked, is seeing it too.
        when 'series' then exists (
          select 1 from user_media um
           where um.user_id = p_viewer and um.media_item_id = m.id
        ) or exists (
          select 1
            from media_items s
            join user_media um
              on um.media_item_id = s.id and um.user_id = p_viewer
           where s.parent_id = m.id
             and um.progress is distinct from 'watching'
        )
        else false
      end
      from media_items m where m.id = p_media_item_id
    ), false)
  end;
$function$;


create or replace function profile_title_counts(p_user uuid)
 RETURNS TABLE(movies integer, tv integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with titles as (
    select um.media_item_id
      from user_media um
     where um.user_id = p_user
       and um.progress is distinct from 'watching'
    union
    select r.media_item_id from rankings r where r.user_id = p_user
  )
  select (count(*) filter (where mi.kind = 'movie'))::integer,
         -- 20261114000200: seasons, plus a show that stands for itself because none of
         -- its seasons is ranked. That is Candidate A's precedence, the same rule the
         -- Collection's TV grid draws by, so the count matches the wall it summarises.
         (count(*) filter (
            where mi.kind = 'season'
               or (mi.kind = 'series'
                   and not exists (select 1 from rankings r2
                                     join media_items s on s.id = r2.media_item_id
                                    where r2.user_id = p_user
                                      and s.parent_id = mi.id
                                      and s.kind = 'season'))
          ))::integer
    from titles t
    join media_items mi on mi.id = t.media_item_id
   where can_i_view(p_user);
$function$;


-- ===========================================================================
-- 5. The rankings award counts a ranked show
-- ===========================================================================

create or replace function _award_metric(p_user uuid, p_award text, p_threshold integer)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v bigint;
begin
  case p_award
    when 'movie-muncher' then
      select count(*) into v
        from user_media um join media_items m on m.id = um.media_item_id
       where um.user_id = p_user and m.kind = 'movie';

    when 'season-snacker' then
      select count(*) into v
        from user_media um join media_items m on m.id = um.media_item_id
       where um.user_id = p_user and m.kind = 'season';

    when 'invite-instigator' then
      -- The predicate 20260827001100 declared canonical: attributed AND activated.
      select count(*) into v
        from invite_attributions ia
       where ia.inviter_id = p_user and ia.activated_at is not null;

    when 'queue-dragon' then
      select count(*) into v
        from watchlist w join media_items m on m.id = w.media_item_id
       where w.user_id = p_user and m.kind in ('movie', 'season');

    when 'rating-rascal' then
      select count(*) into v
        from rankings r join media_items m on m.id = r.media_item_id
       -- 20261114000200: a ranked show is a ranking, so it counts toward the rankings award.
       where r.user_id = p_user and m.kind in ('movie', 'season', 'series');

    when 'comment-gremlin' then
      -- Comments authored, and ONLY comments (founder split, 20260901000100).
      -- The public-note term that used to be added here is gone: a review is a
      -- different behaviour from a comment and no longer moves this track.
      -- Tombstones are still counted -- a retraction does not un-say that the
      -- person wrote. Owner truth: no viewer-relative comments_read filtering,
      -- for the reason 20260828000100's header gives.
      select count(*) into v from comments c where c.author_id = p_user;

    when 'hype-courier' then
      select count(*) into v
        from title_recommendations tr
       where tr.sender_id = p_user;

    when 'scream-snack' then
      v := _award_genre_count(p_user, array['Horror']);
    when 'lol-mode' then
      v := _award_genre_count(p_user, array['Comedy']);
    when 'softie-hours' then
      v := _award_genre_count(p_user, array['Drama', 'Romance']);
    when 'space-brain' then
      v := _award_genre_count(p_user, array['Science Fiction']);
    when 'boom-club' then
      v := _award_genre_count(p_user, array['Action']);
    when 'toon-bloom' then
      v := _award_genre_count(p_user, array['Animation']);
    when 'truth-worm' then
      v := _award_genre_count(p_user, array['Documentary']);

    when 'passport-mode' then
      -- effectiveLanguage: own trimmed non-empty, else the parent's for a season.
      select count(*) into v
        from user_media um
        join media_items m on m.id = um.media_item_id
        left join media_items par on par.id = m.parent_id
       where um.user_id = p_user
         and m.kind in ('movie', 'season')
         and coalesce(
               nullif(btrim(coalesce(m.original_language, '')), ''),
               case when m.kind = 'season'
                    then nullif(btrim(coalesce(par.original_language, '')), '') end
             ) not in ('en');

    when 'time-hopper' then
      -- Number(release_date.slice(0,4)) < 2000, with the same silence for a
      -- missing or malformed date the JS NaN gives.
      select count(*) into v
        from user_media um join media_items m on m.id = um.media_item_id
       where um.user_id = p_user
         and m.kind in ('movie', 'season')
         and m.release_date is not null
         and left(m.release_date::text, 4) ~ '^[0-9]{4}$'
         and left(m.release_date::text, 4)::integer < 2000;

    when 'genre-gremlin' then
      -- COUNT DISTINCT canonical genres present anywhere in the collection.
      select count(distinct ap.canonical) into v
        from user_media um
        join media_items m on m.id = um.media_item_id
        left join media_items par on par.id = m.parent_id
        cross join lateral unnest(
          _award_effective_genres(m.kind::text, m.genres, par.genres)
        ) as label
        join award_genre_patterns ap on lower(label) ~ ap.pattern
       where um.user_id = p_user
         and m.kind in ('movie', 'season');

    when 'two-screen-life' then
      -- The one tier-dependent metric: each side capped at threshold / 2
      -- (thresholds are even by construction; awards.test.ts pins cap = t/2).
      select least(count(*) filter (where m.kind = 'movie'),  p_threshold / 2)
           + least(count(*) filter (where m.kind = 'season'), p_threshold / 2)
        into v
        from user_media um join media_items m on m.id = um.media_item_id
       where um.user_id = p_user and m.kind in ('movie', 'season');

    when 'heart-magnet' then
      -- Reactions on the user's own feed events, excluding their own — the
      -- client's neq(user_id) written where the database can see it.
      select count(*) into v
        from reactions r
        join feed_events fe on fe.id = r.feed_event_id
       where fe.actor_id = p_user and r.user_id <> p_user;

    when 'mutual-mania' then
      -- Approved in both directions, with a profile that still exists. Existence,
      -- not can_i_view — the ledger has no viewer. Self is impossible
      -- (no_self_follow), stated anyway.
      select count(*) into v
        from follows a
        join follows b on b.follower_id = a.followee_id
                      and b.followee_id = a.follower_id
        join profiles p on p.id = a.followee_id
       where a.follower_id = p_user
         and a.followee_id <> p_user
         and a.state = 'approved'
         and b.state = 'approved';

    else
      raise exception 'unknown award %', p_award using errcode = '22023';
  end case;

  return coalesce(v, 0);
end;
$function$;
