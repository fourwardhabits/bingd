-- A backlog half hour is one post (Feed Activity Grouping, PR B, 2026-11-15).
--
-- ---------------------------------------------------------------------------
-- WHAT CHANGES, AND WHAT DOES NOT
-- ---------------------------------------------------------------------------
--
-- An Unranked sitting is already one post (20261020000100), drafted invisibly while it
-- runs and published when it ends (20261023000100). What it could not do is consolidate
-- with the sitting before it: somebody who ranks ten films, steps out, and comes back ten
-- minutes later for ten more put two posts in every follower's Feed.
--
-- Now, when a sitting ends, `rank_batch_finalize` looks for the actor's latest published
-- grouped ranking post **on the same ladder** whose window is still open, and if the sitting
-- **began** inside that window (at or after the group's start, before it closes), the
-- sitting's titles join that post instead of publishing a second one. Otherwise it publishes
-- exactly as before. Two sittings ended out of start order (two devices, the earlier one
-- ending second) are therefore two posts: the earlier one began before the group it would
-- join, and joining it would stretch that group's window backwards.
--
--   * **The window** is `feed.ranking_group_minutes` (30) from the group's own first
--     placement, recorded at publication as `payload.started_at`. Fixed, not sliding; no
--     closing job. A post published before this migration carries no `started_at` and is
--     never extended: history is not combined.
--   * **A sitting is atomic.** It joins whole or publishes whole; it is never split. One
--     that began inside the window and ran past it joins; a single long sitting is one
--     post, as it always was. Splitting a sitting would mean publishing part of a draft
--     early or moving members between published posts, which is the instability the
--     draft exists to prevent.
--   * **Joining happens only at the end of a sitting**, never while it runs, so nobody
--     watches a published post's count tick up as somebody ranks (the QA finding that
--     introduced the draft). The draft stays invisible until then, exactly as before.
--   * **The published post is never deleted or rewritten to merge.** It keeps its id, its
--     comments and reactions, its `causal_at` (so its place in the Feed) and its
--     representative title; only its membership and count grow. The draft that joined it
--     is deleted, and only if nobody has commented on or reacted to it (a draft is not in
--     any activity read, so that is defensive); otherwise it publishes on its own.
--   * **Same ladder only.** A movie sitting never joins a TV-season post, judged by the
--     representative titles' kind, which is what the sheet's `#7 in Movies` label reads.
--   * **Eligibility is the workflow's.** Only the Unranked flow calls `rank_batch_note` and
--     `rank_batch_finalize`; nothing here infers a backlog ranking from a timestamp. After-
--     watch rankings, reviews, corrections and reranks never reach these functions and
--     keep their own posts.
--   * **Rankings are untouched**: no ladder, position, score, watch date or Collection
--     write. Watchlist posts are a different type and never a candidate.
--
-- Rollback: `feed.ranking_grouping_enabled` false publishes every sitting on its own, as
-- 20261023000100 did. Nothing already joined is split back; nothing is deleted.

insert into app_config (key, value) values
  ('feed.ranking_grouping_enabled', 'true'::jsonb),
  ('feed.ranking_group_minutes', '30'::jsonb)
on conflict (key) do nothing;

-- The window probe: the actor's latest published grouped ranking post.
create index if not exists feed_events_ranking_window
  on feed_events (actor_id, causal_at desc)
  where type = 'ranking_batch';

/**
 * Where a joined sitting went (Codex, PR 311). The app fires `rank_batch_note` without
 * waiting for it, so a sitting's last placement can still be in flight when the sitting
 * ends. Joining deletes the draft that carried the sitting's key, and a note arriving after
 * that would otherwise draft a new, invisible post that nothing ever finalises, losing the
 * title. `rank_batch_note` reads this first and adds the title to the group the sitting
 * joined, as it adds a late title to a sitting published on its own. Same no-policy rule as
 * `feed_ranking_titles`: nothing reads it but these two functions.
 */
create table if not exists feed_ranking_sitting_joins (
  actor_id  uuid not null,
  sitting   uuid not null,
  event_id  uuid not null references feed_events(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (actor_id, sitting)
);

create index if not exists feed_ranking_sitting_joins_event
  on feed_ranking_sitting_joins (event_id);

alter table feed_ranking_sitting_joins enable row level security;
revoke all on feed_ranking_sitting_joins from public, anon, authenticated;

/**
 * `rank_batch_note`, 20261023000100's body behind two additions (Codex, PR 311):
 *
 *   * It takes the actor's `ranking_story` key first, the one `rank_batch_finalize` holds,
 *     so a note and the end of its sitting are never interleaved: the note lands in the
 *     draft before the join reads it, or it lands after and finds the join.
 *   * A sitting that joined a group sends its late title to that group, which keeps its
 *     representative, id and conversation; only membership and count grow, as at a join.
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
    join feed_events e on e.id = j.event_id and e.type = 'ranking_batch'
   where j.actor_id = auth.uid() and j.sitting = p_sitting;

  if v_joined is not null then
    insert into feed_ranking_titles (event_id, media_item_id)
    values (v_joined, p_media_item_id)
    on conflict (event_id, media_item_id) do nothing;

    if found then
      perform _ranking_batch_absorb(auth.uid(), p_media_item_id, now() - interval '1 hour', now());
    end if;

    select count(*) into v_count from feed_ranking_titles where event_id = v_joined;

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
  v_kind    media_kind;
  v_window  interval;
  v_target  uuid;
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

  -- The open group this sitting may join: same actor, same ladder, published by this
  -- migration's rule (it has a start), and the sitting began inside its window.
  if not exists (
       select 1 from app_config
        where key = 'feed.ranking_grouping_enabled' and value = 'false'::jsonb
     )
     -- A draft somebody has already reacted to or commented on keeps its own identity.
     and not exists (select 1 from comments  where feed_event_id = v_event)
     and not exists (select 1 from reactions where feed_event_id = v_event)
  then
    select make_interval(mins => coalesce(
             (select (value)::integer from app_config where key = 'feed.ranking_group_minutes'),
             30))
      into v_window;

    select mi.kind into v_kind
      from feed_events fe join media_items mi on mi.id = fe.media_item_id
     where fe.id = v_event;

    select e.id
      into v_target
      from feed_events e
      join media_items mi on mi.id = e.media_item_id
     where e.actor_id = auth.uid()
       and e.type = 'ranking_batch'
       and e.payload ? 'started_at'
       and mi.kind = v_kind
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

    select count(*) into v_count from feed_ranking_titles where event_id = v_target;

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
   * Published here, and dated here, as 20261023000100 did: `causal_at` is the Feed's
   * keyset, so the post enters the ordering when the sitting ended. `started_at` is the
   * group's first placement, which is what a later sitting's window is measured from.
   */
  update feed_events
     set type = 'ranking_batch',
         causal_at = now(),
         created_at = now(),
         payload = payload || jsonb_build_object('count', v_count, 'started_at', v_started)
   where id = v_event;

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object('status', 'ok', 'event_id', v_event, 'count', v_count)
  );
end;
$$;

comment on function rank_batch_finalize(uuid, uuid) is
  'Ends an Unranked sitting. If the sitting began within feed.ranking_group_minutes of the '
  'first placement of the actor''s latest published grouped ranking post on the same ladder '
  '(payload.started_at, 20261126000100), its titles join that post: the post keeps its id, '
  'conversation, causal_at and representative, only membership and count grow, and the '
  'draft is deleted. Otherwise it publishes the draft as before, dated now, recording '
  'started_at. A sitting is never split. Serialised per actor. A sitting that completed '
  'nothing answers empty. Idempotent.';

revoke execute on function rank_batch_finalize(uuid, uuid) from public, anon;
grant execute on function rank_batch_finalize(uuid, uuid) to authenticated;
