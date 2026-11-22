-- Two posts per shared half hour; reviews do not group (founder, 2026-11-22). Corrects
-- 20261130000900, whose mixed session post the founder has replaced with this rule.
--
-- ---------------------------------------------------------------------------
-- THE RULE
-- ---------------------------------------------------------------------------
--
-- Per author there is one fixed window of `feed.ranking_group_minutes` (30), anchored at
-- the first qualifying event of EITHER kind (a first-time ranking, reviewed or not, or a
-- watchlist save) and shared by both. Switching between ranking and saving never restarts
-- it; the next qualifying event at or after the anchor + 30:00 starts the next window.
--
-- Inside one window there are at most two posts, one per category:
--
--   * the ranking post: a `ranking_batch` (or a single `title_ranked` until a second ranking
--     arrives), holding rankings only;
--   * the watchlist post: a `watchlist_added` (a single save until a second one arrives),
--     holding saves only.
--
--     3:00 rank A · 3:04 save B · 3:07 save C · 3:10 rank D · 3:14 save E · 3:18 rank F
--       ->  "ranked F + 2 more" (F, D, A)  and  "added E + 2 more to their watchlist" (E, C, B)
--
-- Both posts record the window's anchor as `payload.started_at`; each moves forward on
-- `causal_at` to its own category's latest activity, newest first within it, as in
-- 20261130000900. A title saved and then ranked in one window is in each category's post
-- (two activities), never twice in one. Engagement, ids, deep links, privacy and the
-- silence of growth (no notification; a post grows by UPDATE) are unchanged.
--
-- Reviews play no part: a first ranking joins its ranking post whether or not it has a
-- review. `_feed_title_reviewed` keeps one operator-only use (the consolidation plan's
-- founder flag); no forward writer calls it.
--
-- ---------------------------------------------------------------------------
-- WHAT CHANGES
-- ---------------------------------------------------------------------------
--
--   * new `_window_posts`, `_window_anchor`, `_claim_window_start`: the shared window;
--   * `_open_session` returns the event's own category only;
--   * `rank_group_note`, `_post_watchlist_activity`, `rank_batch_finalize`: per category,
--     anchored on the shared window; no save joins a ranking post and no ranking a
--     watchlist post; a sitting no longer presents watchlist posts;
--   * `consolidate_feed_sessions` (which builds mixed posts) refuses to apply unless
--     `feed.session_consolidation_enabled` is true; it is seeded false;
--   * `revert_feed_session_consolidation` refuses a batch whose posts a split still holds;
--   * the historical correction, inert and operator-only: `split_mixed_sessions`,
--     `revert_session_split`, `_session_split_plan` (log kind `split`).
--
-- Every signature is unchanged; the readers are unchanged (a pure post reads as one
-- category, and a legacy mixed post reads as before until it is split). No client call
-- changes. Rollback: docs/release/session-split/rollback-20261130001000.sql, rehearsed by
-- supabase/tests/session-split-rollback.test.mjs.

insert into app_config (key, value) values
  ('feed.session_consolidation_enabled', 'false'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. The shared window
-- ---------------------------------------------------------------------------

/**
 * The actor's visible rows that open or hold a window, created after `p_since`, with the
 * window's anchor (`payload.started_at`, else the row's own time) and category:
 *
 *   * a `ranking_batch` with a start, a `watchlist_added` with a count;
 *   * a first-time `title_ranked` marked by its note (`groupable`) or a backfill, still on
 *     its own.
 *
 * History groups (`consolidation_batch`) and dissolved groups are not windows. With
 * `feed.activity_sessions_enabled` false only the event's own category opens a window (the
 * 20261130000800 behaviour). A row's anchor is never after its creation, so `p_since` of
 * the event's time minus one window finds every window that can hold it.
 */
create or replace function _window_posts(p_actor uuid, p_since timestamptz, p_family text)
returns table (event_id uuid, anchor timestamptz, family text, event_type text)
language sql
stable
security definer
set search_path = public
as $$
  select e.id,
         coalesce((e.payload ->> 'started_at')::timestamptz, e.created_at),
         case when e.type = 'watchlist_added' then 'watchlist' else 'ranking' end,
         e.type
    from feed_events e
   where e.actor_id = p_actor
     and e.presented_in is null
     and e.created_at > p_since
     and not (e.payload ? 'consolidation_batch')
     and not coalesce((e.payload ->> 'dissolved')::boolean, false)
     and ((e.type = 'ranking_batch' and e.payload ? 'started_at')
          or (e.type = 'watchlist_added' and e.payload ? 'count')
          or (e.type = 'title_ranked'
              and (coalesce((e.payload ->> 'groupable')::boolean, false)
                   or coalesce((e.payload ->> 'backfill')::boolean, false))
              and not coalesce((e.payload ->> 'update')::boolean, false)
              and not coalesce((e.payload ->> 'again')::boolean, false)))
     and (_activity_sessions_enabled()
          or (case when e.type = 'watchlist_added' then 'watchlist' else 'ranking' end) = p_family);
$$;

/** The anchor of the window holding `p_at`, or null when `p_at` starts a new one. */
create or replace function _window_anchor(p_actor uuid, p_at timestamptz, p_family text)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select max(w.anchor)
    from _window_posts(p_actor, p_at - _activity_session_window(), p_family) w
   where w.anchor <= p_at
     and p_at < w.anchor + _activity_session_window();
$$;

/**
 * The window an event at `p_at` belongs to, for a writer that may arrive late.
 *
 * A ranking's note is sent without waiting, and an Unranked sitting is published at its
 * end: either can reach the server after a later event has already opened a window. When
 * no window holds `p_at` but one opened after it, within one window of it, this event is
 * that window's first: its anchor moves back to `p_at` on every row that carries it, but
 * only if every member of those rows still lies inside one window of `p_at`; otherwise it
 * stays where it is and the event opens its own. Returns the anchor, or null for a new
 * window. Callers hold the actor's session keys.
 */
create or replace function _claim_window_start(p_actor uuid, p_at timestamptz, p_family text)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window interval := _activity_session_window();
  v_anchor timestamptz;
  v_later  timestamptz;
begin
  v_anchor := _window_anchor(p_actor, p_at, p_family);
  if v_anchor is not null then
    return v_anchor;
  end if;

  select min(w.anchor) into v_later
    from _window_posts(p_actor, p_at - v_window, p_family) w
   where w.anchor > p_at and w.anchor < p_at + v_window;
  if v_later is null then
    return null;
  end if;

  if exists (
       select 1
         from _window_posts(p_actor, p_at - v_window, p_family) w
         join feed_events e on e.id = w.event_id
        where w.anchor = v_later
          and ((e.type = 'title_ranked' and e.created_at >= p_at + v_window)
               or exists (select 1 from _group_members(e.id) m
                           where m.acted_at >= p_at + v_window))
     ) then
    return null;
  end if;

  update feed_events e
     set payload = e.payload || jsonb_build_object('started_at', p_at)
   where e.id in (select w.event_id
                    from _window_posts(p_actor, p_at - v_window, p_family) w
                   where w.anchor = v_later);
  return p_at;
end;
$$;

revoke execute on function _window_posts(uuid, timestamptz, text) from public, anon, authenticated;
revoke execute on function _window_anchor(uuid, timestamptz, text) from public, anon, authenticated;
revoke execute on function _claim_window_start(uuid, timestamptz, text) from public, anon, authenticated;

/**
 * `_open_session` (20261130000900), same signature, for the event's own category only: the
 * actor's visible ranking group (for a ranking) or watchlist post (for a save) whose fixed
 * window holds `p_at`. `p_strict` also requires `p_at` at or after the start. Locked.
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
  v_id     uuid;
begin
  select e.id
    into v_id
    from feed_events e
   where e.actor_id = p_actor
     and e.presented_in is null
     and e.type = case when p_family = 'ranking' then 'ranking_batch' else 'watchlist_added' end
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
-- 2. A first ranking from the ranking sheet
-- ---------------------------------------------------------------------------

/**
 * `rank_group_note`, 20261130000900's body with the two-post rule:
 *
 *   * the window is the shared one (`_claim_window_start`), which a save may have opened;
 *   * the post joined is the window's ranking group only; a watchlist post is never joined;
 *   * a ranking still on its own records the window's anchor (`started_at`), so a later
 *     ranking in the same window pairs with it and a later window never does.
 *
 * Reviews play no part. Answers exactly as before (`joined`, `grouped`, `solo`, `skipped`).
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
  v_anchor  timestamptz;
  v_target  uuid;
  v_peer    record;
  v_first   record;
  v_found   boolean := false;
  v_count   integer;
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

  -- Both of the actor's keys, before anything is read: a save on another device decides
  -- about the same window, and its anchor, only before or after this.
  perform _lock_activity_session(v_me);

  v_window := _activity_session_window();

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
  if coalesce((v_event.payload ->> 'update')::boolean, false)
     or coalesce((v_event.payload ->> 'again')::boolean, false) then
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'skipped', 'reason', 'not_first'));
  end if;
  if _feed_event_referenced(v_event.id) then
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'skipped', 'reason', 'referenced'));
  end if;
  -- No review test (20261130000800), no watch-date test (20261130000200).

  v_anchor := _claim_window_start(v_me, v_event.created_at, 'ranking');

  -- The window's ranking group.
  v_target := _open_session(v_me, v_event.created_at, 'ranking');
  if v_target is not null then
    update feed_events set presented_in = v_target where id = v_event.id;
    perform _session_refresh(v_target);
    select (payload ->> 'count')::integer into v_count from feed_events where id = v_target;
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'joined', 'event_id', v_target, 'count', v_count));
  end if;

  -- A first ranking of the same window still on its own: the earliest, untouched. Locked,
  -- then re-checked in a fresh statement.
  if v_anchor is not null then
    for v_peer in
      select fe.id, fe.created_at, fe.causal_at, fe.media_item_id
        from feed_events fe
       where fe.actor_id = v_me
         and fe.type = 'title_ranked'
         and fe.id <> v_event.id
         and fe.presented_in is null
         and (coalesce((fe.payload ->> 'groupable')::boolean, false)
              or coalesce((fe.payload ->> 'backfill')::boolean, false))
         and not coalesce((fe.payload ->> 'update')::boolean, false)
         and not coalesce((fe.payload ->> 'again')::boolean, false)
         and fe.created_at > v_anchor - v_window
         and coalesce((fe.payload ->> 'started_at')::timestamptz, fe.created_at) >= v_anchor
         and coalesce((fe.payload ->> 'started_at')::timestamptz, fe.created_at) < v_anchor + v_window
         and fe.created_at < v_anchor + v_window
       order by fe.created_at, fe.id
    loop
      perform 1 from feed_events where id = v_peer.id for update;
      if exists (select 1 from feed_events where id = v_peer.id and presented_in is null)
         and not _feed_event_referenced(v_peer.id) then
        v_found := true;
        exit;
      end if;
    end loop;
  end if;

  if v_found then
    if v_peer.created_at <= v_event.created_at then
      v_first := v_peer;
    else
      select v_event.id, v_event.created_at, v_event.causal_at, p_media_item_id as media_item_id
        into v_first;
    end if;
    insert into feed_events (actor_id, type, media_item_id, payload, created_at, causal_at, causal_step)
    values (
      v_me, 'ranking_batch', v_first.media_item_id,
      jsonb_build_object('count', 2, 'started_at', v_anchor, 'origin', 'title', 'session', true),
      v_first.created_at, v_first.causal_at, 0
    )
    returning id into v_target;
    update feed_events set presented_in = v_target where id in (v_peer.id, v_event.id);
    perform _session_refresh(v_target);
    select (payload ->> 'count')::integer into v_count from feed_events where id = v_target;
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'grouped', 'event_id', v_target, 'count', v_count));
  end if;

  update feed_events
     set payload = payload || jsonb_build_object(
           'groupable', true,
           'started_at', coalesce(v_anchor, v_event.created_at))
   where id = v_event.id;
  return _record_operation_result(p_operation_id,
    jsonb_build_object('status', 'solo', 'event_id', v_event.id));
end;
$$;

comment on function rank_group_note(uuid, uuid) is
  'Title-page first-ranking grouping (20261128000100, 20261130000200, 20261130000800, '
  '20261130001000). Puts the caller''s newest first-time, unreferenced title_ranked post for '
  'the title into the ranking group of the actor''s current window (one fixed window per '
  'author, opened by the first ranking or save and shared by both), or into a new group with '
  'a first ranking of the same window still on its own, by hiding it behind the post '
  '(presented_in). Reviews play no part. Never joins a watchlist post. The post moves to its '
  'newest ranking. Serialised on the actor''s session keys. Idempotent.';

revoke execute on function rank_group_note(uuid, uuid) from public, anon;
grant execute on function rank_group_note(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. A save
-- ---------------------------------------------------------------------------

/**
 * `_post_watchlist_activity`, 20261130000900's body with the two-post rule: a save joins the
 * watchlist post of the actor's current window, or starts one anchored on that window (which
 * a ranking may have opened). It never joins, or makes, a ranking group. Announced once,
 * ever, per (actor, title), as before. With `feed.watchlist_grouping_enabled` false it writes
 * a single post exactly as 20260820000300 did. `set_watchlist` is unchanged.
 */
create or replace function _post_watchlist_activity(p_actor uuid, p_media_item_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grouping boolean;
  v_anchor   timestamptz;
  v_event    uuid;
begin
  if p_actor is null or p_media_item_id is null then
    return null;
  end if;

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
    v_anchor := _window_anchor(p_actor, now(), 'watchlist');
    v_event := _open_session(p_actor, now(), 'watchlist');
  end if;

  if v_event is null then
    insert into feed_events (actor_id, type, media_item_id, payload, causal_at, causal_step)
    values (
      p_actor, 'watchlist_added', p_media_item_id,
      case when v_grouping
           then jsonb_build_object('count', 1, 'started_at', coalesce(v_anchor, now()),
                                   'session', true)
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
  'Announces one saved title as Feed activity (20261125000100, 20261130001000): joins the '
  'watchlist post of the actor''s current window (one fixed window per author, opened by the '
  'first ranking or save and shared by both), or starts one anchored on it. Never joins a '
  'ranking group. Each (actor, title) is announced once, ever. The post moves to its newest '
  'save. Serialised on the actor''s session keys. Internal.';

revoke all on function _post_watchlist_activity(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. An Unranked sitting
-- ---------------------------------------------------------------------------

/**
 * `rank_batch_finalize`, 20261130000900's body with the two-post rule:
 *
 *   * the window is the shared one; a sitting that begins inside a window joins that
 *     window's ranking group if there is one (never its watchlist post);
 *   * a sitting published on its own carries the window's anchor and presents the
 *     title-page first rankings of the same window still on their own. It no longer
 *     presents watchlist posts: those stay the window's watchlist post.
 *
 * `rank_batch_note` is unchanged (20261130000900): it only ever adds rankings to a sitting.
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
    v_anchor := _claim_window_start(auth.uid(), v_started, 'ranking');
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

    perform _session_refresh(v_target);
    v_count := _group_title_count(v_target);

    return _record_operation_result(
      p_operation_id,
      jsonb_build_object('status', 'ok', 'event_id', v_target, 'count', v_count, 'joined', true)
    );
  end if;

  v_anchor := coalesce(v_anchor, v_started);

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
        and fe.created_at > v_anchor - v_window
        and fe.created_at < v_anchor + v_window
      order by fe.id
        for update;

    -- The first rankings of this window still on their own.
    select coalesce(array_agg(fe.id order by fe.created_at, fe.id), '{}')
      into v_adopt
      from feed_events fe
     where fe.actor_id = auth.uid()
       and fe.type = 'title_ranked'
       and fe.presented_in is null
       and (coalesce((fe.payload ->> 'groupable')::boolean, false)
            or coalesce((fe.payload ->> 'backfill')::boolean, false))
       and fe.created_at > v_anchor - v_window
       and fe.created_at < v_anchor + v_window
       and coalesce((fe.payload ->> 'started_at')::timestamptz, fe.created_at) >= v_anchor
       and coalesce((fe.payload ->> 'started_at')::timestamptz, fe.created_at) < v_anchor + v_window
       and not coalesce((fe.payload ->> 'update')::boolean, false)
       and not coalesce((fe.payload ->> 'again')::boolean, false)
       and not _feed_event_referenced(fe.id)
       and not exists (select 1 from feed_ranking_titles frt
                        where frt.event_id = v_event and frt.media_item_id = fe.media_item_id);
  end if;

  update feed_events
     set type = 'ranking_batch',
         causal_at = now(),
         created_at = now(),
         payload = payload || jsonb_build_object('count', v_count,
                                                 'started_at', v_anchor,
                                                 'session', true)
   where id = v_event;

  if cardinality(v_adopt) > 0 then
    update feed_events set presented_in = v_event where id = any (v_adopt);
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
  'Ends an Unranked sitting. If the sitting began inside the actor''s current window (one '
  'fixed window per author, opened by the first ranking or save and shared by both) and that '
  'window has a ranking group, its titles join that post, which keeps its id and conversation '
  'and moves to its newest ranking; the draft is deleted. Otherwise it publishes the draft, '
  'dated now, anchored on the window, presenting the title-page first rankings of the same '
  'window still on their own (20261130000200, 20261130000800, 20261130001000). Never presents '
  'a watchlist post. A sitting is never split. Serialised on the actor''s session keys. '
  'Idempotent.';

revoke execute on function rank_batch_finalize(uuid, uuid) from public, anon;
grant execute on function rank_batch_finalize(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The session consolidation of 20261130000900 is retired
-- ---------------------------------------------------------------------------
--
-- `consolidate_feed_sessions` folds a window's rankings and saves into one post, which the
-- founder has replaced. It keeps its dry run and refuses to apply unless an operator sets
-- `feed.session_consolidation_enabled` (seeded false). `revert_feed_session_consolidation`
-- still reverts its batches, but refuses one whose posts a split still holds: the split
-- moved members to other posts, so the split is reverted first.

/**
 * (Retired by 20261130001000: applies only with `feed.session_consolidation_enabled`.)
 *
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

  -- 20261130001000: a window has one post per category now, and this folds both into one,
  -- so it applies only on an operator's explicit opt-in. The dry run is unchanged.
  if p_apply and not exists (select 1 from app_config
                              where key = 'feed.session_consolidation_enabled'
                                and value = 'true'::jsonb) then
    raise exception 'consolidate_feed_sessions is retired (20261130001000): a window has one post per category; see split_mixed_sessions'
      using errcode = '55000';
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
 * (20261130001000: refuses while a split batch holds any of its posts.)
 *
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
  -- 20261130001000: a split moved some of this batch's members to other posts; it is
  -- reverted first, so this batch's log describes the rows as they stand.
  if exists (select 1 from feed_consolidation_log s
              where s.kind = 'split' and s.split_role = 'post'
                and s.group_event_id in (select l.group_event_id from feed_consolidation_log l
                                          where l.batch = p_batch and l.kind = 'session'
                                            and l.member_event_id is null)) then
    raise exception 'batch % has posts held by split batch %; revert that split first', p_batch,
      (select string_agg(distinct s.batch, ', ' order by s.batch) from feed_consolidation_log s
        where s.kind = 'split' and s.split_role = 'post'
          and s.group_event_id in (select l.group_event_id from feed_consolidation_log l
                                    where l.batch = p_batch and l.kind = 'session'
                                      and l.member_event_id is null))
      using errcode = '55000';
  end if;

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

-- ---------------------------------------------------------------------------
-- 6. The historical correction: split each mixed session post in two
-- ---------------------------------------------------------------------------
--
-- See docs/feed/session-split.md. Inert: operator-only, never called by this migration or
-- the app. Logged per row (kind `split`) so `revert_session_split` puts every row back.

alter table feed_consolidation_log add column if not exists split_role text;
alter table feed_consolidation_log add column if not exists member_table text;
alter table feed_consolidation_log add column if not exists member_row_id bigint;
alter table feed_consolidation_log add column if not exists member_row_key uuid;
alter table feed_consolidation_log add column if not exists prior_event_id uuid;

comment on column feed_consolidation_log.kind is
  '''family'' for consolidate_feed_history (20261128000100), ''session'' for '
  'consolidate_feed_sessions (20261130000900), ''split'' for split_mixed_sessions '
  '(20261130001000). Session and split rows carry the prior state of every row they changed.';
comment on column feed_consolidation_log.split_role is
  'For kind ''split'': ''post'' (the mixed post, group_event_id), ''partner'' (the post of the '
  'other category, member_event_id; created_group when the split made it), ''member'' (a hidden '
  'post moved to the partner) or ''row'' (a membership row moved to the partner: member_table, '
  'member_row_id or member_row_key, prior_event_id).';

/**
 * The split plan, as rows: one per visible post that holds both categories (a ranking and a
 * save, its own membership or that of the posts it presents) whose window anchor is in
 * [p_since, p_until). Pure read over tables only, so
 * docs/feed/session-split-candidates.sql can run the same query read-only before this
 * migration exists (`session-split.test.mjs` holds the two to each other).
 *
 *   keep          the category the post keeps (its identity and its conversation): the
 *                 category it was before a session batch reused it; `ranking` if a batch or
 *                 a session writer created it; for a live post, `watchlist` only when it
 *                 began as a watchlist post (its own save, no origin)
 *   partner_id    the post the other category moves to: an original hidden post of that
 *                 category (the largest, then the earliest), or the one hidden ranking when
 *                 it is the only one; null when a new post must be made
 *   partner_title the title a new watchlist post carries (`feed_events_watchlist_once`)
 *   exception     why the post must be left as it is, or null
 */
create or replace function _session_split_plan(
  p_since timestamptz,
  p_until timestamptz,
  p_actor uuid default null
)
returns table (
  post_id       uuid,
  actor_id      uuid,
  anchor        timestamptz,
  keep          text,
  partner_id    uuid,
  partner_type  text,
  partner_title uuid,
  ranked        integer,
  saved         integer,
  referenced    boolean,
  exception     text
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select make_interval(mins => greatest(1, coalesce(
             (select (c.value)::integer from app_config c where c.key = 'feed.ranking_group_minutes'),
             30))) as win
  ),
  posts as (
    select e.id, e.actor_id, e.type, e.media_item_id, e.created_at, e.payload,
           coalesce((e.payload ->> 'started_at')::timestamptz, e.created_at) as anchor
      from feed_events e
     where e.presented_in is null
       and e.type in ('ranking_batch', 'watchlist_added')
       and (p_actor is null or e.actor_id = p_actor)
       and coalesce((e.payload ->> 'started_at')::timestamptz, e.created_at) >= p_since
       and coalesce((e.payload ->> 'started_at')::timestamptz, e.created_at) < p_until
  ),
  kids as (
    select c.id, c.type, c.presented_in as post, c.media_item_id, c.created_at, c.payload
      from feed_events c
      join posts p on c.presented_in = p.id
  ),
  raw as (
    select p.id as post, frt.media_item_id, 'ranking'::text as cat
      from posts p join feed_ranking_titles frt on frt.event_id = p.id
    union all
    select p.id, wt.media_item_id, 'watchlist'
      from posts p join feed_watchlist_titles wt on wt.event_id = p.id
    union all
    select k.post, k.media_item_id, 'ranking'
      from kids k where k.type = 'title_ranked' and k.media_item_id is not null
    union all
    select k.post, frt.media_item_id, 'ranking'
      from kids k join feed_ranking_titles frt on frt.event_id = k.id
    union all
    select k.post, wt.media_item_id, 'watchlist'
      from kids k join feed_watchlist_titles wt on wt.event_id = k.id
  ),
  mixed as (
    select p.* from posts p
     where exists (select 1 from raw r where r.post = p.id and r.cat = 'ranking')
       and exists (select 1 from raw r where r.post = p.id and r.cat = 'watchlist')
  ),
  logged as (
    select distinct on (l.group_event_id) l.group_event_id, l.created_group, l.prior_type
      from feed_consolidation_log l
     where l.kind = 'session' and l.member_event_id is null
       and l.group_event_id in (select m.id from mixed m)
     order by l.group_event_id, l.id desc
  ),
  kept as (
    select m.*,
           case
             when lg.group_event_id is not null then
               case when not lg.created_group and lg.prior_type = 'watchlist_added'
                    then 'watchlist' else 'ranking' end
             when coalesce(m.payload ->> 'origin', '') in ('session', 'title', 'history', 'split')
               then 'ranking'
             when exists (select 1 from feed_ranking_titles f where f.event_id = m.id) then 'ranking'
             when exists (select 1 from feed_watchlist_titles f where f.event_id = m.id) then 'watchlist'
             else 'ranking'
           end as keep,
           (select count(distinct r.media_item_id) from raw r
             where r.post = m.id and r.cat = 'ranking')::integer as ranked,
           (select count(distinct r.media_item_id) from raw r
             where r.post = m.id and r.cat = 'watchlist')::integer as saved,
           exists (select 1 from feed_ranking_titles f where f.event_id = m.id) as own_ranking_rows,
           -- The newest of the post's own saves that no other watchlist post carries.
           (select wt.media_item_id from feed_watchlist_titles wt
             where wt.event_id = m.id
               and not exists (select 1 from feed_events o
                                where o.actor_id = m.actor_id and o.type = 'watchlist_added'
                                  and o.media_item_id = wt.media_item_id and o.id <> m.id)
             order by wt.added_at desc, wt.id desc limit 1) as free_save,
           exists (select 1 from comments c where c.feed_event_id = m.id)
             or exists (select 1 from reactions r where r.feed_event_id = m.id)
             or exists (select 1 from notifications n
                         where n.subject_type = 'feed_event' and n.subject_id = m.id)
             or exists (select 1 from proactive_cluster_actors pa where pa.feed_event_id = m.id)
             or exists (select 1 from feed_event_causes fc where fc.feed_event_id = m.id) as referenced
      from mixed m
      left join logged lg on lg.group_event_id = m.id
  ),
  candidates as (
    select k.*,
           case when k.keep = 'watchlist' then
             (select c.id from kids c where c.post = k.id and c.type = 'ranking_batch'
               order by coalesce((c.payload ->> 'count')::integer, 0) desc, c.created_at, c.id limit 1)
           else
             (select c.id from kids c where c.post = k.id and c.type = 'watchlist_added'
               order by coalesce((c.payload ->> 'count')::integer, 1) desc, c.created_at, c.id limit 1)
           end as group_kid,
           (select c.id from kids c where c.post = k.id and c.type = 'title_ranked'
             order by c.created_at, c.id limit 1) as single_kid
      from kept k
  ),
  decided as (
    select c.*,
           case when c.group_kid is not null then c.group_kid
                when c.keep = 'watchlist' and c.ranked = 1 and not c.own_ranking_rows
                  then c.single_kid
           end as partner
      from candidates c
  )
  select d.id as post_id,
         d.actor_id,
         d.anchor,
         d.keep,
         d.partner as partner_id,
         case when d.keep = 'ranking' then 'watchlist_added'
              when d.partner is not null and d.partner = d.single_kid
                   and d.partner is distinct from d.group_kid then 'title_ranked'
              else 'ranking_batch' end as partner_type,
         case when d.keep = 'ranking' and d.partner is null then d.free_save end as partner_title,
         d.ranked,
         d.saved,
         d.referenced,
         case
           when d.anchor + (select win from params) > now() then 'window_open'
           when exists (select 1 from kids x where x.post = d.id
                         and x.type not in ('title_ranked', 'ranking_batch', 'watchlist_added'))
             then 'unknown_member'
           when exists (select 1 from kids x join feed_events y on y.presented_in = x.id
                         where x.post = d.id)
             then 'nested_member'
           when exists (select 1 from kids x where x.post = d.id and (
                  (x.type = 'ranking_batch'
                   and exists (select 1 from feed_watchlist_titles w where w.event_id = x.id))
               or (x.type = 'watchlist_added'
                   and exists (select 1 from feed_ranking_titles f where f.event_id = x.id))))
             then 'mixed_member'
           when d.keep = 'watchlist' and d.free_save is null then 'no_watchlist_title'
           when d.keep = 'ranking' and d.partner is null and d.free_save is null
             then 'no_watchlist_title'
           when d.keep = 'watchlist' and d.group_kid is not null and exists (
                  select 1 from feed_ranking_titles a
                    join feed_ranking_titles b on b.media_item_id = a.media_item_id
                   where a.event_id = d.id and b.event_id = d.group_kid)
             then 'title_conflict'
         end as exception
    from decided d
   order by d.actor_id, d.anchor, d.id;
$$;

revoke execute on function _session_split_plan(timestamptz, timestamptz, uuid) from public, anon, authenticated;

/**
 * Splits each planned mixed post into its two category posts. Operator-only; dry run unless
 * `p_apply`. Bounded: at most 31 days, ending at least one window ago (history only), at
 * most `p_max_posts` posts per call, one account when `p_actor` is given (the founder
 * first). A batch name is used once.
 *
 * Per post, under the actor's session keys and the rows' locks, re-planned:
 *
 *   * the post keeps its id, its conversation and its category (`keep`); the other
 *     category's hidden posts and membership rows move to the partner, which is unhidden
 *     if it was an original hidden post, or made (dated by its first member, placed at its
 *     last) if there is none;
 *   * both posts carry the window's anchor and sit at their own category's last activity,
 *     newest title first; every hidden member resolves in one hop to its own category's
 *     post (`feed_event_presentation`);
 *   * nothing is deleted, nobody is notified, and visibility is the author's own.
 *
 * Every changed row is logged under `p_batch` (kind `split`) with its prior state.
 */
create or replace function split_mixed_sessions(
  p_batch     text,
  p_since     timestamptz,
  p_until     timestamptz,
  p_apply     boolean default false,
  p_actor     uuid default null,
  p_max_posts integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window  interval := _activity_session_window();
  v_plan    record;
  v_now     record;
  v_p       record;
  v_q       uuid;
  v_created boolean;
  v_other   text;
  v_first   timestamptz;
  v_last    timestamptz;
  v_media   uuid;
  v_type    text;
  v_x       uuid;
  v_n       integer;
  v_done    integer := 0;
  v_skipped integer := 0;
  v_members integer := 0;
  v_rows    integer := 0;
  v_posts   jsonb := '[]'::jsonb;
  v_planned jsonb;
begin
  if p_batch is null or length(p_batch) < 3 then
    raise exception 'a batch name is required' using errcode = '22023';
  end if;
  if p_until <= p_since or p_until - p_since > interval '31 days' then
    raise exception 'the range must be positive and at most 31 days' using errcode = '22023';
  end if;
  if p_apply and exists (select 1 from feed_consolidation_log where batch = p_batch) then
    raise exception 'batch % already applied', p_batch using errcode = '23505';
  end if;
  if p_apply and p_until > now() - v_window then
    raise exception 'the range must end at least one window ago' using errcode = '22023';
  end if;

  create temporary table if not exists _split_plan (
    post_id uuid, actor_id uuid, anchor timestamptz, keep text, partner_id uuid,
    partner_type text, partner_title uuid, ranked integer, saved integer, referenced boolean,
    exception text
  ) on commit drop;
  truncate _split_plan;
  insert into _split_plan select * from _session_split_plan(p_since, p_until, p_actor);

  select jsonb_build_object(
           'mixed_posts', count(*),
           'to_split', count(*) filter (where exception is null),
           'actors', count(distinct actor_id) filter (where exception is null),
           'keep_ranking', count(*) filter (where exception is null and keep = 'ranking'),
           'keep_watchlist', count(*) filter (where exception is null and keep = 'watchlist'),
           'partners_reused', count(*) filter (where exception is null and partner_id is not null),
           'partners_created', count(*) filter (where exception is null and partner_id is null),
           'with_engagement', count(*) filter (where referenced),
           'titles_ranked', coalesce(sum(ranked) filter (where exception is null), 0),
           'titles_saved', coalesce(sum(saved) filter (where exception is null), 0),
           'exceptions', coalesce((select jsonb_object_agg(e.exception, e.n)
                                     from (select s.exception, count(*) as n from _split_plan s
                                            where s.exception is not null group by s.exception) e),
                                  '{}'::jsonb))
    into v_planned
    from _split_plan;

  if p_apply then
    for v_plan in
      select * from _split_plan where exception is null order by actor_id, anchor, post_id
    loop
      exit when v_done >= greatest(1, coalesce(p_max_posts, 25));
      perform _lock_activity_session(v_plan.actor_id);
      perform 1 from feed_events
        where id = v_plan.post_id or presented_in = v_plan.post_id
        order by id for update;

      -- Re-planned under the locks; anything that changed is left for another call.
      select * into v_now
        from _session_split_plan(p_since, p_until, v_plan.actor_id) s
       where s.post_id = v_plan.post_id;
      if v_now.post_id is null or v_now.exception is not null
         or v_now.partner_id is distinct from v_plan.partner_id
         or v_now.keep <> v_plan.keep then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      select * into v_p from feed_events where id = v_plan.post_id;
      v_other := case when v_now.keep = 'watchlist' then 'ranking' else 'watchlist' end;

      insert into feed_consolidation_log
        (batch, kind, split_role, group_event_id, member_event_id, created_group, prior_payload,
         prior_type, prior_media_item_id, prior_causal_at, prior_causal_step, prior_presented_in)
      values (p_batch, 'split', 'post', v_p.id, null, false, v_p.payload, v_p.type,
              v_p.media_item_id, v_p.causal_at, v_p.causal_step, null);

      if v_now.partner_id is not null then
        v_q := v_now.partner_id;
        v_created := false;
        insert into feed_consolidation_log
          (batch, kind, split_role, group_event_id, member_event_id, created_group, prior_payload,
           prior_type, prior_media_item_id, prior_causal_at, prior_causal_step, prior_presented_in)
        select p_batch, 'split', 'partner', v_p.id, q.id, false, q.payload, q.type,
               q.media_item_id, q.causal_at, q.causal_step, q.presented_in
          from feed_events q where q.id = v_q;
        update feed_events set presented_in = null where id = v_q;
      else
        if v_other = 'ranking' then
          select min(m.first_at), max(m.acted_at) into v_first, v_last
            from _group_members(v_p.id) m where m.action = 'ranked';
          select m.media_item_id into v_media
            from _group_members(v_p.id) m where m.action = 'ranked'
           order by m.acted_at desc, m.last_tiebreak desc, m.media_item_id limit 1;
          v_type := 'ranking_batch';
        else
          select min(wt.added_at), max(wt.added_at) into v_first, v_last
            from feed_watchlist_titles wt where wt.event_id = v_p.id;
          v_media := v_now.partner_title;
          v_type := 'watchlist_added';
        end if;
        insert into feed_events (actor_id, type, media_item_id, payload, created_at, causal_at, causal_step)
        values (v_p.actor_id, v_type, v_media,
                jsonb_build_object('count', 0, 'started_at', v_now.anchor, 'session', true,
                                   'origin', 'split', 'split_batch', p_batch),
                v_first, v_last, 0)
        returning id into v_q;
        if v_q is null then
          raise exception 'split of % could not write its partner', v_p.id using errcode = '55000';
        end if;
        v_created := true;
        insert into feed_consolidation_log
          (batch, kind, split_role, group_event_id, member_event_id, created_group)
        values (p_batch, 'split', 'partner', v_p.id, v_q, true);
      end if;

      -- The other category's hidden posts.
      for v_x in
        select c.id from feed_events c
         where c.presented_in = v_p.id and c.id <> v_q
           and ((v_other = 'ranking' and c.type in ('title_ranked', 'ranking_batch'))
                or (v_other = 'watchlist' and c.type = 'watchlist_added'))
         order by c.id
      loop
        insert into feed_consolidation_log
          (batch, kind, split_role, group_event_id, member_event_id, created_group, prior_presented_in)
        values (p_batch, 'split', 'member', v_p.id, v_x, false, v_p.id);
        update feed_events set presented_in = v_q where id = v_x;
        v_members := v_members + 1;
      end loop;

      -- The other category's own membership rows.
      if v_other = 'ranking' then
        insert into feed_consolidation_log
          (batch, kind, split_role, group_event_id, member_event_id, created_group,
           member_table, member_row_id, prior_event_id)
        select p_batch, 'split', 'row', v_p.id, v_q, false, 'feed_ranking_titles', f.id, v_p.id
          from feed_ranking_titles f where f.event_id = v_p.id;
        get diagnostics v_n = row_count;
        update feed_ranking_titles set event_id = v_q where event_id = v_p.id;
        insert into feed_consolidation_log
          (batch, kind, split_role, group_event_id, member_event_id, created_group,
           member_table, member_row_key, prior_event_id)
        select p_batch, 'split', 'row', v_p.id, v_q, false, 'feed_ranking_sitting_joins', j.sitting, v_p.id
          from feed_ranking_sitting_joins j where j.event_id = v_p.id;
        update feed_ranking_sitting_joins set event_id = v_q where event_id = v_p.id;
      else
        insert into feed_consolidation_log
          (batch, kind, split_role, group_event_id, member_event_id, created_group,
           member_table, member_row_id, prior_event_id)
        select p_batch, 'split', 'row', v_p.id, v_q, false, 'feed_watchlist_titles', w.id, v_p.id
          from feed_watchlist_titles w where w.event_id = v_p.id;
        get diagnostics v_n = row_count;
        update feed_watchlist_titles set event_id = v_q where event_id = v_p.id;
      end if;
      v_rows := v_rows + v_n;

      -- Both posts: their own members, newest first, each at its own last activity.
      perform _session_refresh(v_p.id);
      perform _session_refresh(v_q);
      for v_x in
        select e.id from feed_events e
         where e.id in (v_p.id, v_q) and e.type in ('ranking_batch', 'watchlist_added')
      loop
        select max(m.acted_at) into v_last from _group_members(v_x) m;
        update feed_events
           set causal_at = v_last,
               causal_step = 0,
               payload = payload || jsonb_build_object('last_activity_at', v_last,
                                                       'started_at', v_now.anchor,
                                                       'session', true)
         where id = v_x;
      end loop;

      select type into v_type from feed_events where id = v_p.id;
      if v_type is distinct from (case when v_now.keep = 'watchlist' then 'watchlist_added'
                                       else 'ranking_batch' end) then
        raise exception 'split of % left it a %', v_p.id, v_type using errcode = '55000';
      end if;

      v_done := v_done + 1;
      v_posts := v_posts || jsonb_build_object('post', v_p.id, 'partner', v_q,
                                               'created', v_created, 'keep', v_now.keep);
    end loop;
  end if;

  return jsonb_build_object(
    'batch', p_batch,
    'applied', p_apply,
    'since', p_since,
    'until', p_until,
    'actor_scoped', p_actor is not null,
    'planned', v_planned,
    'applied_posts', v_done,
    'skipped_posts', v_skipped,
    'moved_members', v_members,
    'moved_rows', v_rows,
    'posts', v_posts
  );
end;
$$;

/**
 * Undoes one split batch, newest post first: every membership row and hidden post moves
 * back to the mixed post, a partner the split made is deleted (anything that joined it
 * since is moved back first) unless somebody has since reacted to or commented on it (then
 * the pair is left split, its log kept, and it is reported), a partner it reused is hidden
 * again, and both posts get back their prior type, title, payload and place.
 */
create or replace function revert_session_split(p_batch text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_g        record;
  v_partner  record;
  v_q        uuid;
  v_kept     uuid[] := '{}';
  v_reverted integer := 0;
  v_deleted  integer := 0;
begin
  for v_g in
    select l.*, fe.actor_id
      from feed_consolidation_log l
      join feed_events fe on fe.id = l.group_event_id
     where l.batch = p_batch and l.kind = 'split' and l.split_role = 'post'
     order by l.id desc
  loop
    perform _lock_activity_session(v_g.actor_id);
    select * into v_partner from feed_consolidation_log l
     where l.batch = p_batch and l.kind = 'split' and l.split_role = 'partner'
       and l.group_event_id = v_g.group_event_id;
    v_q := v_partner.member_event_id;
    perform 1 from feed_events where id in (v_g.group_event_id, v_q) order by id for update;

    if v_partner.created_group and _feed_event_referenced(v_q) then
      v_kept := v_kept || v_g.group_event_id;
      continue;
    end if;

    update feed_ranking_titles f set event_id = l.prior_event_id
      from feed_consolidation_log l
     where l.batch = p_batch and l.kind = 'split' and l.split_role = 'row'
       and l.group_event_id = v_g.group_event_id and l.member_table = 'feed_ranking_titles'
       and f.id = l.member_row_id and f.event_id = v_q;
    update feed_watchlist_titles w set event_id = l.prior_event_id
      from feed_consolidation_log l
     where l.batch = p_batch and l.kind = 'split' and l.split_role = 'row'
       and l.group_event_id = v_g.group_event_id and l.member_table = 'feed_watchlist_titles'
       and w.id = l.member_row_id and w.event_id = v_q;
    update feed_ranking_sitting_joins j set event_id = l.prior_event_id
      from feed_consolidation_log l
     where l.batch = p_batch and l.kind = 'split' and l.split_role = 'row'
       and l.group_event_id = v_g.group_event_id and l.member_table = 'feed_ranking_sitting_joins'
       and j.actor_id = v_g.actor_id and j.sitting = l.member_row_key and j.event_id = v_q;

    update feed_events fe set presented_in = l.prior_presented_in
      from feed_consolidation_log l
     where l.batch = p_batch and l.kind = 'split' and l.split_role = 'member'
       and l.group_event_id = v_g.group_event_id
       and fe.id = l.member_event_id and fe.presented_in = v_q;

    if v_partner.created_group then
      update feed_events set presented_in = v_g.group_event_id where presented_in = v_q;
      delete from feed_events where id = v_q;
      v_deleted := v_deleted + 1;
    else
      update feed_events
         set type = v_partner.prior_type,
             media_item_id = case when exists (select 1 from media_items mi
                                                where mi.id = v_partner.prior_media_item_id)
                                  then v_partner.prior_media_item_id else media_item_id end,
             payload = v_partner.prior_payload,
             causal_at = v_partner.prior_causal_at,
             causal_step = v_partner.prior_causal_step,
             presented_in = v_partner.prior_presented_in
       where id = v_q;
    end if;

    update feed_events
       set type = v_g.prior_type,
           media_item_id = case when exists (select 1 from media_items mi
                                              where mi.id = v_g.prior_media_item_id)
                                then v_g.prior_media_item_id else media_item_id end,
           payload = v_g.prior_payload,
           causal_at = v_g.prior_causal_at,
           causal_step = v_g.prior_causal_step
     where id = v_g.group_event_id;

    delete from feed_consolidation_log
     where batch = p_batch and kind = 'split' and group_event_id = v_g.group_event_id;
    v_reverted := v_reverted + 1;
  end loop;

  return jsonb_build_object('batch', p_batch, 'reverted_posts', v_reverted,
                            'deleted_partners', v_deleted,
                            'kept_with_conversation', to_jsonb(v_kept));
end;
$$;

revoke execute on function split_mixed_sessions(text, timestamptz, timestamptz, boolean, uuid, integer)
  from public, anon, authenticated;
revoke execute on function revert_session_split(text) from public, anon, authenticated;
