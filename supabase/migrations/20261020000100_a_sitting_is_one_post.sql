-- ===========================================================================
-- A SITTING IS ONE POST (founder, 2026-09-24)
--
-- Working through an imported library is library maintenance, and until now it was
-- silent: backlog placements opened with kind `import` and posted nothing, because
-- forty `title_ranked` rows in four minutes is a feed nobody can read.
--
-- The founder's correction is not "post them all" but "post the sitting": **one grouped
-- row per Unranked sitting**, which grows as titles finish.
--
--   Michael ranked Oasis: Don't Look Back in Anger + 17 more
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS NOT, AND THE RULE IT MUST NOT BREAK
--
-- It is **ranking activity, never a watch**. It writes no `watch_events` row, moves no
-- `watched_on`, and therefore cannot touch Recently watched, the monthly leaderboard or
-- any watch chronology. Oasis imported at Sep 10 and ranked on Sep 23 keeps Sep 10 as its
-- watch and gets a Sep 23 *ranking* post: two different chronologies, deliberately.
--
-- ---------------------------------------------------------------------------
-- SHAPE, AND WHY IT IS `follow_added`'S
--
-- `20260912000100` already solved "one mutable row that accumulates members": a
-- `feed_events` row plus a membership table, joined by a function because the membership
-- table carries no policy of its own. This is that, with two differences.
--
--   · **The sitting is the client's, not a time window.** `follow_added` coalesces by
--     `feed.follow_aggregation_minutes` because follows arrive from anywhere at any time.
--     A ranking sitting has an actual beginning and end that only the client knows, and
--     the founder asked for no time-window logic — so the client mints a uuid when the
--     sitting opens and passes it with every placement. A later sitting is a later uuid
--     and a second post, which is exactly the intent.
--   · **Membership is ordered.** The row names its first title and counts the rest, so
--     the order titles were placed in is the order the expanded list reads.
--
-- Idempotent twice over: `_record_operation_result` for the retry of one call, and the
-- membership primary key for the same title arriving twice.
-- ===========================================================================

alter table feed_events drop constraint feed_events_known_type;
alter table feed_events add constraint feed_events_known_type check (type in (
  'title_ranked',
  'title_logged',
  'season_completed',
  'list_created',
  'list_added',
  'milestone_reached',
  'joined_from_invitation',
  'watchlist_added',
  'award_earned',
  'goal_completed',
  'follow_added',
  -- 20261020000100. One row per Unranked sitting, whatever it ends up holding.
  'ranking_batch'
));


create table feed_ranking_titles (
  event_id      uuid not null references feed_events(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  -- The order they were placed in, which is the order the expanded list reads.
  placed_at     timestamptz not null default now(),
  primary key (event_id, media_item_id)
);

create index feed_ranking_titles_event on feed_ranking_titles (event_id, placed_at);

/**
 * No policy, on purpose — the same decision `feed_follow_targets` made. Membership is
 * readable only through `ranking_batch_titles` below, which applies the visibility the
 * feed row itself has rather than leaving a table anybody may select from.
 */
alter table feed_ranking_titles enable row level security;

revoke all on feed_ranking_titles from public, anon, authenticated;


/**
 * One open sitting per actor per uuid. The partial unique index is what makes the upsert
 * in `rank_batch_note` safe when two placements finish at once.
 */
create unique index feed_events_ranking_sitting
  on feed_events (actor_id, (payload ->> 'sitting'))
  where type = 'ranking_batch';


-- ---------------------------------------------------------------------------
-- Adding a finished title to this sitting's post
-- ---------------------------------------------------------------------------

create or replace function rank_batch_note(
  p_operation_id  uuid,
  p_sitting       uuid,
  p_media_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim  record;
  v_event  uuid;
  v_count  integer;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_batch_note');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  /**
   * **Only a title this caller has actually ranked.** The post states a placement, so a
   * media item with no `rankings` row for this user is not something to announce — and
   * without this check the function would take any id at all.
   */
  if not exists (
    select 1 from rankings
     where user_id = auth.uid() and media_item_id = p_media_item_id
  ) then
    return _record_operation_result(
      p_operation_id, jsonb_build_object('status', 'not_ranked')
    );
  end if;

  -- The sitting's row, created by whichever placement finishes first.
  insert into feed_events (actor_id, type, media_item_id, payload, causal_at, causal_step)
  values (
    auth.uid(), 'ranking_batch', p_media_item_id,
    jsonb_build_object('sitting', p_sitting::text), now(), 0
  )
  on conflict (actor_id, (payload ->> 'sitting')) where type = 'ranking_batch'
    do update set payload = feed_events.payload
  returning id into v_event;

  insert into feed_ranking_titles (event_id, media_item_id)
  values (v_event, p_media_item_id)
  on conflict (event_id, media_item_id) do nothing;

  select count(*) into v_count from feed_ranking_titles where event_id = v_event;

  /**
   * The count lives on the row so the feed can draw "+ 17 more" without joining, and
   * `causal_at` is deliberately **not** bumped: the Feed is paged by a keyset over it, so
   * a growing post must keep the position it was created at rather than jumping to the
   * top on every placement (`20260912000100`'s rule, for the same reason).
   */
  update feed_events
     set payload = payload || jsonb_build_object('count', v_count)
   where id = v_event;

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object('status', 'ok', 'event_id', v_event, 'count', v_count)
  );
end;
$$;

comment on function rank_batch_note(uuid, uuid, uuid) is
  'Adds one finished Unranked placement to that sitting''s grouped feed post, creating the '
  'post on the first title. Ranking activity only: writes no watch_events row and moves no '
  'watch date, so Recently watched and the monthly leaderboard are untouched. The sitting is '
  'the client''s uuid rather than a time window (founder, 2026-09-24); a later sitting is a '
  'second post. Idempotent by operation id and by membership key. Refuses a title this caller '
  'has not ranked.';

revoke execute on function rank_batch_note(uuid, uuid, uuid) from public, anon;
grant execute on function rank_batch_note(uuid, uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- Reading one, for the expanded list
-- ---------------------------------------------------------------------------

/**
 * Every title in a sitting's post, with the standing and score it holds **now** — the
 * same pair the private summary shows, read fresh rather than frozen into the payload,
 * because a later rerank should not leave the feed quoting a number that has moved.
 *
 * Gated on the event being one the viewer may see at all: `can_view_feed_event` is the
 * predicate the feed itself is built on, so this cannot become a way to read a post the
 * feed would not have shown.
 */
create or replace function ranking_batch_titles(p_event_id uuid)
returns table (
  media_item_id uuid,
  title         text,
  poster_path   text,
  "position"    integer,
  score         numeric,
  bucket        taste_bucket
)
language sql
stable
security definer
set search_path = public
as $$
  /**
   * The score is **derived**, exactly as `public_scores` derives it — `rankings` carries
   * a position and no score — so this quotes `band_bounds` and `score_for` rather than
   * restating the formula. `public_scores` itself is not called: it is capped at fifty
   * ids per filter for a page of activity, and a sitting has no such ceiling.
   *
   * A title the actor has since unranked yields a null position and no score, and the
   * row still appears: it was ranked in that sitting, and the post is a record of the
   * sitting rather than of the current list.
   */
  with mine as (
    select frt.placed_at, mi.id, mi.title, mi.poster_path,
           r.position, r.category, r.bucket
      from feed_events fe
      join feed_ranking_titles frt on frt.event_id = fe.id
      join media_items mi          on mi.id = frt.media_item_id
      left join rankings r         on r.user_id = fe.actor_id and r.media_item_id = mi.id
     where fe.id = p_event_id
       and fe.type = 'ranking_batch'
       -- The feed row's own visibility, so this cannot read a post the feed would hide.
       and can_view_profile(auth.uid(), fe.actor_id)
  ),
  bands as (
    select d.category, d.bucket, bb.lo, bb.size
      from (
        select distinct m.category, m.bucket,
               (select fe.actor_id from feed_events fe where fe.id = p_event_id) as actor
          from mine m where m.category is not null
      ) d
      cross join lateral band_bounds(d.actor, d.category, d.bucket) bb
  )
  select m.id, m.title, m.poster_path, m.position,
         case
           when m.position is null then null
           else score_for(m.bucket, (m.position - b.lo + 1)::integer, b.size)
         end,
         m.bucket
    from mine m
    left join bands b on b.category = m.category and b.bucket = m.bucket
   order by m.placed_at, m.title;
$$;

comment on function ranking_batch_titles(uuid) is
  'The titles behind one grouped ranking post, in the order they were placed, with the '
  'position and score they hold now rather than the ones they held when posted. Visibility '
  'is the feed row''s own.';

revoke execute on function ranking_batch_titles(uuid) from public, anon;
grant execute on function ranking_batch_titles(uuid) to authenticated;
