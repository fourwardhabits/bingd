-- A show counted once (TV show & season ranking, WS5: Taste Match and group picks).
--
-- Depends on 20261114000200 (a show is rankable, category tv_shows).
--
-- Show and season rankings are distinct signals (founder brief §7). Both inform taste
-- and correlation; neither is inferred from the other; and a series must not outweigh
-- everything else because many of its seasons are ranked. Observations are kept, and
-- their collective influence is bounded:
--
--   1. taste_match. Matching was already exact and stays so: the two rankings are joined
--      on the same media item, so a show is compared with the same show and a season with
--      the same season. What changes is the evidence count. Each shared series (a show
--      and any of its seasons) is one unit: the threshold (taste.min_common) and the
--      confidence shrink read the number of units, and the mean gap and the rank
--      correlation weight each observation by 1/(observations in its unit). With no
--      series shared more than once every weight is 1 and the result is identical to the
--      formula before (weighted Pearson over midranks is `corr` at unit weights).
--   2. people_taste_matches counts shared series rather than shared rows for its overlap.
--   3. group_picks orders a member's loved anchors by their place inside their own
--      ranking pool (0 best to 1), never by a raw ordinal compared across pools, and
--      counts genre evidence once per series.
--
-- community_score, following_score, following_ratings and public_scores need no change:
-- they read the rankings of one media item, so a show's numbers come from explicit show
-- rankings only and a season's from that season, scored against each owner's own bands.
-- top_rated_titles keeps 'tv' as seasons: the Top Rated wall is unchanged here.
--
-- No signature or grant changes. Every function below is copied from its live definition
-- and changed only where a 20261114000400 comment says so.

-- ===========================================================================
-- 1. Taste Match
-- ===========================================================================

create or replace function taste_match(p_user_id uuid)
 RETURNS TABLE(score integer, common_count integer, min_common integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with threshold as (
    select
      coalesce(
        (select (value)::integer from app_config where key = 'taste.min_common'),
        5
      ) as k,
      coalesce(
        (select (value)::integer from app_config where key = 'taste.shrink_prior'),
        5
      ) as p
  ),
  authorised as (
    select p_user_id as subject
     where auth.uid() is not null
       and p_user_id is not null
       -- Never against yourself. A 100% match with your own catalogue is a tautology,
       -- and the founder asked for it to be absent rather than perfect. Refused here
       -- as well as hidden by the client, so a modified client learns nothing either.
       and p_user_id <> auth.uid()
       -- AD-5 from the caller's own side: suspension, blocks in either direction, and
       -- a private account that has not approved this follower.
       and can_view_profile(auth.uid(), p_user_id)
  ),
  -- Both sides' canonical current scores for exactly the items both have ranked.
  common as (
    select
      round(score_for(mine.bucket, (mine.position - mb.lo + 1)::integer, mb.size), 1) as a,
      round(score_for(theirs.bucket, (theirs.position - tb.lo + 1)::integer, tb.size), 1) as b,
      -- 20261114000400: the series a TV title belongs to (a season's show, a show itself), else
      -- the title. Matching stays exact: the join below is on the same media item, so a
      -- show is compared with the same show and a season with the same season.
      coalesce(mi.parent_id, mi.id) as unit
      from authorised
      join rankings mine   on mine.user_id = auth.uid()
      join rankings theirs on theirs.user_id = authorised.subject
                          and theirs.media_item_id = mine.media_item_id
      join media_items mi on mi.id = mine.media_item_id
      join lateral band_bounds(mine.user_id, mine.category, mine.bucket)      mb on true
      join lateral band_bounds(theirs.user_id, theirs.category, theirs.bucket) tb on true
  ),
  -- Midranks, so ties do not read as disagreement. `rank()` gives the first position
  -- of a tied group; adding half the group's excess turns it into the average rank,
  -- which is what Spearman is defined over.
  --
  -- 20261114000400: **one series is one unit of evidence.** Every shared observation is kept,
  -- and the ones from one series share one unit of weight between them, so ten shared
  -- seasons of a show count as much as one shared film and no more. The count below is
  -- of units, which is what the threshold and the confidence shrink read. With no series
  -- shared more than once every weight is 1 and this is exactly the formula it replaces.
  ranked as (
    select
      a, b,
      1.0 / count(*) over (partition by unit) as w,
      rank() over (order by a) + (count(*) over (partition by a) - 1) / 2.0 as ra,
      rank() over (order by b) + (count(*) over (partition by b) - 1) / 2.0 as rb
      from common
  ),
  moments as (
    select sum(w * ra) / nullif(sum(w), 0) as mx,
           sum(w * rb) / nullif(sum(w), 0) as my
      from ranked
  ),
  stats as (
    select
      (select count(distinct unit) from common)::integer as n,
      sum(r.w * abs(r.a - r.b)) / nullif(sum(r.w), 0)    as mean_gap,
      -- The weighted Pearson correlation of the midranks, which is `corr(ra, rb)` when
      -- every weight is 1. Null when either side has no spread, as `corr` was.
      case
        when sum(r.w * (r.ra - m.mx) ^ 2) > 0 and sum(r.w * (r.rb - m.my) ^ 2) > 0 then
          sum(r.w * (r.ra - m.mx) * (r.rb - m.my))
            / sqrt(sum(r.w * (r.ra - m.mx) ^ 2) * sum(r.w * (r.rb - m.my) ^ 2))
      end                                                 as rho
      from ranked r, moments m
  ),
  parts as (
    select
      stats.n,
      threshold.k,
      threshold.p,
      -- Proximity. Seven is the measured gap between opposite opinions; the clamp is
      -- a guard, not part of the arithmetic (see 20260817000400 for the five-denominator
      -- bug that distinction comes from).
      greatest(0, least(100, 100 * (1 - coalesce(stats.mean_gap, 7) / 7))) as proximity,
      -- Null rho contributes nothing rather than zero. It arises when one side's
      -- common scores are all equal, which is an absence of information and not a
      -- statement of disagreement.
      case when stats.rho is null then null else 50 * (stats.rho + 1) end as agreement,
      -- Zero below eight shared titles, a quarter at twenty, linear between.
      0.25 * greatest(0, least(1, (stats.n - 8) / 12.0))                  as w
      from stats, threshold
  )
  select
    case
      when parts.n >= parts.k then
        round(
          -- The blend, then the shrink. `::numeric` on n because integer division
          -- would round the confidence to zero for every real pair.
          50 + (
            case
              when parts.agreement is null then parts.proximity
              else (1 - parts.w) * parts.proximity + parts.w * parts.agreement
            end - 50
          ) * (parts.n::numeric / (parts.n + parts.p))
        )::integer
    end,
    parts.n,
    parts.k
    from parts;
$function$;


create or replace function people_taste_matches(p_limit integer DEFAULT 10)
 RETURNS TABLE(user_id uuid, username text, display_name text, avatar_path text, visibility profile_visibility, match_score integer, shared_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with me as (select auth.uid() as id),
  threshold as (
    select coalesce(
      (select (value)::integer from app_config where key = 'taste.min_common'),
      5
    ) as k
  ),
  mine as (
    select r.media_item_id from rankings r, me where r.user_id = me.id
  ),
  overlap as (
    -- 20261114000400: shared series, not shared rows, so a show's many seasons count once.
    select r.user_id as subject, count(distinct coalesce(mi.parent_id, mi.id)) as shared
      from rankings r
      join mine on mine.media_item_id = r.media_item_id
      join media_items mi on mi.id = r.media_item_id
      cross join me
     where r.user_id <> me.id
     group by r.user_id
  ),
  candidates as (
    select o.subject, o.shared
      from overlap o
      join profiles cp on cp.id = o.subject
      cross join me
      cross join threshold t
     where o.shared >= t.k
       -- 20260912000100, founder §A5. Match is algorithmic discovery by strangers, and a
       -- private account must not be recommended to one however well its taste
       -- correlates. Stated rather than left to emerge from the two predicates below.
       and cp.visibility = 'public'
       -- Readable, because a score over rankings the caller may not select would be an
       -- aggregate leak. `taste_match` enforces this too; stated here as well so the
       -- expensive call is not made for a row that can only come back empty.
       and can_view_profile(me.id, o.subject)
       and can_discover_profile(me.id, o.subject)
       and not exists (
         select 1 from follows own
          where own.follower_id = me.id and own.followee_id = o.subject
       )
     order by o.shared desc, o.subject
     -- Bounded before the arithmetic. Thirty pairwise matches is the most this screen
     -- will ever ask for, and the ten it shows come from the most-overlapping thirty.
     limit 30
  )
  select c.subject, p.username::text, p.display_name, p.avatar_path, p.visibility,
         tm.score, tm.common_count
    from candidates c
    join profiles p on p.id = c.subject
    join lateral taste_match(c.subject) tm on true
   -- The one canonical gate: no score, no row. Below taste.min_common shared titles
   -- `taste_match` returns null and this screen says nothing rather than guessing.
   where tm.score is not null
   order by tm.score desc, c.shared desc, p.username, c.subject
   limit least(greatest(coalesce(p_limit, 10), 0), 30);
$function$;


-- ===========================================================================
-- 2. Group picks
-- ===========================================================================

create or replace function group_picks(p_member_ids uuid[], p_medium text, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_kind      media_kind;
  v_requested uuid[];
  v_members   uuid[];
  v_n         integer;
  v_limit     integer := least(greatest(coalesce(p_limit, 200), 1), 400);
  v_result    jsonb;
begin
  if auth.uid() is null then
    raise exception 'group_picks requires a signed-in caller'
      using errcode = '42501';
  end if;

  if p_medium is null or p_medium not in ('movies', 'tv') then
    raise exception 'group_picks answers for movies or tv'
      using errcode = '22023';
  end if;
  v_kind := case p_medium when 'movies' then 'movie'::media_kind
                          else 'series'::media_kind end;

  -- The caller is always a member and never counted from the argument: duplicates
  -- collapse, nulls drop, and the caller's own id arriving in the array is the
  -- same call as it not arriving.
  select coalesce(array_agg(distinct ids.id), '{}'::uuid[]) into v_requested
    from unnest(coalesce(p_member_ids, '{}'::uuid[])) as ids(id)
   where ids.id is not null and ids.id <> auth.uid();

  -- Six people, caller included. A product cap rather than a capacity claim, but
  -- enforced here so the shape of a call is bounded whatever the client does.
  if coalesce(array_length(v_requested, 1), 0) > 5 then
    raise exception 'a group holds at most six people, counting you'
      using errcode = '22023';
  end if;

  -- Membership, re-decided now: an approved outbound follow the caller may still
  -- view. Anything else -- a stranger's id, a pending follow, a block in either
  -- direction, a suspension, a private account that never approved -- contributes
  -- nothing and is not in the denominator.
  select array_agg(who) into v_members from (
    select auth.uid() as who
    union
    select f.followee_id
      from follows f
     where f.follower_id = auth.uid()
       and f.state = 'approved'
       and f.followee_id = any (v_requested)
       and can_i_view(f.followee_id)
  ) member_set;
  v_n := coalesce(array_length(v_members, 1), 1);

  with members as (
    select unnest(v_members) as who
  ),

  -- ------------------------------------------------- the one expensive read
  -- Under invoker, every rankings row read here pays a per-row `can_i_view`
  -- policy call, and that call is the whole cost of this function: measured on
  -- real PostgreSQL 17, one pass over six members' 720 rows is ~0.7s and the
  -- table itself is ~2ms. So the members' rankings are read EXACTLY ONCE,
  -- materialized, and the anchors, the watch evidence and the taste vector are
  -- all derived from this row set -- the same three reads this replaced, minus
  -- two of the three policy sweeps. Rollup to the parent happens here so no
  -- consumer re-joins media_items per ranking row; the medium filter does not,
  -- because taste deliberately spans both media while anchors and watch
  -- evidence are medium-bound.
  member_rankings as materialized (
    select r.user_id as who,
           r.bucket,
           r.position,
           -- 20261114000400: the place inside the ranking's own pool, 0 (best) to 1. A show's
           -- ordinal and a season's are two different lists, so anchors are ordered by
           -- this rather than by a raw position compared across pools.
           (r.position - 1)::numeric
             / greatest(count(*) over (partition by r.user_id, r.category), 1) as place,
           t.id as rolled_id,
           t.kind as rolled_kind,
           t.genres as rolled_genres
      from rankings r
      join members on members.who = r.user_id
      join media_items raw on raw.id = r.media_item_id
      join media_items t on t.id = coalesce(raw.parent_id, raw.id)
  ),

  -- ------------------------------------------------------------------ saved
  -- Season watchlist rows count for their series; a movie is its own rollup.
  -- Under invoker RLS this reads exactly the watchlists the caller may see.
  member_saves as (
    select w.user_id as who, t.id as media_item_id
      from watchlist w
      join members on members.who = w.user_id
      join media_items raw on raw.id = w.media_item_id
      join media_items t on t.id = coalesce(raw.parent_id, raw.id)
                        and t.kind = v_kind
     group by w.user_id, t.id
  ),
  saves as (
    select media_item_id, count(distinct who)::integer as saved_count
      from member_saves
     group by media_item_id
  ),

  -- ---------------------------------------------------------------- anchors
  -- Each member's loved rankings, rolled up to the medium's unit, best position
  -- first. The strongest six are anchors (the client's ANCHOR_LIMIT); the
  -- strongest thirty are the loved/rewatch family. Anchor titles never leave
  -- this function.
  anchor_pool as (
    select who, media_item_id, row_number() over (
             partition by who order by best_position, media_item_id
           ) as strength
      from (
        select who, rolled_id as media_item_id, min(place) as best_position
          from member_rankings
         where bucket = 'loved' and rolled_kind = v_kind
         group by who, rolled_id
      ) rolled
  ),

  -- --------------------------------------------------------------- similar
  -- The payload is service-role-written, and hardened anyway: a facet whose `ids`
  -- is not an array expands to nothing rather than raising, and an entry that is
  -- not a canonical dashed uuid is skipped rather than failing the cast. One bad
  -- adapter write must cost one candidate list, never the whole answer.
  similar_hits as (
    select a.who, (ids.value)::uuid as media_item_id
      from anchor_pool a
      join media_cache mc on mc.media_item_id = a.media_item_id
                         and mc.facet = 'similar'
                         and mc.expires_at > now()
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(mc.payload->'ids') = 'array'
             then mc.payload->'ids' else '[]'::jsonb end
      ) as ids(value)
     where a.strength <= 6
       and ids.value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ),
  similar_by_member as (
    select who, media_item_id, count(*)::integer as hits
      from similar_hits
     group by who, media_item_id
  ),

  -- ----------------------------------------------------------------- loved
  loved_titles as (
    select distinct media_item_id from anchor_pool where strength <= 30
  ),

  -- -------------------------------------------------------------- trending
  -- Expiry is deliberately not checked, matching the client's trendingFallback:
  -- nothing schedules the refresh yet, and respecting the expiry today would
  -- empty the fallback rather than freshen it (recommendations.md §9, TREND-1).
  trending as (
    select (ids.value)::uuid as media_item_id
      from provider_list_cache plc
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(plc.payload->'ids') = 'array'
             then plc.payload->'ids' else '[]'::jsonb end
      ) as ids(value)
     where plc.list_key = case when v_kind = 'movie'
                               then 'trending.movie.week'
                               else 'trending.series.week' end
       and ids.value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ),

  -- ------------------------------------------------------------ candidates
  candidates as (
    select media_item_id from saves
    union
    select media_item_id from similar_by_member
    union
    select media_item_id from loved_titles
    union
    select media_item_id from trending
  ),
  typed as (
    select c.media_item_id, m.popularity
      from candidates c
      join media_items m on m.id = c.media_item_id and m.kind = v_kind
  ),
  group_reached as (
    select media_item_id from saves
    union
    select media_item_id from similar_by_member
    union
    select media_item_id from loved_titles
  ),

  -- --------------------------------------------------------- watch evidence
  -- Rankings are the cross-member evidence RLS exposes; the caller's own logs
  -- fill in their half (§3 records the asymmetry). Opinion: loved 2, fine 1,
  -- not_for_me 0, unbucketed log 1 -- and min() takes the worst known one,
  -- across a member's seasons of a series too.
  watch_evidence as (
    select who, rolled_id as media_item_id,
           min(case bucket when 'loved' then 2 when 'fine' then 1 else 0 end) as opinion
      from member_rankings
     where rolled_kind = v_kind
     group by who, rolled_id
  ),
  own_logged as (
    select um.user_id as who, t.id as media_item_id,
           min(case um.bucket when 'loved' then 2
                              when 'fine' then 1
                              when 'not_for_me' then 0
                              else 1 end) as opinion
      from user_media um
      join media_items raw on raw.id = um.media_item_id
      join media_items t on t.id = coalesce(raw.parent_id, raw.id)
                        and t.kind = v_kind
     where um.user_id = auth.uid()
     group by um.user_id, t.id
  ),
  watchers as (
    select who, media_item_id, min(opinion) as opinion
      from (select * from watch_evidence union all select * from own_logged) w
     group by who, media_item_id
  ),
  watch_stats as (
    select media_item_id,
           count(distinct who)::integer as watched_count,
           min(opinion) as worst_opinion
      from watchers
     group by media_item_id
  ),

  -- ------------------------------------------------------------ member fit
  -- Genre affinity spans both media, like the client's taste vector: someone who
  -- loves Japanese cinema means it about television too. Raw provider genres on
  -- both sides of the comparison, so the two sides cannot disagree.
  member_taste as (
    select who, g.genre,
           -- 20261114000400: once per series, however many of its seasons (and its own
           -- show ranking) sit in the band, so one long show cannot outvote the rest.
           count(distinct rolled_id) filter (where bucket = 'loved') as loved_n,
           count(distinct rolled_id) filter (where bucket = 'not_for_me') as disliked_n
      from member_rankings
      cross join lateral unnest(rolled_genres) as g(genre)
     group by who, g.genre
  ),
  member_taste_totals as (
    select who,
           sum(loved_n)::numeric as loved_total,
           sum(disliked_n)::numeric as disliked_total
      from member_taste
     group by who
  ),
  candidate_genres as (
    select ty.media_item_id, g.genre
      from typed ty
      join media_items m on m.id = ty.media_item_id
      cross join lateral unnest(m.genres) as g(genre)
  ),
  genre_affinity as (
    select mt.who, cg.media_item_id,
           sum(case when tt.loved_total > 0 then mt.loved_n / tt.loved_total else 0 end)
             as loved_share,
           sum(case when tt.disliked_total > 0 then mt.disliked_n / tt.disliked_total else 0 end)
             as disliked_share
      from candidate_genres cg
      join member_taste mt on mt.genre = cg.genre
      join member_taste_totals tt on tt.who = mt.who
     group by mt.who, cg.media_item_id
  ),
  fits as (
    select mem.who, ty.media_item_id,
           case when ms.who is not null then greatest(x.fit, 0.85) else x.fit end as fit
      from members mem
      cross join typed ty
      left join similar_by_member sbm
             on sbm.who = mem.who and sbm.media_item_id = ty.media_item_id
      left join genre_affinity ga
             on ga.who = mem.who and ga.media_item_id = ty.media_item_id
      left join member_saves ms
             on ms.who = mem.who and ms.media_item_id = ty.media_item_id
      cross join lateral (
        select greatest(0.0, least(1.0,
                 0.35
                 + 0.40 * (1 - 1.0 / (1 + coalesce(sbm.hits, 0)))
                 + 0.35 * least(1.0, coalesce(ga.loved_share, 0))
                 - 0.50 * least(1.0, coalesce(ga.disliked_share, 0))
               )) as fit
      ) x
  ),
  grouped as (
    select media_item_id, avg(fit) as avg_fit, min(fit) as min_fit
      from fits
     group by media_item_id
  ),

  -- ----------------------------------------------------------------- score
  scored as (
    select ty.media_item_id,
           ty.popularity,
           coalesce(sv.saved_count, 0) as saved_count,
           coalesce(ws.watched_count, 0) as watched_count,
           (coalesce(ws.watched_count, 0) > 0) as rewatch,
           case
             when coalesce(sv.saved_count, 0) > 0 then 'saved'
             when coalesce(ws.watched_count, 0) > 0 then 'rewatch'
             when gr.media_item_id is not null then 'group'
             else 'trending'
           end as source,
           round(
             least(
               -- A candidate reached by trending alone cannot outrank the group.
               case when gr.media_item_id is null then 0.15 else 1.0 end,
               (  0.45 * (coalesce(sv.saved_count, 0)::numeric / v_n)
                + 0.35 * g.avg_fit
                + 0.20 * g.min_fit
               ) * case when coalesce(ws.watched_count, 0) > 0 then 0.85 else 1.0 end
             ), 4) as group_score
      from typed ty
      join grouped g on g.media_item_id = ty.media_item_id
      left join saves sv on sv.media_item_id = ty.media_item_id
      left join watch_stats ws on ws.media_item_id = ty.media_item_id
      left join group_reached gr on gr.media_item_id = ty.media_item_id
     where not exists (
             select 1 from recommendation_feedback fb
              where fb.user_id = auth.uid()
                and fb.media_item_id = ty.media_item_id
                and fb.kind = 'dismiss'
           )
       -- The rewatch floor (§5): every known watcher loved it, or nobody watched it.
       and coalesce(ws.worst_opinion, 2) >= 2
       -- Fully met by the whole group: excluded, even if everybody loved it.
       and coalesce(ws.watched_count, 0) < v_n
  ),
  final as (
    -- One total order, stated in full, so two identical calls agree to the row:
    -- score, then explicit saves, then popularity, then the id as the last word.
    select * from scored
     order by group_score desc, saved_count desc,
              popularity desc nulls last, media_item_id
     limit v_limit
  )
  select jsonb_build_object(
           'status', 'ok',
           'effective_member_count', v_n,
           'picks', coalesce(jsonb_agg(
             jsonb_build_object(
               'media_item_id', f.media_item_id,
               'saved_count', f.saved_count,
               'watched_count', f.watched_count,
               'rewatch', f.rewatch,
               'source', f.source,
               'group_score', f.group_score,
               'community_score', cs.score
             )
             order by f.group_score desc, f.saved_count desc,
                      f.popularity desc nulls last, f.media_item_id
           ), '[]'::jsonb)
         )
    into v_result
    from final f
    left join lateral community_score(f.media_item_id) cs on true;

  return v_result;
end;
$function$;
