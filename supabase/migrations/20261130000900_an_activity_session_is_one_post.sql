-- An activity session is one post (founder spec, 2026-11-21). Stacked on 20261130000800.
--
-- ---------------------------------------------------------------------------
-- THE RULE
-- ---------------------------------------------------------------------------
--
-- A person's eligible first-time rankings (reviewed ones included, 20261130000800) and
-- watchlist additions inside one fixed 30-minute window are ONE Feed post, whichever came
-- first and in whatever order they interleave:
--
--     3:00 rank A, 3:07 save B and C, 3:12 rank D   ->   one post, four titles
--
--   * **The window** is fixed at `feed.ranking_group_minutes` (30) from the session's first
--     eligible event, recorded once as `payload.started_at`. It never slides or restarts; an
--     event at or after `started_at + 30 min` starts the next session.
--   * **The post keeps its identity.** A session that grows keeps its id, reactions,
--     comments, notification references and deep links. Nothing is deleted to merge, and no
--     notification is written (only inserts notify; a session grows by UPDATE).
--   * **It moves.** When qualifying activity joins, the post's `causal_at`, the Feed's own
--     keyset column, moves forward to the latest activity (never backwards), so on the next
--     refresh the post sits where its newest title belongs. `payload.last_activity_at` is
--     the time the card prints. `created_at` and `started_at` never move.
--   * **The newest title leads.** `media_item_id` is the most recent title; every member
--     reader returns members newest-first, with each member's own action (`ranked` or
--     `saved`) and time. A title saved and then ranked inside one session is one member, in
--     its ranked state; both underlying events and membership rows stay.
--   * **Unchanged:** rewatches, TV updates, corrections and reranks keep their own posts (or
--     none); a referenced event (comments, reactions, notifications, proactive items, award
--     causes) is never hidden, and a hidden one that gains a reference gets its card back
--     (`_unpresent_on_reference`); review and note edits are not session events.
--
-- ---------------------------------------------------------------------------
-- THE POST, AND WHAT AN OLDER CLIENT MAKES OF IT
-- ---------------------------------------------------------------------------
--
-- A session is carried by an ordinary row of an existing type, so every client in the field
-- can draw it:
--
--   * **watchlist_added** while it holds saves only, exactly as 20261125000100 drew it;
--   * **ranking_batch** as soon as it holds a ranking. A watchlist session that gains a
--     ranking is converted in place (same id, same conversation), once; the reverse happens
--     only if every ranking later leaves it (a hidden member restored by a reference).
--
-- An older bundle therefore reads a mixed session as a ranking group ("ranked 16 titles",
-- its rail and its "Ranked in this sitting" sheet), with no score on a saved title's poster
-- or row, and the time label of the post's first activity. Nothing it calls changes
-- signature. docs/feed/activity-sessions.md has the full compatibility table.
--
-- New payload keys (additive, ignored by older bundles): `session`, `last_activity_at`,
-- `lead_action` (`ranked` / `saved`), `ranked`, `saved`.
--
-- ---------------------------------------------------------------------------
-- LOCKS
-- ---------------------------------------------------------------------------
--
-- Every session writer takes the actor's two existing keys in one order,
-- `ranking_story:<actor>` then `watchlist_story:<actor>` (`_lock_activity_session`), before
-- it reads anything: a ranking on one device and a save on another serialise, so they can
-- never start two sessions for one window. `consolidate_feed_history` already took them in
-- this order; nothing takes them the other way round.
--
-- ---------------------------------------------------------------------------
-- KILL SWITCH AND ROLLBACK
-- ---------------------------------------------------------------------------
--
-- `feed.activity_sessions_enabled` false: rankings and saves group only with their own
-- family again (the 20261130000800 behaviour), and a growing post no longer moves. Posts
-- already formed stay formed. Full rollback:
-- docs/release/activity-sessions/rollback-20261130000900.sql, rehearsed by
-- supabase/tests/activity-sessions-rollback.test.mjs.
--
-- The historical consolidation (`consolidate_feed_sessions`, `revert_feed_session_consolidation`)
-- is defined here and is inert: operator-only, never called by this migration or the app.

insert into app_config (key, value) values
  ('feed.activity_sessions_enabled', 'true'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Small helpers
-- ---------------------------------------------------------------------------

create or replace function _activity_sessions_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (select 1 from app_config
                      where key = 'feed.activity_sessions_enabled' and value = 'false'::jsonb);
$$;

/** The session window: `feed.ranking_group_minutes`, 30 by default, at least one minute. */
create or replace function _activity_session_window()
returns interval
language sql
stable
security definer
set search_path = public
as $$
  select make_interval(mins => greatest(1, coalesce(
           (select (value)::integer from app_config where key = 'feed.ranking_group_minutes'),
           30)));
$$;

/**
 * The actor's two writer keys, always in this order. Re-entrant within a transaction and
 * released at commit, like every advisory key here.
 */
create or replace function _lock_activity_session(p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('ranking_story:' || p_actor::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('watchlist_story:' || p_actor::text, 0));
end;
$$;

revoke execute on function _activity_sessions_enabled() from public, anon, authenticated;
revoke execute on function _activity_session_window() from public, anon, authenticated;
revoke execute on function _lock_activity_session(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. A post's members, whatever kind of post it is
-- ---------------------------------------------------------------------------

/**
 * Every title a post shows, once each, with what was done to it and when:
 *
 *   * its own membership: an Unranked sitting's placements (`feed_ranking_titles`, ranked)
 *     and saves (`feed_watchlist_titles`, saved), on any post type;
 *   * the posts it presents: a hidden `title_ranked` is its one title, ranked; a hidden post
 *     of any type brings its own membership rows.
 *
 * A title with both a ranking and a save is `ranked` (the founder's "show the ranked state"),
 * dated by its ranking. `first_at` and `first_tiebreak` are the earliest row, which is the
 * order `_group_titles` has always returned; `acted_at` and `last_tiebreak` order the
 * session newest-first. Not gated: every caller gates on the post's actor first.
 */
create or replace function _group_members(p_event_id uuid)
returns table (
  media_item_id  uuid,
  first_at       timestamptz,
  first_tiebreak bigint,
  acted_at       timestamptz,
  last_tiebreak  bigint,
  action         text
)
language sql
stable
security definer
set search_path = public
as $$
  with raw as (
    select frt.media_item_id, frt.placed_at as at, frt.id as tiebreak, true as ranked
      from feed_ranking_titles frt
     where frt.event_id = p_event_id
    union all
    select wt.media_item_id, wt.added_at, wt.id, false
      from feed_watchlist_titles wt
     where wt.event_id = p_event_id
    union all
    select fe.media_item_id, fe.created_at, 0, true
      from feed_events fe
     where fe.presented_in = p_event_id
       and fe.type = 'title_ranked'
       and fe.media_item_id is not null
    union all
    select frt.media_item_id, frt.placed_at, frt.id, true
      from feed_events fe
      join feed_ranking_titles frt on frt.event_id = fe.id
     where fe.presented_in = p_event_id
    union all
    select wt.media_item_id, wt.added_at, wt.id, false
      from feed_events fe
      join feed_watchlist_titles wt on wt.event_id = fe.id
     where fe.presented_in = p_event_id
  ),
  ordered as (
    select r.*,
           row_number() over (partition by r.media_item_id order by r.at, r.tiebreak) as first_rn
      from raw r
  )
  select o.media_item_id,
         min(o.at),
         min(o.tiebreak) filter (where o.first_rn = 1),
         coalesce(max(o.at) filter (where o.ranked), max(o.at)),
         max(o.tiebreak),
         case when bool_or(o.ranked) then 'ranked' else 'saved' end
    from ordered o
   group by o.media_item_id;
$$;

revoke execute on function _group_members(uuid) from public, anon, authenticated;

/**
 * `_group_titles` (20261128000100), same signature and order, now over `_group_members`, so
 * a ranking group's saves and a watchlist group's rankings are counted and listed too.
 * Every post written before this migration holds one family only, so for it nothing
 * changes.
 */
create or replace function _group_titles(p_event_id uuid)
returns table (media_item_id uuid, joined_at timestamptz, tiebreak bigint)
language sql
stable
security definer
set search_path = public
as $$
  select m.media_item_id, m.first_at, m.first_tiebreak
    from _group_members(p_event_id) m
   order by m.media_item_id;
$$;

revoke execute on function _group_titles(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Keeping a session post's row true
-- ---------------------------------------------------------------------------

/**
 * Recomputes everything a session post says about its members, from the members:
 *
 *   * `payload.count`, `ranked`, `saved` (distinct titles; a saved-then-ranked title is
 *     ranked), `lead_action`, `last_activity_at` (never moves backwards), `session`;
 *   * `media_item_id`, the newest title;
 *   * `type`: `ranking_batch` once a ranking is among the members, `watchlist_added` while
 *     only saves are (only when the newest title can carry one without breaking
 *     `feed_events_watchlist_once`; otherwise the post stays a ranking group);
 *   * `causal_at`, moved forward to the newest activity when sessions are enabled, with
 *     `causal_step` 0. Never backwards, which is what keeps keyset pagination free of
 *     duplicates (docs/feed/activity-sessions.md).
 *
 * `p_excluding` names a title that is leaving the catalogue (the delete trigger, which runs
 * before its cascades); it, and any member whose title is already gone, is not counted.
 *
 * Callers hold the actor's session keys or the post's row lock. Internal.
 */
-- One signature only (an earlier draft of this migration, applied on staging, took one argument).
drop function if exists _session_refresh(uuid);
create or replace function _session_refresh(p_event_id uuid, p_excluding uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_g        record;
  v_count    integer;
  v_ranked   integer;
  v_saved    integer;
  v_last     timestamptz;
  v_lead     uuid;
  v_action   text;
  v_type     text;
  v_media    uuid;
  v_bump     boolean;
begin
  select fe.id, fe.actor_id, fe.type, fe.media_item_id, fe.payload, fe.causal_at, fe.created_at
    into v_g
    from feed_events fe
   where fe.id = p_event_id;
  if v_g.id is null or v_g.type not in ('ranking_batch', 'watchlist_added') then
    return;
  end if;

  select count(*)::integer,
         (count(*) filter (where m.action = 'ranked'))::integer,
         (count(*) filter (where m.action = 'saved'))::integer,
         max(m.acted_at)
    into v_count, v_ranked, v_saved, v_last
    from _group_members(p_event_id) m
   where m.media_item_id is distinct from p_excluding
     and exists (select 1 from media_items mi where mi.id = m.media_item_id);

  if coalesce(v_count, 0) = 0 then
    return;
  end if;

  select m.media_item_id, m.action
    into v_lead, v_action
    from _group_members(p_event_id) m
   where m.media_item_id is distinct from p_excluding
     and exists (select 1 from media_items mi where mi.id = m.media_item_id)
   order by m.acted_at desc, m.last_tiebreak desc, m.media_item_id
   limit 1;

  v_type := case when v_ranked > 0 then 'ranking_batch' else 'watchlist_added' end;
  v_media := v_lead;
  /**
   * `feed_events_watchlist_once`: one watchlist_added row per (actor, title), hidden or not.
   * A post of saves alone is named by its newest surviving title that no other watchlist
   * post carries (a hidden post presented by this one may carry its own). If none can, the
   * post is a ranking group, whose title is not unique (Codex, PR 354): never the departing
   * title, so a catalogue delete never cascades the post away.
   */
  if v_type = 'watchlist_added' then
    select m.media_item_id
      into v_media
      from _group_members(p_event_id) m
     where m.media_item_id is distinct from p_excluding
       and exists (select 1 from media_items mi where mi.id = m.media_item_id)
       and not exists (
         select 1 from feed_events o
          where o.actor_id = v_g.actor_id and o.type = 'watchlist_added'
            and o.media_item_id = m.media_item_id and o.id <> p_event_id)
     order by m.acted_at desc, m.last_tiebreak desc, m.media_item_id
     limit 1;
    if v_media is null then
      v_type := 'ranking_batch';
      v_media := v_lead;
    end if;
  end if;

  v_bump := _activity_sessions_enabled() and v_last > v_g.causal_at;

  update feed_events
     set type = v_type,
         media_item_id = v_media,
         causal_at = case when v_bump then v_last else causal_at end,
         causal_step = case when v_bump then 0 else causal_step end,
         payload = payload || jsonb_build_object(
           'session', true,
           'count', v_count,
           'ranked', v_ranked,
           'saved', v_saved,
           'lead_action', v_action,
           'last_activity_at', greatest(
             coalesce((payload ->> 'last_activity_at')::timestamptz, v_last), v_last),
           -- A watchlist post written before this migration was windowed from its creation.
           'started_at', coalesce(payload -> 'started_at', to_jsonb(v_g.created_at)))
   where id = p_event_id;
end;
$$;

revoke execute on function _session_refresh(uuid, uuid) from public, anon, authenticated;

/**
 * The actor's open session for an event at `p_at`: their latest visible post that can
 * still take members (a ranking group with a start, or a watchlist post with a count; not
 * a history group, not dissolved) whose fixed window holds `p_at`. Locked.
 *
 *   * `p_family` names the event's own family. With sessions disabled only a post of that
 *     family is returned, which is the 20261130000800 behaviour.
 *   * `p_strict` also requires `p_at` at or after the start: an Unranked sitting that began
 *     before a session did belongs to no part of it (Codex, PR 311).
 *
 * `causal_at >= started_at` always holds (a post is never placed before its first title),
 * so `causal_at > p_at - window` is a safe prefilter on the actor's window indexes.
 */
create or replace function _open_session(
  p_actor  uuid,
  p_at     timestamptz,
  p_family text,
  p_strict boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window interval := _activity_session_window();
  v_any    boolean := _activity_sessions_enabled();
  v_id     uuid;
begin
  select e.id
    into v_id
    from feed_events e
   where e.actor_id = p_actor
     and e.presented_in is null
     and e.type in ('ranking_batch', 'watchlist_added')
     and (v_any or e.type = case when p_family = 'ranking' then 'ranking_batch'
                                 else 'watchlist_added' end)
     and not (e.payload ? 'consolidation_batch')
     and not coalesce((e.payload ->> 'dissolved')::boolean, false)
     and ((e.type = 'ranking_batch' and e.payload ? 'started_at')
          or (e.type = 'watchlist_added' and e.payload ? 'count'))
     and e.causal_at > p_at - v_window
     and p_at < coalesce((e.payload ->> 'started_at')::timestamptz, e.created_at) + v_window
     and (not p_strict
          or p_at >= coalesce((e.payload ->> 'started_at')::timestamptz, e.created_at))
   order by coalesce((e.payload ->> 'started_at')::timestamptz, e.created_at) desc,
            e.causal_at desc, e.id
   limit 1
     for update of e;
  return v_id;
end;
$$;

revoke execute on function _open_session(uuid, timestamptz, text, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. A first ranking from the ranking sheet
-- ---------------------------------------------------------------------------

/**
 * `rank_group_note`, 20261130000800's body with three changes:
 *
 *   * the actor's session keys (both) instead of `ranking_story` alone;
 *   * the open session may be a watchlist post, which then becomes a ranking group in
 *     place (same id) (`_open_session`, `_session_refresh`);
 *   * every join, and every new group, refreshes the post: count, newest title, its
 *     action, and its place in the Feed.
 *
 * Answers exactly as before (`joined`, `grouped`, `solo`, `skipped`), so an older client
 * that calls it, and every bundle in the field does, needs nothing new.
 */
create or replace function rank_group_note(p_operation_id uuid, p_media_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_claim   record;
  v_event   record;
  v_window  interval;
  v_target  uuid;
  v_peer    record;
  v_first   record;
  v_found   boolean := false;
  v_count   integer;
  v_anchor  timestamptz;
begin
  if v_me is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_group_note');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  if exists (select 1 from app_config
              where key = 'feed.ranking_backfill_grouping_enabled' and value = 'false'::jsonb) then
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'skipped', 'reason', 'disabled'));
  end if;

  -- 20261130000900: both of the actor's keys, before anything is read, so a save on another
  -- device is never deciding about the same window at the same time.
  perform _lock_activity_session(v_me);

  v_window := _activity_session_window();

  -- This ranking's own post: the newest, still visible, and recent. Locked, so a comment or
  -- reaction being written on it is waited for and then seen below.
  select fe.id, fe.created_at, fe.causal_at, fe.payload
    into v_event
    from feed_events fe
   where fe.actor_id = v_me
     and fe.type = 'title_ranked'
     and fe.media_item_id = p_media_item_id
     and fe.presented_in is null
     and fe.created_at > now() - v_window
   order by fe.created_at desc, fe.id desc
   limit 1
     for update;

  if v_event.id is null then
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'skipped', 'reason', 'no_post'));
  end if;
  -- A rewatch (`again`) and a historic TV update post are their own activity.
  if coalesce((v_event.payload ->> 'update')::boolean, false)
     or coalesce((v_event.payload ->> 'again')::boolean, false) then
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'skipped', 'reason', 'not_first'));
  end if;
  if _feed_event_referenced(v_event.id) then
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'skipped', 'reason', 'referenced'));
  end if;
  -- No review test (20261130000800) and no watch-date test (20261130000200).

  -- The open session, ranking group or (20261130000900) watchlist post, whose fixed window
  -- holds this ranking's own time.
  v_target := _open_session(v_me, v_event.created_at, 'ranking');

  /**
   * A delayed note (Codex, PR 354): the ranking happened before the session's recorded
   * start, so it is the session's first event. It joins only if every member still lies
   * inside one window of it, and the start moves back to it; otherwise the session could
   * span more than 30 minutes, and the ranking looks for a peer or stays on its own.
   */
  if v_target is not null then
    select coalesce((payload ->> 'started_at')::timestamptz, created_at) into v_anchor
      from feed_events where id = v_target;
    if v_event.created_at < v_anchor then
      if exists (select 1 from _group_members(v_target) m
                  where m.acted_at >= v_event.created_at + v_window) then
        v_target := null;
      else
        update feed_events
           set payload = payload || jsonb_build_object('started_at', v_event.created_at)
         where id = v_target;
      end if;
    end if;
  end if;

  if v_target is not null then
    update feed_events set presented_in = v_target where id = v_event.id;
    perform _session_refresh(v_target);
    select (payload ->> 'count')::integer into v_count from feed_events where id = v_target;
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'joined', 'event_id', v_target, 'count', v_count));
  end if;

  -- No open session: the earliest first ranking still on its own, marked by an earlier note,
  -- untouched, inside one window of this one. Locked, then re-checked in a fresh statement.
  for v_peer in
    select fe.id, fe.created_at, fe.causal_at, fe.media_item_id
      from feed_events fe
     where fe.actor_id = v_me
       and fe.type = 'title_ranked'
       and fe.id <> v_event.id
       and fe.presented_in is null
       and (coalesce((fe.payload ->> 'groupable')::boolean, false)
            or coalesce((fe.payload ->> 'backfill')::boolean, false))
       and fe.created_at > v_event.created_at - v_window
       and fe.created_at < v_event.created_at + v_window
     order by fe.created_at, fe.id
  loop
    perform 1 from feed_events where id = v_peer.id for update;
    if exists (select 1 from feed_events where id = v_peer.id and presented_in is null)
       and not _feed_event_referenced(v_peer.id) then
      v_found := true;
      exit;
    end if;
  end loop;

  if v_found then
    -- The window starts at the earlier title; the post takes its place in the Feed from the
    -- later one (`_session_refresh`).
    if v_peer.created_at <= v_event.created_at then
      v_first := v_peer;
    else
      select v_event.id, v_event.created_at, v_event.causal_at, p_media_item_id as media_item_id
        into v_first;
    end if;
    insert into feed_events (actor_id, type, media_item_id, payload, created_at, causal_at, causal_step)
    values (
      v_me, 'ranking_batch', v_first.media_item_id,
      jsonb_build_object('count', 2, 'started_at', v_first.created_at, 'origin', 'title',
                         'session', true),
      v_first.created_at, v_first.causal_at, 0
    )
    returning id into v_target;
    update feed_events set presented_in = v_target where id in (v_peer.id, v_event.id);
    perform _session_refresh(v_target);
    select (payload ->> 'count')::integer into v_count from feed_events where id = v_target;
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'grouped', 'event_id', v_target, 'count', v_count));
  end if;

  update feed_events set payload = payload || jsonb_build_object('groupable', true)
   where id = v_event.id;
  return _record_operation_result(p_operation_id,
    jsonb_build_object('status', 'solo', 'event_id', v_event.id));
end;
$$;

comment on function rank_group_note(uuid, uuid) is
  'Title-page first-ranking grouping (20261128000100, 20261130000200, 20261130000800, '
  '20261130000900). Puts the caller''s newest first-time, unreferenced title_ranked post for '
  'the title into the actor''s open activity session (a ranking group, or a watchlist post '
  'that becomes one in place; fixed window from its first activity), or into a new group '
  'with an earlier first ranking still on its own, by hiding it behind the post '
  '(presented_in). The post moves to its newest activity. Serialised on the actor''s '
  'session keys. Idempotent.';

revoke execute on function rank_group_note(uuid, uuid) from public, anon;
grant execute on function rank_group_note(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. A save
-- ---------------------------------------------------------------------------

/**
 * `_post_watchlist_activity`, 20261128000100's body with the session rule:
 *
 *   1. the actor's open session takes the save, whichever family it is;
 *   2. otherwise a first ranking still on its own (marked `groupable` by its note) inside
 *      the window is the session's first event: a ranking group is made from the two, the
 *      window starting at the ranking;
 *   3. otherwise the save starts a watchlist post of its own, as before.
 *
 * Announced once, ever, per (actor, title), as before (`feed_watchlist_titles_once`).
 * With `feed.watchlist_grouping_enabled` false it writes a single post exactly as
 * 20260820000300 did. `set_watchlist` is unchanged and still calls this.
 */
create or replace function _post_watchlist_activity(p_actor uuid, p_media_item_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grouping boolean;
  v_window   interval;
  v_event    uuid;
  v_peer     record;
  v_found    boolean := false;
begin
  if p_actor is null or p_media_item_id is null then
    return null;
  end if;

  -- 20261130000900: both of the actor's keys, in the one order every writer uses.
  perform _lock_activity_session(p_actor);

  if exists (
       select 1 from feed_watchlist_titles
        where actor_id = p_actor and media_item_id = p_media_item_id
     )
     or exists (
       select 1 from feed_events
        where actor_id = p_actor and media_item_id = p_media_item_id
          and type = 'watchlist_added'
     ) then
    return null;
  end if;

  v_grouping := not exists (
    select 1 from app_config
     where key = 'feed.watchlist_grouping_enabled' and value = 'false'::jsonb
  );

  if v_grouping then
    v_window := _activity_session_window();
    v_event := _open_session(p_actor, now(), 'watchlist');

    if v_event is null and _activity_sessions_enabled() then
      for v_peer in
        select fe.id, fe.created_at, fe.causal_at
          from feed_events fe
         where fe.actor_id = p_actor
           and fe.type = 'title_ranked'
           and fe.presented_in is null
           and (coalesce((fe.payload ->> 'groupable')::boolean, false)
                or coalesce((fe.payload ->> 'backfill')::boolean, false))
           and not coalesce((fe.payload ->> 'update')::boolean, false)
           and not coalesce((fe.payload ->> 'again')::boolean, false)
           and fe.created_at > now() - v_window
           and fe.created_at <= now()
         order by fe.created_at, fe.id
      loop
        perform 1 from feed_events where id = v_peer.id for update;
        if exists (select 1 from feed_events where id = v_peer.id and presented_in is null)
           and not _feed_event_referenced(v_peer.id) then
          v_found := true;
          exit;
        end if;
      end loop;

      if v_found then
        insert into feed_events (actor_id, type, media_item_id, payload, created_at, causal_at, causal_step)
        values (
          p_actor, 'ranking_batch', p_media_item_id,
          jsonb_build_object('count', 2, 'started_at', v_peer.created_at, 'origin', 'session',
                             'session', true),
          v_peer.created_at, v_peer.causal_at, 0
        )
        returning id into v_event;
        if v_event is null then
          return null; -- silenced during an import
        end if;
        update feed_events set presented_in = v_event where id = v_peer.id;
      end if;
    end if;
  end if;

  if v_event is null then
    insert into feed_events (actor_id, type, media_item_id, payload, causal_at, causal_step)
    values (
      p_actor, 'watchlist_added', p_media_item_id,
      case when v_grouping
           then jsonb_build_object('count', 1, 'started_at', now(), 'session', true)
           else '{}'::jsonb end,
      now(), 0
    )
    returning id into v_event;
    if v_event is null then
      return null; -- silenced during an import
    end if;
  end if;

  insert into feed_watchlist_titles (event_id, actor_id, media_item_id)
  values (v_event, p_actor, p_media_item_id);

  if v_grouping then
    perform _session_refresh(v_event);
  end if;

  return v_event;
end;
$$;

comment on function _post_watchlist_activity(uuid, uuid) is
  'Announces one saved title as Feed activity (20261125000100, 20261130000900): joins the '
  'actor''s open activity session (watchlist post or ranking group, fixed window from its '
  'first activity), or makes one with a first ranking still on its own inside the window, '
  'or starts a watchlist post. Each (actor, title) is announced once, ever. The post moves '
  'to its newest activity. Serialised on the actor''s session keys. Internal.';

revoke all on function _post_watchlist_activity(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. An Unranked sitting
-- ---------------------------------------------------------------------------

/**
 * `rank_batch_note`, 20261128000100's body with the session keys, and with a post that is
 * already published (a sitting that joined a session, or one published on its own that a
 * late placement reaches) refreshed like any session post. A draft is still just counted.
 */
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
  v_joined uuid;
  v_count  integer;
  v_type   text;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_batch_note');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  -- Only a title this caller has actually ranked (20261020000100).
  if not exists (
    select 1 from rankings
     where user_id = auth.uid() and media_item_id = p_media_item_id
  ) then
    return _record_operation_result(
      p_operation_id, jsonb_build_object('status', 'not_ranked')
    );
  end if;

  perform _lock_activity_session(auth.uid());

  select j.event_id into v_joined
    from feed_ranking_sitting_joins j
    join feed_events e on e.id = j.event_id and e.type = 'ranking_batch' and e.presented_in is null
   where j.actor_id = auth.uid() and j.sitting = p_sitting;

  if v_joined is not null then
    insert into feed_ranking_titles (event_id, media_item_id)
    values (v_joined, p_media_item_id)
    on conflict (event_id, media_item_id) do nothing;

    if found then
      perform _ranking_batch_absorb(auth.uid(), p_media_item_id, now() - interval '1 hour', now());
    end if;

    perform _session_refresh(v_joined);
    v_count := _group_title_count(v_joined);
    update feed_events
       set payload = payload || jsonb_build_object('count', v_count)
     where id = v_joined;

    return _record_operation_result(
      p_operation_id,
      jsonb_build_object('status', 'ok', 'event_id', v_joined, 'count', v_count, 'joined', true)
    );
  end if;

  insert into feed_events (actor_id, type, media_item_id, payload, causal_at, causal_step)
  values (
    auth.uid(), 'ranking_batch_draft', p_media_item_id,
    jsonb_build_object('sitting', p_sitting::text), now(), 0
  )
  on conflict (actor_id, (payload ->> 'sitting'))
    where type in ('ranking_batch', 'ranking_batch_draft')
    do update set media_item_id = excluded.media_item_id
  returning id, type into v_event, v_type;

  insert into feed_ranking_titles (event_id, media_item_id)
  values (v_event, p_media_item_id)
  on conflict (event_id, media_item_id) do nothing;

  if found then
    perform _ranking_batch_absorb(auth.uid(), p_media_item_id, now() - interval '1 hour', now());
  end if;

  if v_type = 'ranking_batch' then
    -- A sitting already published on its own: its members include the rankings and saves
    -- it presents, not only its own placements.
    perform _session_refresh(v_event);
    v_count := _group_title_count(v_event);
  else
    select count(*) into v_count from feed_ranking_titles where event_id = v_event;
  end if;

  update feed_events
     set payload = payload || jsonb_build_object('count', v_count)
   where id = v_event;

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object('status', 'ok', 'event_id', v_event, 'count', v_count)
  );
end;
$$;

revoke execute on function rank_batch_note(uuid, uuid, uuid) from public, anon;
grant execute on function rank_batch_note(uuid, uuid, uuid) to authenticated;

/**
 * `rank_batch_finalize`, 20261130000800's body with the session rule:
 *
 *   * the open session the sitting joins may be a watchlist post (it becomes a ranking group
 *     in place) as well as a ranking group; the sitting must still have begun inside it;
 *   * a sitting published on its own presents, besides the title-page first rankings of its
 *     half hour, the watchlist posts that began inside its window and lie wholly inside it,
 *     if nothing references them;
 *   * the post it joins or publishes is refreshed: count, newest title, place in the Feed.
 */
create or replace function rank_batch_finalize(p_operation_id uuid, p_sitting uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim   record;
  v_event   uuid;
  v_count   integer;
  v_started timestamptz;
  v_window  interval;
  v_target  uuid;
  v_grouping boolean := false;
  v_adopt   uuid[] := '{}';
  v_saves   uuid[] := '{}';
  v_anchor  timestamptz;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_batch_finalize');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  -- One finaliser per actor at a time, before anything is read, and (20261130000900) no
  -- save deciding about the same window meanwhile.
  perform _lock_activity_session(auth.uid());

  select id into v_event
    from feed_events
   where actor_id = auth.uid()
     and type = 'ranking_batch_draft'
     and payload ->> 'sitting' = p_sitting::text
     for update;

  if v_event is null then
    return _record_operation_result(p_operation_id, jsonb_build_object('status', 'empty'));
  end if;

  select count(*), min(placed_at) into v_count, v_started
    from feed_ranking_titles where event_id = v_event;

  if v_count = 0 then
    delete from feed_events where id = v_event;
    return _record_operation_result(p_operation_id, jsonb_build_object('status', 'empty'));
  end if;

  v_window := _activity_session_window();

  if not exists (
       select 1 from app_config
        where key = 'feed.ranking_grouping_enabled' and value = 'false'::jsonb
     )
     and not exists (select 1 from comments  where feed_event_id = v_event)
     and not exists (select 1 from reactions where feed_event_id = v_event)
  then
    v_grouping := true;
    -- Inside the window from both sides (Codex, PR 311).
    v_target := _open_session(auth.uid(), v_started, 'ranking', true);
  end if;

  if v_target is not null then
    insert into feed_ranking_titles (event_id, media_item_id, placed_at)
    select v_target, frt.media_item_id, frt.placed_at
      from feed_ranking_titles frt
     where frt.event_id = v_event
     order by frt.placed_at, frt.id
    on conflict (event_id, media_item_id) do nothing;

    delete from feed_events where id = v_event;

    insert into feed_ranking_sitting_joins (actor_id, sitting, event_id)
    values (auth.uid(), p_sitting, v_target)
    on conflict (actor_id, sitting) do update set event_id = excluded.event_id;

    -- The post keeps its id and conversation; its members, newest title and place move.
    perform _session_refresh(v_target);
    v_count := _group_title_count(v_target);

    return _record_operation_result(
      p_operation_id,
      jsonb_build_object('status', 'ok', 'event_id', v_target, 'count', v_count, 'joined', true)
    );
  end if;

  if v_grouping
     and not exists (select 1 from app_config
                      where key = 'feed.ranking_backfill_grouping_enabled' and value = 'false'::jsonb)
  then
    perform 1
       from feed_events fe
      where fe.actor_id = auth.uid()
        and fe.type = 'title_ranked'
        and fe.presented_in is null
        and (coalesce((fe.payload ->> 'groupable')::boolean, false)
             or coalesce((fe.payload ->> 'backfill')::boolean, false))
        and fe.created_at > v_started - v_window
        and fe.created_at < v_started + v_window
      order by fe.id
        for update;

    select min(fe.created_at) into v_anchor
      from feed_events fe
     where fe.actor_id = auth.uid()
       and fe.type = 'title_ranked'
       and fe.presented_in is null
       and (coalesce((fe.payload ->> 'groupable')::boolean, false)
            or coalesce((fe.payload ->> 'backfill')::boolean, false))
       and fe.created_at > v_started - v_window
       and fe.created_at < v_started + v_window
       and not coalesce((fe.payload ->> 'update')::boolean, false)
       and not coalesce((fe.payload ->> 'again')::boolean, false)
       and not _feed_event_referenced(fe.id)
       and not exists (select 1 from feed_ranking_titles frt
                        where frt.event_id = v_event and frt.media_item_id = fe.media_item_id);
    v_anchor := least(v_started, v_anchor);

    select coalesce(array_agg(fe.id order by fe.created_at, fe.id), '{}')
      into v_adopt
      from feed_events fe
     where fe.actor_id = auth.uid()
       and fe.type = 'title_ranked'
       and fe.presented_in is null
       and (coalesce((fe.payload ->> 'groupable')::boolean, false)
            or coalesce((fe.payload ->> 'backfill')::boolean, false))
       and fe.created_at >= v_anchor
       and fe.created_at < v_anchor + v_window
       and not coalesce((fe.payload ->> 'update')::boolean, false)
       and not coalesce((fe.payload ->> 'again')::boolean, false)
       and not _feed_event_referenced(fe.id)
       and not exists (select 1 from feed_ranking_titles frt
                        where frt.event_id = v_event and frt.media_item_id = fe.media_item_id);

    /**
     * 20261130000900: the watchlist posts of the same half hour. Only one that began after
     * the window's start (one that began before it would have been the session joined
     * above), that lies wholly inside the window, and that nothing references; it is
     * presented whole, with its own membership, and keeps its id for deep links.
     */
    if _activity_sessions_enabled() then
      perform 1
         from feed_events w
        where w.actor_id = auth.uid()
          and w.type = 'watchlist_added'
          and w.presented_in is null
          and w.payload ? 'count'
          and not (w.payload ? 'consolidation_batch')
          and w.created_at >= v_anchor
          and w.created_at < v_anchor + v_window
        order by w.id
          for update;

      select coalesce(array_agg(w.id order by w.created_at, w.id), '{}')
        into v_saves
        from feed_events w
       where w.actor_id = auth.uid()
         and w.type = 'watchlist_added'
         and w.presented_in is null
         and w.payload ? 'count'
         and not (w.payload ? 'consolidation_batch')
         and coalesce((w.payload ->> 'started_at')::timestamptz, w.created_at) >= v_anchor
         and coalesce((w.payload ->> 'started_at')::timestamptz, w.created_at) < v_anchor + v_window
         and not exists (select 1 from feed_events c where c.presented_in = w.id)
         and not exists (select 1 from feed_watchlist_titles wt
                          where wt.event_id = w.id and wt.added_at >= v_anchor + v_window)
         and not _feed_event_referenced(w.id);
    end if;
  end if;

  update feed_events
     set type = 'ranking_batch',
         causal_at = now(),
         created_at = now(),
         payload = payload || jsonb_build_object('count', v_count,
                                                 'started_at', coalesce(v_anchor, v_started),
                                                 'session', true)
   where id = v_event;

  if cardinality(v_adopt) > 0 or cardinality(v_saves) > 0 then
    update feed_events set presented_in = v_event where id = any (v_adopt || v_saves);
  end if;
  perform _session_refresh(v_event);
  v_count := _group_title_count(v_event);

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object('status', 'ok', 'event_id', v_event, 'count', v_count)
  );
end;
$$;

comment on function rank_batch_finalize(uuid, uuid) is
  'Ends an Unranked sitting. If the sitting began inside the window of the actor''s open '
  'activity session (a ranking group, or a watchlist post that becomes one in place), its '
  'titles join that post, which keeps its id and conversation and moves to its newest '
  'activity; the draft is deleted. Otherwise it publishes the draft, dated now, presenting '
  'the title-page first rankings marked groupable and the unreferenced watchlist posts '
  'inside one window of its start (20261130000200, 20261130000800, 20261130000900). A '
  'sitting is never split. Serialised on the actor''s session keys. Idempotent.';

revoke execute on function rank_batch_finalize(uuid, uuid) from public, anon;
grant execute on function rank_batch_finalize(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. A hidden member that gains a reference
-- ---------------------------------------------------------------------------

/**
 * `_unpresent` (20261128000100) with one change at the end: a session post is refreshed
 * (its count, newest title and kind) rather than having its representative re-picked.
 * It never moves backwards in the Feed. Everything else, the dissolution of an emptied
 * title or history group included, is unchanged.
 */
create or replace function _unpresent(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group  uuid;
  v_g      record;
  v_count  integer;
  v_rep    uuid;
begin
  select presented_in into v_group from feed_events where id = p_event_id;
  if v_group is null then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('feed_group:' || v_group::text, 0));

  perform 1 from feed_events where id in (p_event_id, v_group) order by id for no key update;
  select presented_in into v_group from feed_events where id = p_event_id;
  if v_group is null then
    return;
  end if;

  update feed_events set presented_in = null where id = p_event_id;

  select fe.id, fe.type, fe.media_item_id, fe.payload into v_g from feed_events fe where fe.id = v_group;
  if v_g.type not in ('ranking_batch', 'watchlist_added') then
    return;
  end if;
  v_count := _group_title_count(v_group);

  if v_count <= 1
     and coalesce(v_g.payload ->> 'origin', '') in ('title', 'history')
     and not exists (select 1 from feed_ranking_titles where event_id = v_group)
     and not exists (select 1 from feed_watchlist_titles where event_id = v_group)
     and not _feed_event_referenced(v_group) then
    update feed_events set presented_in = null where presented_in = v_group;
    update feed_events
       set presented_in = p_event_id,
           payload = payload || jsonb_build_object('count', 0, 'dissolved', true)
     where id = v_group;
    return;
  end if;

  if coalesce((v_g.payload ->> 'session')::boolean, false) then
    perform _session_refresh(v_group);
    return;
  end if;

  select gt.media_item_id into v_rep
    from _group_titles(v_group) gt
   order by (gt.media_item_id = v_g.media_item_id) desc, gt.joined_at, gt.tiebreak
   limit 1;
  update feed_events
     set payload = payload || jsonb_build_object('count', v_count),
         media_item_id = coalesce(v_rep, media_item_id)
   where id = v_group;
end;
$$;

revoke execute on function _unpresent(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. The readers: newest first, each member with its own action
-- ---------------------------------------------------------------------------

/**
 * `ranking_batch_titles`, newest first, with each member's `action` and `acted_at`. A saved
 * member has no position, score or ladder: its row is a save, not a standing. Dropped and
 * recreated because the return type gains two trailing columns; an older client reads the
 * columns it knows by name and is unaffected.
 */
drop function if exists ranking_batch_titles(uuid);
create function ranking_batch_titles(p_event_id uuid)
returns table (
  media_item_id uuid,
  title         text,
  poster_path   text,
  "position"    integer,
  score         numeric,
  bucket        taste_bucket,
  category      ranking_category,
  action        text,
  acted_at      timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with post as (
    select fe.id, fe.actor_id
      from feed_events fe
     where fe.id = p_event_id
       and fe.type = 'ranking_batch'
       and fe.presented_in is null
       and can_view_profile(auth.uid(), fe.actor_id)
  ),
  mine as (
    select gm.acted_at, gm.last_tiebreak, gm.action, mi.id, mi.title, mi.poster_path,
           r.position, r.category, r.bucket, p.actor_id
      from post p
      cross join lateral _group_members(p.id) gm
      join media_items mi  on mi.id = gm.media_item_id
      left join rankings r on gm.action = 'ranked'
                          and r.user_id = p.actor_id and r.media_item_id = mi.id
  ),
  bands as (
    select d.category, d.bucket, bb.lo, bb.size
      from (select distinct actor_id, category, bucket from mine where category is not null) d
      cross join lateral band_bounds(d.actor_id, d.category, d.bucket) bb
  )
  select m.id, m.title, m.poster_path, m.position,
         case when m.position is null or b.lo is null then null
              else score_for(m.bucket, (m.position - b.lo + 1)::integer, b.size) end,
         m.bucket, m.category, m.action, m.acted_at
    from mine m
    left join bands b on b.category = m.category and b.bucket = m.bucket
   order by m.acted_at desc, m.last_tiebreak desc, m.title;
$$;

revoke execute on function ranking_batch_titles(uuid) from public, anon;
grant execute on function ranking_batch_titles(uuid) to authenticated;

/** `watchlist_group_titles`, newest first. Same columns. */
create or replace function watchlist_group_titles(p_event_id uuid)
returns table (
  media_item_id uuid,
  kind          media_kind,
  title         text,
  season_number integer,
  release_date  date,
  poster_path   text,
  parent_title  text,
  ordinal       integer
)
language sql
stable
security definer
set search_path = public
as $$
  select mi.id, mi.kind, mi.title, mi.season_number, mi.release_date, mi.poster_path,
         parent.title,
         (row_number() over (order by gm.acted_at desc, gm.last_tiebreak desc, mi.id))::integer
    from feed_events fe
    cross join lateral _group_members(fe.id) gm
    join media_items mi           on mi.id = gm.media_item_id
    left join media_items parent  on parent.id = mi.parent_id
   where fe.id = p_event_id
     and fe.type = 'watchlist_added'
     and fe.presented_in is null
     and auth.uid() is not null
     and can_view_profile(auth.uid(), fe.actor_id)
   order by gm.acted_at desc, gm.last_tiebreak desc, mi.id;
$$;

revoke execute on function watchlist_group_titles(uuid) from public, anon;
grant execute on function watchlist_group_titles(uuid) to authenticated;

/**
 * `feed_group_previews`, newest first, each member with its `action` and `acted_at`. A
 * ranked member carries the author's current score on its own ladder; a saved one carries
 * none (`ranked` false), whatever the author did with the title since. Same arguments and
 * grants; two trailing columns.
 */
drop function if exists feed_group_previews(uuid[], integer);
create function feed_group_previews(p_event_ids uuid[], p_limit integer default 12)
returns table (
  event_id      uuid,
  ordinal       integer,
  media_item_id uuid,
  kind          media_kind,
  title         text,
  season_number integer,
  release_date  date,
  poster_path   text,
  parent_title  text,
  score         numeric,
  ranked        boolean,
  action        text,
  acted_at      timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select greatest(1, least(coalesce(p_limit, 12), 20)) as lim
  ),
  posts as (
    select fe.id, fe.type, fe.actor_id
      from feed_events fe
     where fe.id = any ((coalesce(p_event_ids, '{}'::uuid[]))[1:50])
       and fe.type in ('watchlist_added', 'ranking_batch')
       and fe.presented_in is null
       and auth.uid() is not null
       and can_view_profile(auth.uid(), fe.actor_id)
  ),
  members as (
    select p.id as event_id, p.actor_id, gm.media_item_id, gm.action, gm.acted_at,
           (row_number() over (partition by p.id
                               order by gm.acted_at desc, gm.last_tiebreak desc, gm.media_item_id))::integer
             as ordinal
      from posts p
      cross join lateral _group_members(p.id) gm
  ),
  shown as (
    select m.*, r.position, r.category, r.bucket
      from members m
      left join rankings r
        on m.action = 'ranked' and r.user_id = m.actor_id and r.media_item_id = m.media_item_id
     where m.ordinal <= (select lim from params)
  ),
  bands as (
    select d.actor_id, d.category, d.bucket, bb.lo, bb.size
      from (select distinct actor_id, category, bucket from shown where category is not null) d
      cross join lateral band_bounds(d.actor_id, d.category, d.bucket) bb
  )
  select s.event_id, s.ordinal, mi.id, mi.kind, mi.title, mi.season_number,
         mi.release_date, mi.poster_path, parent.title,
         case when s.position is null or b.lo is null then null
              else score_for(s.bucket, (s.position - b.lo + 1)::integer, b.size) end,
         s.position is not null,
         s.action, s.acted_at
    from shown s
    join media_items mi          on mi.id = s.media_item_id
    left join media_items parent on parent.id = mi.parent_id
    left join bands b
      on b.actor_id = s.actor_id and b.category = s.category and b.bucket = s.bucket
   order by s.event_id, s.ordinal;
$$;

comment on function feed_group_previews(uuid[], integer) is
  'Feed poster rails (20261127000100, 20261130000900): up to p_limit (default 12, max 20) '
  'members of each grouped watchlist_added / ranking_batch post among p_event_ids (max 50), '
  'newest first, each with its action (ranked / saved) and time, gated per post on '
  'can_view_profile(auth.uid(), actor). A ranked member carries the author''s current score '
  'on its own ladder; a saved one none. Read-only.';

revoke execute on function feed_group_previews(uuid[], integer) from public, anon;
grant execute on function feed_group_previews(uuid[], integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. A catalogue delete keeps a session's count true
-- ---------------------------------------------------------------------------

/**
 * `_watchlist_group_keeps_its_post` (20261125000100) for every grouped post, not only a
 * watchlist one (Codex, PR 354): a session's representative is its newest title, which may be
 * a ranking with no watchlist membership, and `feed_events.media_item_id` cascades, so
 * deleting that title from the catalogue would take the whole post and its conversation. Every
 * post the title is a member of is found, by every path `_group_members` reads (watchlist and
 * ranking membership, its own or a presented post's, a presented ranking, and the
 * representative), hidden ones included, and each is put right before the cascades run,
 * hidden ones before the sessions that present them: a session post is
 * refreshed from its surviving members (`_session_refresh(post, old.id)`), any other group
 * takes its first surviving member as representative and is recounted. A post with no
 * surviving member is left to the cascade, as before.
 */
create or replace function _watchlist_group_keeps_its_post()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group record;
  v_next  uuid;
begin
  for v_group in
    with touched as (
      select wt.event_id from feed_watchlist_titles wt where wt.media_item_id = old.id
      union
      select frt.event_id from feed_ranking_titles frt where frt.media_item_id = old.id
      union
      select fe.id from feed_events fe where fe.media_item_id = old.id
      union
      -- A presented post (or ranking) holding the title: its group.
      select fe.presented_in from feed_events fe
       where fe.presented_in is not null
         and (fe.media_item_id = old.id
              or exists (select 1 from feed_watchlist_titles wt
                          where wt.event_id = fe.id and wt.media_item_id = old.id)
              or exists (select 1 from feed_ranking_titles frt
                          where frt.event_id = fe.id and frt.media_item_id = old.id))
    )
    select g.id as event_id, g.actor_id
      from touched t
      join feed_events g on g.id = t.event_id
     where g.type in ('ranking_batch', 'watchlist_added')
     -- Hidden posts first (Codex, PR 354): a post presented by a session owns its own
     -- membership, so it keeps its surviving members (and its row) through the cascade, and
     -- its visible session is then refreshed over them.
     order by (g.presented_in is null), g.id
  loop
    perform _lock_activity_session(v_group.actor_id);
    perform 1 from feed_events where id = v_group.event_id for update;

    select gm.media_item_id
      into v_next
      from _group_members(v_group.event_id) gm
      join media_items mi on mi.id = gm.media_item_id
     where gm.media_item_id <> old.id
     order by gm.acted_at desc, gm.last_tiebreak desc
     limit 1;

    if v_next is null then
      continue;
    end if;

    -- A session post's whole summary (Codex, PR 354): newest title, its action, the split,
    -- the kind, from the surviving members.
    if exists (select 1 from feed_events
                where id = v_group.event_id and coalesce((payload ->> 'session')::boolean, false)) then
      perform _session_refresh(v_group.event_id, old.id);
      continue;
    end if;

    update feed_events fe
       set media_item_id = case when fe.media_item_id = old.id then v_next
                                else fe.media_item_id end,
           payload = case when fe.payload ? 'count'
                          then fe.payload || jsonb_build_object('count', (
                                 select count(*)
                                   from _group_members(v_group.event_id) gm
                                   join media_items mi on mi.id = gm.media_item_id
                                  where gm.media_item_id <> old.id))
                          else fe.payload end
     where fe.id = v_group.event_id;
  end loop;

  return old;
end;
$$;

revoke all on function _watchlist_group_keeps_its_post() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. Historical consolidation into sessions (operator-only, inert, reversible)
-- ---------------------------------------------------------------------------
--
-- See docs/feed/activity-sessions.md, "Historical consolidation". Nothing here runs unless
-- an operator calls it; no client role may.

alter table feed_consolidation_log add column if not exists kind text not null default 'family';
alter table feed_consolidation_log add column if not exists prior_type text;
alter table feed_consolidation_log add column if not exists prior_media_item_id uuid;
alter table feed_consolidation_log add column if not exists prior_causal_at timestamptz;
alter table feed_consolidation_log add column if not exists prior_causal_step integer;
alter table feed_consolidation_log add column if not exists prior_presented_in uuid;

comment on column feed_consolidation_log.kind is
  '''family'' for consolidate_feed_history (20261128000100), ''session'' for '
  'consolidate_feed_sessions (20261130000900), whose rows also carry the prior state of '
  'every row they changed.';

/**
 * The plan, as rows: one per unit (a visible post the consolidation may fold), with its
 * window. Pure read; `consolidate_feed_sessions` applies it, and
 * docs/feed/session-consolidation-candidates.sql inlines the same query for a read-only dry
 * run where this function does not exist yet.
 *
 * Units, per actor, whose first activity falls in [p_since, p_until):
 *   ranking  a visible first-time `title_ranked` (not update, not again) that nothing
 *            references; excluded when its title carries a published review unless
 *            `p_include_reviewed` (a founder decision; off by default)
 *   save     a visible single `watchlist_added`, referenced or not
 *   group    a visible `ranking_batch` or a `watchlist_added` holding more than one title
 *            (or presenting a post), referenced or not, spanning its members' times
 * A referenced ranking is not a unit at all (it keeps its card). A referenced save or group
 * may be a session's post but is never hidden.
 *
 * Windows are fixed at `p_window_minutes` from the first unit; a unit joins while its last
 * activity is inside the window. A window with two or more units is a planned session.
 */
create or replace function _session_consolidation_plan(
  p_since            timestamptz,
  p_until            timestamptz,
  p_actor            uuid default null,
  p_include_reviewed boolean default false,
  p_window_minutes   integer default 30
)
returns table (
  actor_id     uuid,
  window_start timestamptz,
  unit_id      uuid,
  unit_kind    text,
  unit_type    text,
  started      timestamptz,
  ended        timestamptz,
  referenced   boolean,
  titles       integer
)
language sql
stable
security definer
set search_path = public
as $$
  with recursive params as (
    select make_interval(mins => greatest(1, coalesce(p_window_minutes, 30))) as win
  ),
  scope as (
    select e.*
      from feed_events e
     where e.created_at >= p_since - interval '1 day' and e.created_at < p_until + interval '1 day'
       and (p_actor is null or e.actor_id = p_actor)
       and e.presented_in is null
       and e.type in ('watchlist_added', 'title_ranked', 'ranking_batch')
       and not coalesce((e.payload ->> 'dissolved')::boolean, false)
  ),
  units as (
    select s.actor_id, s.id as unit_id,
           case when s.type = 'title_ranked' then 'ranking'
                when s.type = 'watchlist_added'
                     and coalesce((s.payload ->> 'count')::integer, 1) <= 1
                     and not exists (select 1 from feed_events c where c.presented_in = s.id)
                  then 'save'
                else 'group' end as unit_kind,
           s.type as unit_type,
           case when s.type = 'title_ranked' then s.created_at
                else coalesce((select min(gm.first_at) from _group_members(s.id) gm), s.created_at) end as started,
           case when s.type = 'title_ranked' then s.created_at
                else coalesce((select max(gm.acted_at) from _group_members(s.id) gm), s.created_at) end as ended,
           _feed_event_referenced(s.id) as referenced,
           case when s.type = 'title_ranked' then 1
                else (select count(*)::integer from _group_members(s.id)) end as titles
      from scope s
     where s.media_item_id is not null
       and (s.type <> 'title_ranked'
            or (not coalesce((s.payload ->> 'update')::boolean, false)
                and not coalesce((s.payload ->> 'again')::boolean, false)
                and not _feed_event_referenced(s.id)
                and not exists (select 1 from feed_events c where c.presented_in = s.id)
                and (p_include_reviewed or not _feed_title_reviewed(s.actor_id, s.media_item_id))))
  ),
  bounded as (
    select u.*, row_number() over (partition by u.actor_id order by u.started, u.unit_id) as rn
      from units u
     where u.started >= p_since and u.started < p_until and u.titles > 0
  ),
  windows as (
    select b.actor_id, b.rn, b.unit_id, b.started as window_start
      from bounded b where b.rn = 1
    union all
    select n.actor_id, n.rn, n.unit_id,
           case when n.ended < w.window_start + (select win from params) then w.window_start
                else n.started end
      from windows w
      join bounded n on n.actor_id = w.actor_id and n.rn = w.rn + 1
  ),
  sized as (
    select w.*, count(*) over (partition by w.actor_id, w.window_start) as units_in_window
      from windows w
  )
  select b.actor_id, s.window_start, b.unit_id, b.unit_kind, b.unit_type, b.started, b.ended,
         b.referenced, b.titles
    from sized s
    join bounded b on b.unit_id = s.unit_id
   where s.units_in_window >= 2
   order by b.actor_id, s.window_start, b.started, b.unit_id;
$$;

revoke execute on function _session_consolidation_plan(timestamptz, timestamptz, uuid, boolean, integer)
  from public, anon, authenticated;

/**
 * Folds each planned window into one session post. Operator-only; dry run unless
 * `p_apply`. Bounded: at most 8 days, ending at least one window ago (history only: an open
 * window belongs to the live writers), at most `p_max_sessions` sessions per call, and one
 * account when `p_actor` is given (the first small batch). Logged per row under `p_batch`
 * (kind `session`) with every row's prior state, so `revert_feed_session_consolidation`
 * puts it all back.
 *
 * Per window: the post is the referenced unit if there is one (the earliest, if several;
 * other referenced units stay as they are), else the largest group, else the earliest save,
 * else a new ranking group at the window's first activity. Every other unit is hidden
 * behind it (`presented_in`), and a hidden group's own hidden members are re-pointed to the
 * post, so every stale link resolves in one hop (`feed_event_presentation`). The post is then
 * refreshed: newest title, counts, kind, and its place at its newest activity. No row is
 * deleted, no notification is written, and nothing a reader could not see before becomes
 * visible: the post is the same author's, read through the same `can_view_profile` gate.
 */
create or replace function consolidate_feed_sessions(
  p_batch            text,
  p_since            timestamptz,
  p_until            timestamptz,
  p_apply            boolean default false,
  p_actor            uuid default null,
  p_include_reviewed boolean default false,
  p_max_sessions     integer default 25,
  p_window_minutes   integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window   record;
  v_units    record;
  v_post     uuid;
  v_created  boolean;
  v_prior    record;
  v_done     integer := 0;
  v_hidden   integer := 0;
  v_repointed integer := 0;
  v_skipped  integer := 0;
  v_planned  jsonb;
  v_excluded jsonb;
  v_sessions jsonb := '[]'::jsonb;
  v_ids      uuid[];
  v_live     uuid[];
  v_first    record;
  v_n        integer;
begin
  if p_batch is null or length(p_batch) < 3 then
    raise exception 'a batch name is required' using errcode = '22023';
  end if;
  if p_until <= p_since or p_until - p_since > interval '8 days' then
    raise exception 'the range must be positive and at most 8 days' using errcode = '22023';
  end if;
  if p_apply and exists (select 1 from feed_consolidation_log where batch = p_batch) then
    raise exception 'batch % already applied', p_batch using errcode = '23505';
  end if;
  -- History only: a window that may still be open belongs to the live writers.
  if p_apply and p_until > now() - make_interval(mins => greatest(1, coalesce(p_window_minutes, 30))) then
    raise exception 'the range must end at least one window ago' using errcode = '22023';
  end if;

  create temporary table if not exists _session_plan (
    actor_id uuid, window_start timestamptz, unit_id uuid, unit_kind text, unit_type text,
    started timestamptz, ended timestamptz, referenced boolean, titles integer
  ) on commit drop;
  truncate _session_plan;
  insert into _session_plan
  select * from _session_consolidation_plan(p_since, p_until, p_actor, p_include_reviewed,
                                            p_window_minutes);

  select jsonb_build_object(
           'sessions', count(distinct (actor_id, window_start)),
           'units', count(*),
           'actors', count(distinct actor_id),
           'by_kind', jsonb_build_object(
             'ranking', count(*) filter (where unit_kind = 'ranking'),
             'save', count(*) filter (where unit_kind = 'save'),
             'group', count(*) filter (where unit_kind = 'group')),
           'referenced_units', count(*) filter (where referenced),
           'cards_before', count(*),
           'cards_after', count(distinct (actor_id, window_start))
             + count(*) filter (where referenced)
             - count(distinct (actor_id, window_start)) filter (where referenced))
    into v_planned
    from _session_plan;

  -- What was left alone, and why (posts whose first activity is in range).
  select jsonb_build_object(
           'with_comments', count(*) filter (where exists (select 1 from comments c where c.feed_event_id = e.id)),
           'with_reactions', count(*) filter (where exists (select 1 from reactions r where r.feed_event_id = e.id)),
           'notification_refs', count(*) filter (where exists (select 1 from notifications n
                                                   where n.subject_type = 'feed_event' and n.subject_id = e.id)),
           'proactive_refs', count(*) filter (where exists (select 1 from proactive_cluster_actors pa
                                                   where pa.feed_event_id = e.id)),
           'award_causes', count(*) filter (where exists (select 1 from feed_event_causes fc
                                                   where fc.feed_event_id = e.id)),
           'reviewed_rankings', count(*) filter (where e.type = 'title_ranked'
                                                   and _feed_title_reviewed(e.actor_id, e.media_item_id)),
           'rewatch_or_update', count(*) filter (where e.type = 'title_ranked'
                                                   and (coalesce((e.payload ->> 'update')::boolean, false)
                                                        or coalesce((e.payload ->> 'again')::boolean, false))))
    into v_excluded
    from feed_events e
   where e.created_at >= p_since and e.created_at < p_until
     and (p_actor is null or e.actor_id = p_actor)
     and e.presented_in is null
     and e.type in ('watchlist_added', 'title_ranked', 'ranking_batch');

  if p_apply then
    for v_window in
      select p.actor_id, p.window_start
        from _session_plan p
       group by p.actor_id, p.window_start
       order by p.actor_id, p.window_start
    loop
      exit when v_done >= greatest(1, coalesce(p_max_sessions, 25));
      perform _lock_activity_session(v_window.actor_id);

      select array_agg(p.unit_id order by p.unit_id) into v_ids
        from _session_plan p
       where p.actor_id = v_window.actor_id and p.window_start = v_window.window_start;
      perform 1 from feed_events where id = any (v_ids) order by id for update;

      -- Re-read under the locks: still visible, and a ranking still unreferenced.
      select array_agg(fe.id order by fe.id) into v_live
        from feed_events fe
       where fe.id = any (v_ids) and fe.presented_in is null
         and (fe.type <> 'title_ranked' or not _feed_event_referenced(fe.id));
      if coalesce(array_length(v_live, 1), 0) < 2 then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      -- The post: a referenced unit, else the largest group, else the earliest save.
      v_post := null;
      v_created := false;
      select p.unit_id into v_post
        from _session_plan p
       where p.unit_id = any (v_live) and p.unit_kind <> 'ranking'
       order by _feed_event_referenced(p.unit_id) desc,
                case when _feed_event_referenced(p.unit_id) then p.started end,
                (p.unit_kind = 'group') desc, p.titles desc, p.started, p.unit_id
       limit 1;

      if v_post is null then
        -- Rankings only: a new group at the window's first activity, as consolidation and
        -- the title-page note have always made one.
        select fe.* into v_first from feed_events fe
         where fe.id = any (v_live) order by fe.created_at, fe.id limit 1;
        insert into feed_events (actor_id, type, media_item_id, payload, created_at, causal_at, causal_step)
        values (v_first.actor_id, 'ranking_batch', v_first.media_item_id,
                jsonb_build_object('count', 0, 'origin', 'history', 'session', true,
                                   'started_at', v_window.window_start,
                                   'consolidation_batch', p_batch),
                v_first.created_at, v_first.causal_at, 0)
        returning id into v_post;
        v_created := true;
      end if;

      select fe.type, fe.media_item_id, fe.payload, fe.causal_at, fe.causal_step into v_prior
        from feed_events fe where fe.id = v_post;
      insert into feed_consolidation_log
        (batch, kind, group_event_id, member_event_id, created_group, prior_payload, prior_type,
         prior_media_item_id, prior_causal_at, prior_causal_step)
      values (p_batch, 'session', v_post, null, v_created, v_prior.payload, v_prior.type,
              v_prior.media_item_id, v_prior.causal_at, v_prior.causal_step);

      -- Hide every other unreferenced unit, flattening a hidden group's own members.
      for v_units in
        select fe.id, fe.type from feed_events fe
         where fe.id = any (v_live) and fe.id <> v_post
           and not (fe.type <> 'title_ranked' and _feed_event_referenced(fe.id))
         order by fe.id
      loop
        insert into feed_consolidation_log
          (batch, kind, group_event_id, member_event_id, created_group, prior_presented_in)
        select p_batch, 'session', v_post, c.id, v_created, c.presented_in
          from feed_events c where c.presented_in = v_units.id;
        get diagnostics v_n = row_count;
        update feed_events set presented_in = v_post where presented_in = v_units.id;
        v_repointed := v_repointed + v_n;

        insert into feed_consolidation_log
          (batch, kind, group_event_id, member_event_id, created_group, prior_presented_in)
        values (p_batch, 'session', v_post, v_units.id, v_created, null);
        update feed_events set presented_in = v_post where id = v_units.id;
        v_hidden := v_hidden + 1;
      end loop;

      update feed_events
         set payload = payload || jsonb_build_object('session', true,
                                                     'consolidation_batch', p_batch,
                                                     'started_at', coalesce(payload -> 'started_at',
                                                                            to_jsonb(v_window.window_start)))
       where id = v_post;
      perform _session_refresh(v_post);
      v_done := v_done + 1;
      v_sessions := v_sessions || jsonb_build_object('post', v_post, 'created', v_created);
    end loop;
  end if;

  return jsonb_build_object(
    'batch', p_batch,
    'applied', p_apply,
    'since', p_since,
    'until', p_until,
    'actor_scoped', p_actor is not null,
    'include_reviewed', p_include_reviewed,
    'planned', v_planned,
    'excluded', v_excluded,
    'applied_sessions', v_done,
    'skipped_sessions', v_skipped,
    'hidden_posts', v_hidden,
    'repointed_members', v_repointed,
    'posts', v_sessions
  );
end;
$$;

/**
 * Undoes one session batch, newest log rows first: every row it hid or re-pointed points
 * where it pointed before (unless a reference has since restored it), a post it created is
 * deleted unless somebody has since reacted to or commented on it (then it is kept, its
 * members stay behind it, and it is reported), and a post it reused gets back its prior
 * type, title, payload and place.
 */
create or replace function revert_feed_session_consolidation(p_batch text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_g        record;
  v_kept     uuid[] := '{}';
  v_deleted  integer := 0;
  v_restored integer := 0;
  v_shown    integer := 0;
  v_n        integer;
  v_cur      record;
  v_media    uuid;
  v_type     text;
  v_retitled uuid[] := '{}';
begin
  for v_g in
    select l.group_event_id, l.created_group, l.prior_payload, l.prior_type,
           l.prior_media_item_id, l.prior_causal_at, l.prior_causal_step, fe.actor_id
      from feed_consolidation_log l
      join feed_events fe on fe.id = l.group_event_id
     where l.batch = p_batch and l.kind = 'session' and l.member_event_id is null
     order by l.id desc
  loop
    perform _lock_activity_session(v_g.actor_id);
    perform 1 from feed_events where id = v_g.group_event_id for update;
    if v_g.created_group and _feed_event_referenced(v_g.group_event_id) then
      v_kept := v_kept || v_g.group_event_id;
      continue;
    end if;

    update feed_events fe set presented_in = l.prior_presented_in
      from feed_consolidation_log l
     where l.batch = p_batch and l.kind = 'session' and l.group_event_id = v_g.group_event_id
       and l.member_event_id = fe.id and fe.presented_in = v_g.group_event_id;
    get diagnostics v_n = row_count;
    v_shown := v_shown + v_n;

    if v_g.created_group then
      delete from feed_events where id = v_g.group_event_id;
      v_deleted := v_deleted + 1;
    else
      /**
       * The prior title may have left the catalogue since (Codex, PR 354): the delete trigger
       * kept the post on a surviving member, and restoring a dangling id would abort the whole
       * revert. Such a post keeps its current title, and keeps its current kind too when the
       * prior kind could not carry that title (`feed_events_watchlist_once`).
       */
      select fe.type, fe.media_item_id into v_cur from feed_events fe where fe.id = v_g.group_event_id;
      v_media := case when exists (select 1 from media_items mi where mi.id = v_g.prior_media_item_id)
                      then v_g.prior_media_item_id else v_cur.media_item_id end;
      v_type := v_g.prior_type;
      if v_media is distinct from v_g.prior_media_item_id then
        v_retitled := v_retitled || v_g.group_event_id;
        if v_type = 'watchlist_added' and exists (
             select 1 from feed_events o
              where o.actor_id = v_g.actor_id and o.type = 'watchlist_added'
                and o.media_item_id = v_media and o.id <> v_g.group_event_id) then
          v_type := v_cur.type;
        end if;
      end if;
      update feed_events
         set type = v_type,
             media_item_id = v_media,
             payload = v_g.prior_payload,
             causal_at = v_g.prior_causal_at,
             causal_step = v_g.prior_causal_step
       where id = v_g.group_event_id;
      v_restored := v_restored + 1;
    end if;
  end loop;

  delete from feed_consolidation_log
   where batch = p_batch and kind = 'session' and not (group_event_id = any (v_kept));

  return jsonb_build_object('batch', p_batch, 'deleted_posts', v_deleted,
                            'restored_posts', v_restored, 'rows_restored', v_shown,
                            'kept_with_conversation', to_jsonb(v_kept),
                            'restored_on_a_surviving_title', to_jsonb(v_retitled));
end;
$$;

revoke execute on function consolidate_feed_sessions(text, timestamptz, timestamptz, boolean, uuid, boolean, integer, integer)
  from public, anon, authenticated;
revoke execute on function revert_feed_session_consolidation(text) from public, anon, authenticated;
