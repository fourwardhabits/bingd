-- Rollback of 20261130001000 (two posts per shared window; the historical split).
--
-- Rehearsed by supabase/tests/session-split-rollback.test.mjs. Run as one transaction; the
-- operator deletes the `schema_migrations` row for 20261130001000 in the same transaction.
--
-- It restores, word for word, the 20261130000900 bodies of the writers this migration
-- replaced (`_open_session`, `rank_group_note`, `_post_watchlist_activity`,
-- `rank_batch_finalize`) and of the session consolidation it retired, with their comments
-- and grants; drops the shared-window helpers and the split; and removes the setting and the
-- log columns it added. Posts formed meanwhile stay as they are (two posts read as two
-- posts under 20261130000900 too); it unhides, re-dates and deletes nothing.
--
-- It refuses while a split batch is logged: revert those first (`revert_session_split`).

do $guard$
begin
  if exists (select 1 from feed_consolidation_log where kind = 'split') then
    raise exception 'split batches are still logged; revert them with revert_session_split first'
      using errcode = '55000';
  end if;
end
$guard$;

drop function if exists revert_session_split(text);
drop function if exists split_mixed_sessions(text, timestamptz, timestamptz, boolean, uuid, integer);
drop function if exists _session_split_plan(timestamptz, timestamptz, uuid);

-- _open_session, as 20261130000900 left it.
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


-- rank_group_note, as 20261130000900 left it.
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


-- _post_watchlist_activity, as 20261130000900 left it.
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


-- rank_batch_finalize, as 20261130000900 left it.
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


-- consolidate_feed_sessions, as 20261130000900 left it.
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


revoke execute on function consolidate_feed_sessions(text, timestamptz, timestamptz, boolean, uuid, boolean, integer, integer)
  from public, anon, authenticated;


-- revert_feed_session_consolidation, as 20261130000900 left it.
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


revoke execute on function revert_feed_session_consolidation(text) from public, anon, authenticated;


drop function if exists _claim_window_start(uuid, timestamptz, text);
drop function if exists _window_anchor(uuid, timestamptz, text);
drop function if exists _window_posts(uuid, timestamptz, text);

alter table feed_consolidation_log drop column if exists split_role;
alter table feed_consolidation_log drop column if exists member_table;
alter table feed_consolidation_log drop column if exists member_row_id;
alter table feed_consolidation_log drop column if exists member_row_key;
alter table feed_consolidation_log drop column if exists prior_event_id;
comment on column feed_consolidation_log.kind is
  '''family'' for consolidate_feed_history (20261128000100), ''session'' for '
  'consolidate_feed_sessions (20261130000900), whose rows also carry the prior state of '
  'every row they changed.';

delete from app_config where key = 'feed.session_consolidation_enabled';
