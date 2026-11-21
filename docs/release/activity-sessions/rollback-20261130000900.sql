-- ROLLBACK of 20261130000900_an_activity_session_is_one_post. STAGING ONLY unless separately
-- approved.
--
-- Restores, verbatim, every WRITER the migration rebuilt, with its comment and grants:
--
--   * `rank_group_note`, `rank_batch_finalize` as 20261130000800 left them;
--   * `rank_batch_note`, `_post_watchlist_activity` (body) and `_unpresent` as 20261128000100
--     left them, and `_post_watchlist_activity`'s comment as 20261125000100 wrote it;
--   * `_watchlist_group_keeps_its_post` as 20261125000100 left it.
--
-- And removes what only the writers used: `_session_refresh`, `_open_session`,
-- `_lock_activity_session`, `_activity_session_window`, `_activity_sessions_enabled`, the
-- `feed.activity_sessions_enabled` setting, and the session consolidation
-- (`consolidate_feed_sessions`, `revert_feed_session_consolidation`,
-- `_session_consolidation_plan`). It REFUSES while any session-consolidation batch is still
-- logged: revert those first with `revert_feed_session_consolidation`.
--
-- KEPT, deliberately: the readers (`_group_members`, `_group_titles`, `ranking_batch_titles`,
-- `watchlist_group_titles`, `feed_group_previews`) and the new `feed_consolidation_log`
-- columns. A session formed while the migration was in place can hold rankings and saves on
-- one post; the restored writers and the old readers would count and list only one family of
-- its members. The kept readers are a superset of the old ones: for a post holding one
-- family they return exactly what the old ones did, only newest first, and their two extra
-- trailing columns are ignored by every client.
--
-- Data: nothing is unhidden, re-dated or deleted. Sessions formed meanwhile stay one card
-- each, in the place their latest activity gave them. After the rollback a save joins only a
-- watchlist post and a ranking only a ranking group again, as before; a watchlist post that
-- moved forward meanwhile may take saves for up to 30 minutes after its last move (the
-- restored writer windows a watchlist post from `causal_at`), and nothing after that.
--
-- The `supabase_migrations.schema_migrations` row for 20261130000900 is the operator's to
-- delete in the same transaction, as for every rollback here; this script does not touch it.
--
-- Rehearsed in PGlite by supabase/tests/activity-sessions-rollback.test.mjs.
--
-- One transaction, so a failure leaves the migration fully in place.
begin;

do $$
begin
  if exists (select 1 from feed_consolidation_log where kind = 'session') then
    raise exception 'session consolidation batches are still logged; revert them first'
      using errcode = '55000';
  end if;
end $$;

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

  -- The same key the sitting finaliser and the sitting note hold: one grouping act per
  -- actor at a time, taken before anything is read.
  perform pg_advisory_xact_lock(hashtextextended('ranking_story:' || v_me::text, 0));

  select make_interval(mins => coalesce(
           (select (value)::integer from app_config where key = 'feed.ranking_group_minutes'), 30))
    into v_window;

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
  -- 20261130000800: no review test. A published review stays the title's, readable by the
  -- same people through `public_notes`; it does not make the ranking a post of its own.
  -- 20261130000200: no test of the watch date either.

  -- An open group: the actor's latest visible grouped ranking post whose fixed window, from
  -- its own first title, still holds this ranking's time. Any ladder.
  select e.id into v_target
    from feed_events e
   where e.actor_id = v_me
     and e.type = 'ranking_batch'
     and e.presented_in is null
     and e.payload ? 'started_at'
     and v_event.created_at < (e.payload ->> 'started_at')::timestamptz + v_window
   order by e.causal_at desc, e.id
   limit 1
     for update of e;

  if v_target is not null then
    update feed_events set presented_in = v_target where id = v_event.id;
    v_count := _group_title_count(v_target);
    update feed_events set payload = payload || jsonb_build_object('count', v_count)
     where id = v_target;
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'joined', 'event_id', v_target, 'count', v_count));
  end if;

  -- No open group: the earliest first ranking still on its own, marked by an earlier note,
  -- untouched, inside one window of this one. Each candidate is locked, then checked in a
  -- fresh statement: a comment or reaction in flight on it is waited for and seen, and a
  -- referenced candidate is passed over for the next, never taken. A reviewed one is taken
  -- like any other (20261130000800).
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
    -- The group stands where its first title stood: its time and its place in the Feed.
    if v_peer.created_at <= v_event.created_at then
      v_first := v_peer;
    else
      select v_event.id, v_event.created_at, v_event.causal_at, p_media_item_id as media_item_id
        into v_first;
    end if;
    insert into feed_events (actor_id, type, media_item_id, payload, created_at, causal_at, causal_step)
    values (
      v_me, 'ranking_batch', v_first.media_item_id,
      jsonb_build_object('count', 2, 'started_at', v_first.created_at, 'origin', 'title'),
      v_first.created_at, v_first.causal_at, 0
    )
    returning id into v_target;
    update feed_events set presented_in = v_target where id in (v_peer.id, v_event.id);
    v_count := _group_title_count(v_target);
    update feed_events set payload = payload || jsonb_build_object('count', v_count)
     where id = v_target;
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
  'Title-page first-ranking grouping (20261128000100, 20261130000200, 20261130000800). Groups '
  'the caller''s newest first-time, unreferenced title_ranked post for the title, whatever its '
  'watch date and whether or not the title carries a published review, into the open ranking '
  'group (fixed window from its first title, any ladder), or with an earlier first ranking '
  'still on its own, by hiding it behind the group (presented_in). Serialised on '
  'ranking_story:<actor>. Idempotent.';

revoke execute on function rank_group_note(uuid, uuid) from public, anon;
grant execute on function rank_group_note(uuid, uuid) to authenticated;

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

  -- One finaliser per actor at a time, before anything is read: two devices ending two
  -- sittings at once must not both publish a new post for the same window.
  perform pg_advisory_xact_lock(hashtextextended('ranking_story:' || auth.uid()::text, 0));

  -- Locked (Codex, PR 311): a comment or reaction being written against the draft holds a
  -- key-share lock on it until it commits, so this waits for it and the conversation check
  -- below sees it; and while this holds the row, no new one can be written and then lost
  -- when a joined draft is deleted.
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

  select make_interval(mins => coalesce(
           (select (value)::integer from app_config where key = 'feed.ranking_group_minutes'),
           30))
    into v_window;

  -- The open group this sitting may join: same actor, published by this migration's rule
  -- (it has a start), and the sitting began inside its window.
  if not exists (
       select 1 from app_config
        where key = 'feed.ranking_grouping_enabled' and value = 'false'::jsonb
     )
     -- A draft somebody has already reacted to or commented on keeps its own identity.
     and not exists (select 1 from comments  where feed_event_id = v_event)
     and not exists (select 1 from reactions where feed_event_id = v_event)
  then
    v_grouping := true;

    -- Any ladder since 20261128000100: grouping is a social presentation, and each title
    -- keeps its own ladder, position and score.
    select e.id
      into v_target
      from feed_events e
     where e.actor_id = auth.uid()
       and e.type = 'ranking_batch'
       and e.presented_in is null
       and e.payload ? 'started_at'
       -- Inside the window from both sides (Codex, PR 311): a sitting that began before the
       -- group did belongs to no part of it, however recently it ended.
       and v_started >= (e.payload ->> 'started_at')::timestamptz
       and v_started < (e.payload ->> 'started_at')::timestamptz + v_window
     order by e.causal_at desc, e.id
     limit 1
       for update of e;
  end if;

  if v_target is not null then
    insert into feed_ranking_titles (event_id, media_item_id, placed_at)
    select v_target, frt.media_item_id, frt.placed_at
      from feed_ranking_titles frt
     where frt.event_id = v_event
     order by frt.placed_at, frt.id
    on conflict (event_id, media_item_id) do nothing;

    delete from feed_events where id = v_event;

    -- So a placement still in flight for this sitting follows it into the group.
    insert into feed_ranking_sitting_joins (actor_id, sitting, event_id)
    values (auth.uid(), p_sitting, v_target)
    on conflict (actor_id, sitting) do update set event_id = excluded.event_id;

    v_count := _group_title_count(v_target);

    -- Membership and count only: the post keeps its id, conversation, causal_at and
    -- representative title.
    update feed_events
       set payload = payload || jsonb_build_object('count', v_count)
     where id = v_target;

    return _record_operation_result(
      p_operation_id,
      jsonb_build_object('status', 'ok', 'event_id', v_target, 'count', v_count, 'joined', true)
    );
  end if;

  /**
   * 20261130000200: no open group, so this sitting's post is the group. The title-page first
   * rankings of the same half hour, which `rank_group_note` marked while this sitting was
   * still a draft (or just before it began), come into it. Locked, then re-checked in a
   * fresh statement, as consolidation does: a comment or reaction in flight is waited for
   * and seen, and such a ranking keeps its card. 20261130000800: a review does not.
   */
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
    -- The fixed window starts at the earliest title, the sitting's or a marked ranking's.
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
       -- A title the sitting itself holds is already one of its titles.
       and not exists (select 1 from feed_ranking_titles frt
                        where frt.event_id = v_event and frt.media_item_id = fe.media_item_id);
  end if;

  /**
   * Published here, and dated here, as 20261023000100 did: `causal_at` is the Feed's
   * keyset, so the post enters the ordering when the sitting ended. `started_at` is the
   * group's first title, which is what a later ranking's window is measured from.
   */
  update feed_events
     set type = 'ranking_batch',
         causal_at = now(),
         created_at = now(),
         payload = payload || jsonb_build_object('count', v_count,
                                                 'started_at', coalesce(v_anchor, v_started))
   where id = v_event;

  if cardinality(v_adopt) > 0 then
    update feed_events set presented_in = v_event where id = any (v_adopt);
    v_count := _group_title_count(v_event);
    update feed_events set payload = payload || jsonb_build_object('count', v_count)
     where id = v_event;
  end if;

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object('status', 'ok', 'event_id', v_event, 'count', v_count)
  );
end;
$$;

comment on function rank_batch_finalize(uuid, uuid) is
  'Ends an Unranked sitting. If the sitting began within feed.ranking_group_minutes of the '
  'first title of the actor''s latest published grouped ranking post, on any ladder '
  '(payload.started_at), its titles join that post: the post keeps its id, conversation, '
  'causal_at and representative, only membership and count grow, and the draft is deleted. '
  'Otherwise it publishes the draft, dated now, and (20261130000200) presents the title-page '
  'first rankings marked groupable inside one window of its start, reviewed or not '
  '(20261130000800). A sitting is never split. Serialised per actor. A sitting that '
  'completed nothing answers empty. Idempotent.';

revoke execute on function rank_batch_finalize(uuid, uuid) from public, anon;
grant execute on function rank_batch_finalize(uuid, uuid) to authenticated;

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

  perform pg_advisory_xact_lock(hashtextextended('ranking_story:' || auth.uid()::text, 0));

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
  returning id into v_event;

  insert into feed_ranking_titles (event_id, media_item_id)
  values (v_event, p_media_item_id)
  on conflict (event_id, media_item_id) do nothing;

  if found then
    perform _ranking_batch_absorb(auth.uid(), p_media_item_id, now() - interval '1 hour', now());
  end if;

  select count(*) into v_count from feed_ranking_titles where event_id = v_event;

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
begin
  if p_actor is null or p_media_item_id is null then
    return null;
  end if;

  -- One writer per actor at a time, taken before anything is read: `for update` cannot lock
  -- a group that does not exist yet, and two devices saving at once must not each start one.
  -- Re-entrant within the transaction, and released at commit.
  perform pg_advisory_xact_lock(hashtextextended('watchlist_story:' || p_actor::text, 0));

  -- Announced once, ever. Read after the lock, so a second device racing the first with the
  -- same title sees the first one's membership and adds nothing. The second clause covers a
  -- post written by a path that predates membership, defensively.
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
    select make_interval(mins => coalesce(
             (select (value)::integer from app_config
               where key = 'feed.watchlist_group_minutes'),
             30))
      into v_window;

    -- The actor's latest group, if its window is still open. Fixed from its own start:
    -- `causal_at` is set once and never moved. Only a post that is a group (it carries a
    -- count) is a candidate, so a historical single-title post is never extended.
    select e.id
      into v_event
      from feed_events e
     where e.actor_id = p_actor
       and e.type = 'watchlist_added'
       and e.presented_in is null
       -- A consolidated history post never grows (Codex, PR 313): a revert restores it.
       and not (e.payload ? 'consolidation_batch')
       and e.payload ? 'count'
       and now() < e.causal_at + v_window
     order by e.causal_at desc, e.id
     limit 1
       for update;
  end if;

  if v_event is null then
    insert into feed_events (actor_id, type, media_item_id, payload, causal_at, causal_step)
    values (
      p_actor, 'watchlist_added', p_media_item_id,
      case when v_grouping then jsonb_build_object('count', 1) else '{}'::jsonb end,
      now(), 0
    )
    returning id into v_event;
  end if;

  insert into feed_watchlist_titles (event_id, actor_id, media_item_id)
  values (v_event, p_actor, p_media_item_id);

  -- The count lives on the row so the Feed can say "and 4 others" without a join. Counted
  -- rather than incremented, so it cannot drift from the members.
  if v_grouping then
    update feed_events
       set payload = payload || jsonb_build_object(
             'count', _group_title_count(v_event))
     where id = v_event;
  end if;

  return v_event;
end;
$$;

comment on function _post_watchlist_activity(uuid, uuid) is
  'Announces one saved title as Feed activity: joins the actor''s latest watchlist group while '
  'now() is within feed.watchlist_group_minutes of that group''s start (fixed window; causal_at '
  'never moves), or starts a new group. Each (actor, title) is announced once, ever '
  '(feed_watchlist_titles_once), so a re-add or a racing second device adds nothing. Serialised '
  'per actor by an advisory lock taken before any read. With feed.watchlist_grouping_enabled '
  'false it writes a single-title post exactly as 20260820000300 did. Internal.';

revoke all on function _post_watchlist_activity(uuid, uuid) from public, anon, authenticated;

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
  -- A cheap look first: almost every comment or reaction is on a visible event, and those
  -- take no lock here at all (Codex, PR 313).
  select presented_in into v_group from feed_events where id = p_event_id;
  if v_group is null then
    return;
  end if;

  /**
   * **One change to a group at a time** (Codex, PR 313). The group's own key, exclusively,
   * before any row lock: two readers reaching two members of one group are serialised here
   * rather than locking rows in opposite orders, and a conversation being written on the
   * group itself holds the same key shared (`_unpresent_on_reference`), so a dissolution
   * waits for it to commit and then sees it.
   */
  perform pg_advisory_xact_lock(hashtextextended('feed_group:' || v_group::text, 0));

  -- `for no key update`, never `for update`: the writer that fired this already holds the
  -- foreign key's key-share lock on the event, and an upgrade could deadlock against
  -- another reader's (Codex, PR 313). Then re-read under the lock.
  perform 1 from feed_events where id in (p_event_id, v_group) order by id for no key update;
  select presented_in into v_group from feed_events where id = p_event_id;
  if v_group is null then
    return;
  end if;

  update feed_events set presented_in = null where id = p_event_id;

  select fe.id, fe.type, fe.media_item_id, fe.payload into v_g from feed_events fe where fe.id = v_group;
  -- A dissolved group is hidden behind a single post; showing it again needs nothing more.
  if v_g.type not in ('ranking_batch', 'watchlist_added') then
    return;
  end if;
  v_count := _group_title_count(v_group);

  /**
   * A group that grouping made (its titles all come from the members it presents) and
   * that nobody has talked about dissolves once it would show one title or none: its last
   * members get their own cards back, and the empty group is hidden behind the member that
   * left, rather than deleted. Nothing is lost and a revert still finds it.
   */
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

  -- Otherwise the group stays, counting what it still shows, and named by a title it
  -- still shows: never by the one that just left it (Codex, PR 313).
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
    select distinct wt.event_id, wt.actor_id
      from feed_watchlist_titles wt
     where wt.media_item_id = old.id
  loop
    -- The writer's own lock, then the post's row (Codex, PR 310): a save joining this group
    -- in a transaction that has not committed holds `watchlist_story:<actor>`, so this waits
    -- for it, and the membership read below runs after it in a fresh snapshot and sees the
    -- member it added. Without this, a one-title group gaining its second title at the same
    -- moment looked single, was skipped, and the cascade then took the whole post and its
    -- conversation. (A save of the very title being deleted can deadlock with this; Postgres
    -- aborts one of the two, and nothing is lost by either retrying.)
    perform pg_advisory_xact_lock(hashtextextended('watchlist_story:' || v_group.actor_id::text, 0));
    perform 1 from feed_events where id = v_group.event_id for update;

    -- Only members whose title still exists (Codex, PR 310). Foreign-key cascades run at the
    -- end of the statement, so in a DELETE that removes several titles the membership rows
    -- of titles deleted earlier in the same statement are still here; the catalogue rows are
    -- not, because a row-level BEFORE trigger sees the effects of the rows its statement has
    -- already processed. Each later row's trigger recomputes, so after the last one the
    -- representative and the count are right, and a group with no surviving title is left to
    -- the cascade, as before.
    select wt.media_item_id
      into v_next
      from feed_watchlist_titles wt
      join media_items mi on mi.id = wt.media_item_id
     where wt.event_id = v_group.event_id and wt.media_item_id <> old.id
     order by wt.id
     limit 1;

    if v_next is null then
      continue;
    end if;

    update feed_events fe
       set media_item_id = case when fe.media_item_id = old.id then v_next
                                else fe.media_item_id end,
           payload = case when fe.payload ? 'count'
                          then fe.payload || jsonb_build_object('count', (
                                 select count(*)
                                   from feed_watchlist_titles wt
                                   join media_items mi on mi.id = wt.media_item_id
                                  where wt.event_id = v_group.event_id
                                    and wt.media_item_id <> old.id))
                          else fe.payload end
     where fe.id = v_group.event_id;
  end loop;

  return old;
end;
$$;

revoke all on function _watchlist_group_keeps_its_post() from public, anon, authenticated;

drop function if exists consolidate_feed_sessions(text, timestamptz, timestamptz, boolean, uuid, boolean, integer, integer);
drop function if exists revert_feed_session_consolidation(text);
drop function if exists _session_consolidation_plan(timestamptz, timestamptz, uuid, boolean, integer);
drop function if exists _session_refresh(uuid);
drop function if exists _open_session(uuid, timestamptz, text, boolean);
drop function if exists _lock_activity_session(uuid);
drop function if exists _activity_session_window();
drop function if exists _activity_sessions_enabled();

delete from app_config where key = 'feed.activity_sessions_enabled';

commit;
