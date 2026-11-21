-- ROLLBACK of 20261130000800_a_reviewed_first_ranking_joins_its_half_hour. STAGING ONLY
-- unless separately approved.
--
-- Restores, verbatim, everything the migration rebuilt or removed:
--
--   * `rank_group_note` and `rank_batch_finalize` as 20261130000200 left them (the live
--     bodies on staging and production before 20261130000800), with their comments and
--     grants;
--   * `_unpresent_on_review` and its trigger `user_media_unpresent_on_review` as
--     20261128000100 created them.
--
-- What comes back: a first ranking whose title has a published review is refused by
-- `rank_group_note` (`reviewed`), is never a peer and is never adopted by a sitting; and a
-- review published on a grouped title gives that ranking its own card again.
--
-- Data: nothing is unhidden or deleted by this script. Groups formed while 20261130000800
-- was in place, reviewed members included, stay ordinary groups and still read as one
-- card. After the rollback, a later write that publishes or edits a review on one of their
-- reviewed members fires the restored trigger and gives that member its card back, which
-- is the 20261130000200 behaviour. To restore those cards at once instead, an operator can
-- run `select _unpresent(fe.id)` over the hidden reviewed members; that is a separate,
-- founder-approved step and is not part of this script.
--
-- Rehearsed in PGlite by supabase/tests/reviewed-rankings-group-rollback.test.mjs.
--
-- One transaction, so a failure leaves the migration fully in place.
begin;

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
  if _feed_title_reviewed(v_me, p_media_item_id) then
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'skipped', 'reason', 'reviewed'));
  end if;
  -- 20261130000200: no test of the watch date. "Today", a recent date, an old one, or none
  -- at all: a first ranking is a first ranking.

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
  -- referenced or reviewed candidate is passed over for the next, never taken.
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
       and not _feed_event_referenced(v_peer.id)
       and not _feed_title_reviewed(v_me, v_peer.media_item_id) then
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
  'Title-page first-ranking grouping (20261128000100, 20261130000200). Groups the caller''s '
  'newest first-time, unreferenced, unreviewed title_ranked post for the title, whatever its '
  'watch date, into the open ranking group (fixed window from its first title, any ladder), '
  'or with an earlier first ranking still on its own, by hiding it behind the group '
  '(presented_in). Serialised on ranking_story:<actor>. Idempotent.';

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
   * and seen, and such a ranking keeps its card.
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
       and not _feed_title_reviewed(fe.actor_id, fe.media_item_id)
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
       and not _feed_title_reviewed(fe.actor_id, fe.media_item_id)
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
  'first rankings marked groupable inside one window of its start. A sitting is never split. '
  'Serialised per actor. A sitting that completed nothing answers empty. Idempotent.';

revoke execute on function rank_batch_finalize(uuid, uuid) from public, anon;
grant execute on function rank_batch_finalize(uuid, uuid) to authenticated;

create or replace function _unpresent_on_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event uuid;
begin
  if new.note_visibility = 'public' and nullif(btrim(coalesce(new.note, '')), '') is not null then
    -- The key grouping and consolidation hold while they hide a ranking (Codex, PR 313):
    -- a review published while a grouping is in flight waits for it, and the read below,
    -- a fresh statement, then sees the hidden member; a grouping that waits for this one
    -- sees the review and leaves the ranking alone.
    perform pg_advisory_xact_lock(hashtextextended('ranking_story:' || new.user_id::text, 0));
    for v_event in
      select fe.id from feed_events fe
       where fe.actor_id = new.user_id and fe.media_item_id = new.media_item_id
         and fe.type = 'title_ranked' and fe.presented_in is not null
    loop
      perform _unpresent(v_event);
    end loop;
  end if;
  return null;
end;
$$;

revoke execute on function _unpresent_on_review() from public, anon, authenticated;

drop trigger if exists user_media_unpresent_on_review on user_media;
create trigger user_media_unpresent_on_review after insert or update of note, note_visibility on user_media
  for each row execute function _unpresent_on_review();

commit;
