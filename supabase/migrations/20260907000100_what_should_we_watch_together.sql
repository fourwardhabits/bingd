-- What should we watch together: the Group Picks RPC.
-- Founder brief 2026-09-03: one ephemeral group, one call, one ranked list.
--
-- ===========================================================================
-- 1. WHAT THIS IS
--
-- A reader picks up to five people they approvedly follow; the server answers with
-- titles that make sense for the WHOLE group. No group is stored anywhere -- the
-- member set is an argument, the answer is a value, and closing the sheet is the
-- whole lifecycle. No new table, no new policy, no persisted state.
--
-- The candidate families, strongest first:
--
--   saved    -- the union of the effective members' visible watchlists. Explicit
--              intent, and the only family a person actually asked for.
--   similar  -- titles near each member's strongest loved rankings, through the same
--              media_cache facet='similar' rows For You already reads. This is what
--              makes Group Picks discover things nobody has saved yet.
--   loved    -- titles some members already loved, which others have not met. These
--              are the rewatch candidates, and the positive-opinion floor below is
--              what keeps them honest.
--   trending -- the provider_list_cache week list, last. It exists so a sparse or
--              new group is not answered with nothing, and it is capped so it can
--              never outrank anything group-derived.
--
-- ===========================================================================
-- 2. WHY SECURITY INVOKER, STATED BEFORE A REVIEWER ASKS
--
-- Every table this reads already answers the right question under RLS for exactly
-- this caller: `watchlist_read` and `rankings_read` are both `can_i_view(user_id)`,
-- `media_items` / `media_cache` / `provider_list_cache` are world-readable, and
-- `user_media` / `recommendation_feedback` are own-rows-only. So the caller's own
-- privileges ARE the privacy model, and running as the caller makes the failure
-- mode structural: if this function ever grew a read of somebody's private
-- `title_recommendations`, RLS would return zero rows rather than data. A definer
-- body would have to re-implement all of that filtering by hand and get it right
-- forever. (`social_candidates` is definer because it aggregates over rows the
-- caller may NOT read one by one; nothing here needs that.)
--
-- The one definer function this calls is `community_score`, which is already
-- granted to `authenticated` -- the caller could make the identical call
-- themselves, so folding it in widens nothing.
--
-- ===========================================================================
-- 3. THE PRIVACY SHAPE OF THE ANSWER
--
-- Aggregates only. `saved_count`, `watched_count`, a rewatch flag, an internal
-- `group_score`, the community score, and the effective member count. Never which
-- member saved or watched anything, never a member id, never an anchor title,
-- never anybody's ranking. The per-member arithmetic happens inside this function
-- and dies with the query. The client composes no social sentence beyond what the
-- counts state, which is the same rule `social_candidates` set.
--
-- Membership is re-checked here, at query time, per member: an id that is not the
-- caller's own approved, `can_i_view`-visible followee contributes nothing and is
-- not in the denominator. A block, a suspension, or a flip to private between the
-- picker and the call therefore takes the member's signal with it, silently --
-- the caller learns the effective count, not who fell out.
--
-- One asymmetry is accepted rather than worked around: another member's unranked
-- logs live in `user_media`, which is owner-only, so a title a member merely
-- logged without ranking cannot be excluded on their behalf. Their rankings are
-- the watch evidence this function can see. The caller's own `user_media` IS
-- readable here and is used. Working around this through feed_events or a wider
-- policy was considered and refused (founder brief, privacy boundaries).
--
-- ===========================================================================
-- 4. SCORING, AND THE PRINCIPLES THE WEIGHTS ENCODE
--
-- Per member m and candidate t, a predicted fit in [0, 1]:
--
--   fit = clamp( 0.35                                    -- an unknown is neutral,
--              + 0.40 * (1 - 1/(1 + anchor_hits))        -- near their loved titles
--              + 0.35 * min(1, loved-genre share)        -- in genres they love
--              - 0.50 * min(1, disliked-genre share) )   -- in genres they rejected
--   and a member who saved t reads at least 0.85: saving is explicit intent.
--
-- The neutral 0.35 base is what keeps a member with little history from silently
-- dragging every candidate down -- absence of evidence is not evidence of a bad
-- fit, and the founder's rule is that such a member is never singled out.
--
-- Group score = 0.45 * saved_share + 0.35 * avg(fit) + 0.20 * min(fit)
--
--   * saved_share (saved_count / effective members) dominates: two savers beat any
--     amount of inferred taste, which is the explicit-intent principle.
--   * avg + min together are the consensus principle: the min term means one
--     member's evidenced poor fit drags the score in a way the average cannot
--     hide, so an 8-for-everybody beats a 10-for-two-4-for-the-rest.
--   * popularity is NOT in the score. It appears only in the ORDER BY as a late
--     tie-break, so Group Picks cannot decay into Trending.
--
-- An eligible rewatch is multiplied by 0.85 -- good rewatches compete, behind an
-- equally good first watch. A candidate reached by trending alone is capped at
-- 0.15, beneath any group-derived candidate the client would show as such.
--
-- ===========================================================================
-- 5. THE REWATCH FLOOR
--
-- Known watchers are members with a ranking of the title (any season of it, for a
-- series), plus the caller's own logs. The bucket is the app's own vocabulary and
-- the floor is POSITIVE ONLY:
--
--   every known watcher put it in `loved`  -> eligible, penalised, flagged rewatch
--   any known watcher has `fine`           -> excluded. "It was fine" is not a
--   any known watcher has `not_for_me`     -> excluded.   reason to watch it again.
--   a caller log with no bucket            -> excluded: unknown does not clear a floor.
--   every effective member has watched it  -> excluded, even if everybody loved it.
--
-- ===========================================================================
-- 6. TV IS SERIES-LEVEL
--
-- For p_medium = 'tv' every id in the answer is a series. Season rankings roll up
-- to their parent for anchors, taste and watch evidence -- the same rollup
-- `anchorsFrom` performs client-side -- and season watchlist rows count for their
-- series. Season rows can never appear in the result: candidates are joined to
-- media_items on the target kind.
--
-- ===========================================================================

-- The lateral community_score per returned candidate reads rankings by media item,
-- and rankings has never had an index leading on media_item_id -- community_score
-- was only ever called for one title at a time, where a scan was tolerable. Two
-- hundred laterals is where that stops being true. Also serves every existing
-- per-title community_score call.
create index if not exists rankings_by_media on rankings (media_item_id);

create or replace function group_picks(
  p_member_ids uuid[],
  p_medium     text,
  p_limit      integer default 200
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
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
        select r.user_id as who, t.id as media_item_id, min(r.position) as best_position
          from rankings r
          join members on members.who = r.user_id
          join media_items raw on raw.id = r.media_item_id
          join media_items t on t.id = coalesce(raw.parent_id, raw.id)
                            and t.kind = v_kind
         where r.bucket = 'loved'
         group by r.user_id, t.id
      ) rolled
  ),

  -- --------------------------------------------------------------- similar
  similar_hits as (
    select a.who, (ids.value)::uuid as media_item_id
      from anchor_pool a
      join media_cache mc on mc.media_item_id = a.media_item_id
                         and mc.facet = 'similar'
                         and mc.expires_at > now()
      cross join lateral jsonb_array_elements_text(
        coalesce(mc.payload->'ids', '[]'::jsonb)
      ) as ids(value)
     where a.strength <= 6
       and ids.value ~ '^[0-9a-fA-F-]{36}$'
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
        coalesce(plc.payload->'ids', '[]'::jsonb)
      ) as ids(value)
     where plc.list_key = case when v_kind = 'movie'
                               then 'trending.movie.week'
                               else 'trending.series.week' end
       and ids.value ~ '^[0-9a-fA-F-]{36}$'
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
    select r.user_id as who, t.id as media_item_id,
           min(case r.bucket when 'loved' then 2 when 'fine' then 1 else 0 end) as opinion
      from rankings r
      join members on members.who = r.user_id
      join media_items raw on raw.id = r.media_item_id
      join media_items t on t.id = coalesce(raw.parent_id, raw.id)
                        and t.kind = v_kind
     group by r.user_id, t.id
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
    select r.user_id as who, g.genre,
           count(*) filter (where r.bucket = 'loved') as loved_n,
           count(*) filter (where r.bucket = 'not_for_me') as disliked_n
      from rankings r
      join members on members.who = r.user_id
      join media_items raw on raw.id = r.media_item_id
      join media_items t on t.id = coalesce(raw.parent_id, raw.id)
      cross join lateral unnest(t.genres) as g(genre)
     group by r.user_id, g.genre
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
$$;

comment on function group_picks(uuid[], text, integer) is
  'Ranked titles for an ephemeral group: the caller plus up to five people they approvedly follow, re-checked through can_i_view at query time. Security invoker, so RLS is the privacy model: visible watchlists and rankings are the only cross-member reads, and private tables answer empty by construction. Returns aggregates only -- saved_count, watched_count, a rewatch flag, group_score, community score, effective_member_count -- never a member id, an anchor, or anybody''s ranking. TV answers are series-level. Rewatches need every known watcher in loved; a title the whole group has met is excluded. Trending is a capped last-resort fill, not a family that can win.';

revoke execute on function group_picks(uuid[], text, integer) from public, anon, authenticated;
grant  execute on function group_picks(uuid[], text, integer) to authenticated;
