-- A group that presents its members (Feed Activity Grouping, PR 2, 2026-11-16).
--
-- See docs/feed/expanded-grouping.md for the whole design. In short:
--
--   * `feed_events.presented_in` names the group a row is shown through. `feed_events_read`
--     hides such a row from every client read, old store binaries included, so a group and
--     its members never both draw a card. Nothing is deleted, rewritten or re-dated: the
--     member keeps its id, type, payload, timestamps and membership, and unhiding it is
--     `presented_in = null`.
--   * A group's titles are its own membership plus its hidden members' titles. The readers
--     (`ranking_batch_titles`, `watchlist_group_titles`, `feed_group_previews`) union them.
--   * Nothing an interaction, a notification, a proactive item or an award names is ever
--     hidden (`_feed_event_referenced`).
--   * Forward: `rank_group_note`, called by the title-page ranking flow only, groups a
--     first-time ranking whose watch evidence is historical. Cross-ladder: a movie, a show
--     and a season can share one social group; every title keeps its own ladder and score.
--   * Retrospective: `consolidate_feed_history` / `revert_feed_consolidation`, operator-only,
--     logged and reversible. Not run in production by this migration.
--
-- Rollback: `feed.ranking_backfill_grouping_enabled` false stops forward grouping; a
-- consolidation batch is reverted by `revert_feed_consolidation`. The column, the policy
-- and the readers stay; with no hidden rows they behave exactly as before.

-- ---------------------------------------------------------------------------
-- 1. The pointer, and the policy that hides what it points from
-- ---------------------------------------------------------------------------

alter table feed_events
  add column if not exists presented_in uuid references feed_events(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'feed_events_presented_in_not_self') then
    alter table feed_events
      add constraint feed_events_presented_in_not_self check (presented_in is distinct from id);
  end if;
end $$;

create index if not exists feed_events_presented_in
  on feed_events (presented_in)
  where presented_in is not null;

drop policy if exists feed_events_read on feed_events;
create policy feed_events_read on feed_events for select
  using (can_i_view(actor_id) and presented_in is null);

insert into app_config (key, value) values
  ('feed.ranking_backfill_grouping_enabled', 'true'::jsonb),
  ('feed.ranking_backfill_days', '7'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. What may never be hidden, and what counts as historical
-- ---------------------------------------------------------------------------

/**
 * True when anything a person can reach points at this event: a comment, a reaction, a
 * notification about it, a proactive item built from it, or an award or goal it caused.
 * Such an event keeps its own card, always.
 */
create or replace function _feed_event_referenced(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from comments c where c.feed_event_id = p_event_id)
      or exists (select 1 from reactions r where r.feed_event_id = p_event_id)
      or exists (select 1 from notifications n
                  where n.subject_type = 'feed_event' and n.subject_id = p_event_id)
      or exists (select 1 from proactive_cluster_actors pa where pa.feed_event_id = p_event_id)
      or exists (select 1 from feed_event_causes fc where fc.feed_event_id = p_event_id);
$$;

/** True when the actor has published a review of the title (a public, non-empty note). */
create or replace function _feed_title_reviewed(p_actor uuid, p_media_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from user_media um
     where um.user_id = p_actor and um.media_item_id = p_media_item_id
       and um.note_visibility = 'public'
       and nullif(btrim(coalesce(um.note, '')), '') is not null
  );
$$;

/**
 * Whether a ranking made at `p_at` is historical backfill rather than an after-watch
 * opinion, from the watch evidence alone: the newest watch event recorded by then.
 *
 *   none, diary                         historical (undated, or an imported diary date)
 *   reader, unattributed, dated old     historical (at least feed.ranking_backfill_days)
 *   today_default, a recent date        after-watch
 *   no watch event                      not decidable, so not historical
 */
create or replace function _ranking_is_historical(p_actor uuid, p_media_item_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with latest as (
    select we.basis, we.watched_on
      from watch_events we
     where we.user_id = p_actor and we.media_item_id = p_media_item_id
       and we.recorded_at <= p_at + interval '1 minute'
     order by we.recorded_at desc, we.id desc
     limit 1
  ),
  days as (
    select greatest(1, coalesce(
             (select (value)::integer from app_config where key = 'feed.ranking_backfill_days'), 7)) as d
  )
  select coalesce((
    select case
             when l.basis in ('none', 'diary') then true
             when l.basis in ('reader', 'unattributed') and l.watched_on is not null
               then l.watched_on <= (p_at at time zone 'utc')::date - (select d from days)
             else false
           end
      from latest l
  ), false);
$$;

revoke execute on function _feed_event_referenced(uuid) from public, anon, authenticated;
revoke execute on function _feed_title_reviewed(uuid, uuid) from public, anon, authenticated;
revoke execute on function _ranking_is_historical(uuid, uuid, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. A group's titles: its own membership, plus its hidden members'
-- ---------------------------------------------------------------------------

/**
 * Every title a group shows, once each, in the order it joined: the group's own membership
 * rows, then (by time) the titles of the members it presents. Not gated: every caller below
 * gates on the group's actor first.
 */
create or replace function _group_titles(p_event_id uuid)
returns table (media_item_id uuid, joined_at timestamptz, tiebreak bigint)
language sql
stable
security definer
set search_path = public
as $$
  with g as (select id, type from feed_events where id = p_event_id),
  raw as (
    select frt.media_item_id, frt.placed_at as joined_at, frt.id as tiebreak
      from g join feed_ranking_titles frt on frt.event_id = g.id
     where g.type = 'ranking_batch'
    union all
    select wt.media_item_id, wt.added_at, wt.id
      from g join feed_watchlist_titles wt on wt.event_id = g.id
     where g.type = 'watchlist_added'
    union all
    -- A presented ranking is one title; a presented watchlist post brings its own rows.
    select fe.media_item_id, fe.created_at, 0
      from g join feed_events fe on fe.presented_in = g.id
     where g.type = 'ranking_batch' and fe.type = 'title_ranked' and fe.media_item_id is not null
    union all
    select wt.media_item_id, wt.added_at, wt.id
      from g join feed_events fe on fe.presented_in = g.id
      join feed_watchlist_titles wt on wt.event_id = fe.id
     where g.type = 'watchlist_added' and fe.type = 'watchlist_added'
  )
  select distinct on (r.media_item_id) r.media_item_id, r.joined_at, r.tiebreak
    from raw r
   order by r.media_item_id, r.joined_at, r.tiebreak;
$$;

revoke execute on function _group_titles(uuid) from public, anon, authenticated;

/** How many titles a group shows, which is what its `payload.count` must say. */
create or replace function _group_title_count(p_event_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from _group_titles(p_event_id);
$$;

revoke execute on function _group_title_count(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Forward grouping of title-page backfill rankings
-- ---------------------------------------------------------------------------

/**
 * Called by the title-page ranking flow after a ranking completes. Never by Unranked,
 * whose sitting has its own draft and its own `rank_batch_note`, and never by an old client,
 * which simply does not group. Everything is re-validated here; the client only says when.
 *
 * Answers `{status}`: `joined` (added to the open group), `grouped` (a new group of this and
 * an earlier backfill ranking), `solo` (eligible, nothing to join yet, marked so a later one
 * can pair with it), or `skipped` with a `reason`.
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

  -- This ranking's own post: the newest, still visible, first-time, and recent. Locked, so
  -- a comment or reaction being written on it is waited for and then seen below.
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
  if _feed_title_reviewed(v_me, p_media_item_id) then
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'skipped', 'reason', 'reviewed'));
  end if;
  if not _ranking_is_historical(v_me, p_media_item_id, v_event.created_at) then
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'skipped', 'reason', 'after_watch'));
  end if;

  -- An open group: the actor's latest visible grouped ranking post whose fixed window,
  -- from its own first title, is still open. Any ladder (cross-ladder social grouping).
  select e.id into v_target
    from feed_events e
   where e.actor_id = v_me
     and e.type = 'ranking_batch'
     and e.presented_in is null
     and e.payload ? 'started_at'
     and now() < (e.payload ->> 'started_at')::timestamptz + v_window
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

  -- No open group: an earlier backfill ranking, still single and untouched, inside the window.
  select fe.id, fe.created_at, fe.causal_at, fe.media_item_id
    into v_peer
    from feed_events fe
   where fe.actor_id = v_me
     and fe.type = 'title_ranked'
     and fe.id <> v_event.id
     and fe.presented_in is null
     and coalesce((fe.payload ->> 'backfill')::boolean, false)
     and now() < fe.created_at + v_window
   order by fe.created_at, fe.id
   limit 1
     for update;

  if v_peer.id is not null
     and not _feed_event_referenced(v_peer.id)
     and not _feed_title_reviewed(v_me, v_peer.media_item_id) then
    -- The group stands where its first title stood: its time and its place in the Feed.
    insert into feed_events (actor_id, type, media_item_id, payload, created_at, causal_at, causal_step)
    values (
      v_me, 'ranking_batch', v_peer.media_item_id,
      jsonb_build_object('count', 2, 'started_at', v_peer.created_at, 'origin', 'title'),
      v_peer.created_at, v_peer.causal_at, 0
    )
    returning id into v_target;
    update feed_events set presented_in = v_target where id in (v_peer.id, v_event.id);
    v_count := _group_title_count(v_target);
    update feed_events set payload = payload || jsonb_build_object('count', v_count)
     where id = v_target;
    return _record_operation_result(p_operation_id,
      jsonb_build_object('status', 'grouped', 'event_id', v_target, 'count', v_count));
  end if;

  update feed_events set payload = payload || jsonb_build_object('backfill', true)
   where id = v_event.id;
  return _record_operation_result(p_operation_id,
    jsonb_build_object('status', 'solo', 'event_id', v_event.id));
end;
$$;

comment on function rank_group_note(uuid, uuid) is
  'Title-page backfill grouping (20261128000100). Groups the caller''s newest first-time, '
  'unreferenced, unreviewed title_ranked post for the title whose watch evidence is '
  'historical into the open ranking group (fixed window from its first title, any ladder), '
  'or with an earlier backfill ranking, by hiding it behind the group (presented_in). '
  'Serialised on ranking_story:<actor>. Idempotent.';

revoke execute on function rank_group_note(uuid, uuid) from public, anon;
grant execute on function rank_group_note(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Following a hidden id to the group that shows it
-- ---------------------------------------------------------------------------

/**
 * For a deep link to an event that is now shown through a group: the group's id, if the
 * caller may see it. Null otherwise, including for an event that is not hidden.
 */
create or replace function feed_event_presentation(p_event_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select g.id
    from feed_events fe
    join feed_events g on g.id = fe.presented_in
   where fe.id = p_event_id
     and g.presented_in is null
     and auth.uid() is not null
     and can_view_profile(auth.uid(), g.actor_id);
$$;

revoke execute on function feed_event_presentation(uuid) from public, anon;
grant execute on function feed_event_presentation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The sitting's two functions, 20261126000100's bodies with three changes
-- ---------------------------------------------------------------------------
--
--   * A group's count is `_group_title_count`, so it includes the rankings it presents.
--   * Only a visible group (`presented_in is null`) is joined.
--   * `rank_batch_finalize` no longer requires the same ladder: one social group may hold
--     movies, shows and seasons. Nothing about a ladder, a position or a score moves.

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
  'first placement of the actor''s latest published grouped ranking post, on any ladder '
  '(payload.started_at, 20261126000100), its titles join that post: the post keeps its id, '
  'conversation, causal_at and representative, only membership and count grow, and the '
  'draft is deleted. Otherwise it publishes the draft as before, dated now, recording '
  'started_at. A sitting is never split. Serialised per actor. A sitting that completed '
  'nothing answers empty. Idempotent.';

revoke execute on function rank_batch_finalize(uuid, uuid) from public, anon;
grant execute on function rank_batch_finalize(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. The readers: a group's own titles plus the ones it presents
-- ---------------------------------------------------------------------------

/**
 * `ranking_batch_titles`, with each row's own `category` (a group may now span ladders, so
 * the sheet labels each standing by its own list) and the titles of the rankings the group
 * presents. The score is derived exactly as before, per title, on its own ladder.
 * Dropped and recreated because the return type gains a column; an older client that
 * reads the first six columns is unaffected.
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
  category      ranking_category
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
    select gt.joined_at, gt.tiebreak, mi.id, mi.title, mi.poster_path,
           r.position, r.category, r.bucket, p.actor_id
      from post p
      cross join lateral _group_titles(p.id) gt
      join media_items mi  on mi.id = gt.media_item_id
      left join rankings r on r.user_id = p.actor_id and r.media_item_id = mi.id
  ),
  bands as (
    select d.category, d.bucket, bb.lo, bb.size
      from (select distinct actor_id, category, bucket from mine where category is not null) d
      cross join lateral band_bounds(d.actor_id, d.category, d.bucket) bb
  )
  select m.id, m.title, m.poster_path, m.position,
         case when m.position is null or b.lo is null then null
              else score_for(m.bucket, (m.position - b.lo + 1)::integer, b.size) end,
         m.bucket, m.category
    from mine m
    left join bands b on b.category = m.category and b.bucket = m.bucket
   order by m.joined_at, m.tiebreak, m.title;
$$;

revoke execute on function ranking_batch_titles(uuid) from public, anon;
grant execute on function ranking_batch_titles(uuid) to authenticated;

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
         (row_number() over (order by gt.joined_at, gt.tiebreak))::integer
    from feed_events fe
    cross join lateral _group_titles(fe.id) gt
    join media_items mi           on mi.id = gt.media_item_id
    left join media_items parent  on parent.id = mi.parent_id
   where fe.id = p_event_id
     and fe.type = 'watchlist_added'
     and fe.presented_in is null
     and auth.uid() is not null
     and can_view_profile(auth.uid(), fe.actor_id)
   order by gt.joined_at, gt.tiebreak;
$$;

/**
 * `feed_group_previews` (20261127000100) over the same union, so a rail shows a presented
 * title as the sheet does. Signature and grants unchanged.
 */
create or replace function feed_group_previews(p_event_ids uuid[], p_limit integer default 12)
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
  ranked        boolean
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
    select p.id as event_id, p.type, p.actor_id, gt.media_item_id,
           (row_number() over (partition by p.id order by gt.joined_at, gt.tiebreak, gt.media_item_id))::integer as ordinal
      from posts p
      cross join lateral _group_titles(p.id) gt
  ),
  shown as (
    select m.*, r.position, r.category, r.bucket
      from members m
      left join rankings r
        on m.type = 'ranking_batch' and r.user_id = m.actor_id and r.media_item_id = m.media_item_id
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
         s.position is not null
    from shown s
    join media_items mi          on mi.id = s.media_item_id
    left join media_items parent on parent.id = mi.parent_id
    left join bands b
      on b.actor_id = s.actor_id and b.category = s.category and b.bucket = s.bucket
   order by s.event_id, s.ordinal;
$$;

-- ---------------------------------------------------------------------------
-- 8. One-time historical consolidation: operator-only, bounded, logged, reversible
-- ---------------------------------------------------------------------------

create table if not exists feed_consolidation_log (
  id              bigint generated always as identity primary key,
  batch           text not null,
  group_event_id  uuid not null,
  -- Null on the row that records the group itself.
  member_event_id uuid,
  -- True when the batch created the group row (ranking); false when it promoted the
  -- burst's earliest watchlist post to be the group, whose prior payload is kept here.
  created_group   boolean not null,
  prior_payload   jsonb,
  logged_at       timestamptz not null default now()
);

create index if not exists feed_consolidation_log_batch on feed_consolidation_log (batch);
alter table feed_consolidation_log enable row level security;
revoke all on feed_consolidation_log from public, anon, authenticated;

/**
 * Consolidates eligible single posts inside `[p_since, p_until)` (at most 8 days) into
 * groups, per actor and per family, in fixed windows of `p_window_minutes` from each
 * window's first eligible post. A window with two or more eligible posts becomes one group;
 * every other post is left exactly as it is.
 *
 * Eligible:
 *   watchlist  a single `watchlist_added` post (no count above one)
 *   ranking    a first-time `title_ranked` post (no update, no rewatch) whose watch
 *              evidence is historical and whose title carries no published review
 * and, for both: visible, not already a group, and nothing references it
 * (`_feed_event_referenced`): no comment, reaction, notification, proactive item or award.
 *
 * A ranking group is a new `ranking_batch` row at its first member's time and place, so
 * it is not newly posted and nobody is notified. A watchlist group is the burst's earliest
 * post, promoted (its prior payload logged), because a title is announced once per actor.
 * Members are hidden, never deleted. Without `p_apply` nothing is written and the same
 * summary is returned.
 */
create or replace function consolidate_feed_history(
  p_batch          text,
  p_since          timestamptz,
  p_until          timestamptz,
  p_apply          boolean default false,
  p_window_minutes integer default 30,
  -- One account only, for a staged rollout or a staging check. Null is everyone.
  p_actor          uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window  interval := make_interval(mins => greatest(1, coalesce(p_window_minutes, 30)));
  v_row     record;
  v_cur_actor uuid;
  v_cur_fam   text;
  v_start     timestamptz;
  v_members   uuid[] := '{}';
  v_groups    integer := 0;
  v_hidden    integer := 0;
  v_groups_wl integer := 0;
  v_groups_rk integer := 0;
  v_candidates jsonb;
  v_excluded  jsonb;
  v_plan      jsonb := '[]'::jsonb;

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

  -- What was looked at and why it was left alone, for the report.
  select jsonb_build_object(
           'referenced', count(*) filter (where _feed_event_referenced(e.id)),
           'reviewed', count(*) filter (where e.type = 'title_ranked'
                                          and _feed_title_reviewed(e.actor_id, e.media_item_id)),
           'not_first', count(*) filter (where e.type = 'title_ranked'
                                           and (coalesce((e.payload ->> 'update')::boolean, false)
                                                or coalesce((e.payload ->> 'again')::boolean, false))),
           'after_watch_or_ambiguous', count(*) filter (
             where e.type = 'title_ranked'
               and not _ranking_is_historical(e.actor_id, e.media_item_id, e.created_at)),
           'already_grouped', count(*) filter (
             where (e.type = 'watchlist_added' and coalesce((e.payload ->> 'count')::integer, 1) > 1)
                or exists (select 1 from feed_events c where c.presented_in = e.id))
         )
    into v_excluded
    from feed_events e
   where e.created_at >= p_since and e.created_at < p_until
     and (p_actor is null or e.actor_id = p_actor)
     and e.presented_in is null
     and e.type in ('watchlist_added', 'title_ranked');

  for v_row in
    select e.id, e.actor_id, e.type, e.media_item_id, e.created_at, e.causal_at,
           case when e.type = 'watchlist_added' then 'watchlist' else 'ranking' end as fam
      from feed_events e
     where e.created_at >= p_since and e.created_at < p_until
       and (p_actor is null or e.actor_id = p_actor)
       and e.presented_in is null
       and e.media_item_id is not null
       and not exists (select 1 from feed_events c where c.presented_in = e.id)
       and (
             (e.type = 'watchlist_added' and coalesce((e.payload ->> 'count')::integer, 1) = 1)
          or (e.type = 'title_ranked'
              and not coalesce((e.payload ->> 'update')::boolean, false)
              and not coalesce((e.payload ->> 'again')::boolean, false)
              and not _feed_title_reviewed(e.actor_id, e.media_item_id)
              and _ranking_is_historical(e.actor_id, e.media_item_id, e.created_at))
       )
       and not _feed_event_referenced(e.id)
     order by e.actor_id, fam, e.created_at, e.id
  loop
    if v_cur_actor is distinct from v_row.actor_id or v_cur_fam is distinct from v_row.fam
       or v_row.created_at >= v_start + v_window then
      if coalesce(array_length(v_members, 1), 0) >= 2 then
        v_plan := v_plan || jsonb_build_object('actor', v_cur_actor, 'family', v_cur_fam,
                                               'members', to_jsonb(v_members));
      end if;
      v_cur_actor := v_row.actor_id;
      v_cur_fam := v_row.fam;
      v_start := v_row.created_at;
      v_members := array[v_row.id];
    else
      v_members := v_members || v_row.id;
    end if;
  end loop;
  if coalesce(array_length(v_members, 1), 0) >= 2 then
    v_plan := v_plan || jsonb_build_object('actor', v_cur_actor, 'family', v_cur_fam,
                                           'members', to_jsonb(v_members));
  end if;

  select jsonb_build_object(
           'watchlist', count(*) filter (where p ->> 'family' = 'watchlist'),
           'ranking', count(*) filter (where p ->> 'family' = 'ranking'),
           'members', coalesce(sum(jsonb_array_length(p -> 'members')), 0)
         )
    into v_candidates
    from jsonb_array_elements(v_plan) p;

  if p_apply then
    declare
      v_group  jsonb;
      v_ids    uuid[];
      v_first  record;
      v_target uuid;
      v_live   uuid[];
    begin
      for v_group in select * from jsonb_array_elements(v_plan) loop
        select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(v_group -> 'members') x;
        perform pg_advisory_xact_lock(hashtextextended('ranking_story:' || (v_group ->> 'actor'), 0));
        perform pg_advisory_xact_lock(hashtextextended('watchlist_story:' || (v_group ->> 'actor'), 0));

        -- Locked first, then re-read in a fresh statement (Codex, PR 313): a comment or
        -- reaction in flight holds a key-share lock, so this waits for it, and the check
        -- below then sees what committed. Under these locks nothing new can reference them
        -- without the `_unpresent_on_reference` triggers putting the card back.
        perform 1 from feed_events where id = any (v_ids) order by id for update;
        select array_agg(fe.id order by fe.created_at, fe.id) into v_live
          from feed_events fe
         where fe.id = any (v_ids) and fe.presented_in is null
           and not _feed_event_referenced(fe.id)
           and (fe.type <> 'title_ranked' or not _feed_title_reviewed(fe.actor_id, fe.media_item_id));
        if coalesce(array_length(v_live, 1), 0) < 2 then
          continue;
        end if;

        select * into v_first from feed_events where id = v_live[1];

        if v_group ->> 'family' = 'ranking' then
          insert into feed_events (actor_id, type, media_item_id, payload, created_at, causal_at, causal_step)
          values (
            v_first.actor_id, 'ranking_batch', v_first.media_item_id,
            -- No `started_at` (Codex, PR 313): a history group has no open window, so no
            -- sitting or title-page ranking ever joins it and a revert loses nothing.
            jsonb_build_object('count', array_length(v_live, 1),
                               'origin', 'history', 'consolidation_batch', p_batch),
            v_first.created_at, v_first.causal_at, 0
          )
          returning id into v_target;
          insert into feed_consolidation_log (batch, group_event_id, member_event_id, created_group)
          values (p_batch, v_target, null, true);
          update feed_events set presented_in = v_target where id = any (v_live);
          insert into feed_consolidation_log (batch, group_event_id, member_event_id, created_group)
          select p_batch, v_target, m, true from unnest(v_live) m;
          v_groups_rk := v_groups_rk + 1;
          v_hidden := v_hidden + array_length(v_live, 1);
        else
          v_target := v_first.id;
          insert into feed_consolidation_log (batch, group_event_id, member_event_id, created_group, prior_payload)
          values (p_batch, v_target, null, false, v_first.payload);
          update feed_events set presented_in = v_target where id = any (v_live[2:]);
          insert into feed_consolidation_log (batch, group_event_id, member_event_id, created_group)
          select p_batch, v_target, m, false from unnest(v_live[2:]) m;
          v_groups_wl := v_groups_wl + 1;
          v_hidden := v_hidden + array_length(v_live, 1) - 1;
        end if;

        update feed_events
           set payload = payload || jsonb_build_object('count', _group_title_count(v_target),
                                                       'consolidation_batch', p_batch)
         where id = v_target;
        v_groups := v_groups + 1;
      end loop;
    end;
  end if;

  return jsonb_build_object(
    'batch', p_batch,
    'applied', p_apply,
    'since', p_since,
    'until', p_until,
    'window_minutes', extract(epoch from v_window) / 60,
    'planned_groups', v_candidates,
    'excluded', v_excluded,
    'applied_groups', jsonb_build_object('watchlist', v_groups_wl, 'ranking', v_groups_rk),
    'hidden_posts', v_hidden
  );
end;
$$;

/**
 * Undoes one batch: every member it hid is shown again, a ranking group it created is
 * deleted unless somebody has since reacted to it or commented on it (then it stays, its
 * members stay hidden behind it, and it is reported), and a promoted watchlist post gets
 * its prior payload back.
 */
create or replace function revert_feed_consolidation(p_batch text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kept     uuid[] := '{}';
  v_deleted  integer := 0;
  v_restored integer := 0;
  v_shown    integer := 0;
  v_g        record;
begin
  for v_g in
    select group_event_id, created_group, prior_payload
      from feed_consolidation_log
     where batch = p_batch and member_event_id is null
  loop
    -- Locked, then checked in a fresh statement (Codex, PR 313): a comment or reaction being
    -- written on the group is waited for and seen, and never cascaded away by the delete.
    perform 1 from feed_events where id = v_g.group_event_id for update;
    if v_g.created_group and _feed_event_referenced(v_g.group_event_id) then
      v_kept := v_kept || v_g.group_event_id;
      continue;
    end if;

    update feed_events fe set presented_in = null
      from feed_consolidation_log l
     where l.batch = p_batch and l.group_event_id = v_g.group_event_id
       and l.member_event_id = fe.id and fe.presented_in = v_g.group_event_id;
    get diagnostics v_shown = row_count;

    if v_g.created_group then
      delete from feed_events where id = v_g.group_event_id;
      v_deleted := v_deleted + 1;
    else
      update feed_events set payload = v_g.prior_payload where id = v_g.group_event_id;
      v_restored := v_restored + 1;
    end if;
  end loop;

  delete from feed_consolidation_log
   where batch = p_batch and not (group_event_id = any (v_kept));

  return jsonb_build_object('batch', p_batch, 'deleted_groups', v_deleted,
                            'restored_posts', v_restored, 'kept_with_conversation', to_jsonb(v_kept));
end;
$$;

revoke execute on function consolidate_feed_history(text, timestamptz, timestamptz, boolean, integer, uuid) from public, anon, authenticated;
revoke execute on function revert_feed_consolidation(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. The watchlist writer: 20261125000100's body, joining only a visible group and
--    counting the titles the group presents
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 10. A hidden member that gains a conversation or a review gets its card back
-- ---------------------------------------------------------------------------
--
-- Codex, PR 313. Grouping checks for references under lock, but a device still showing the
-- single card can write after grouping commits: every comment, reaction, notification or
-- proactive item, and every published review, is caught here instead, whoever writes it
-- (old binaries included). The member is shown again on its own, exactly as it was, and
-- its group's count drops by its title. Nothing is deleted and nothing moves.

create or replace function _unpresent(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group uuid;
begin
  select presented_in into v_group from feed_events where id = p_event_id for update;
  if v_group is null then
    return;
  end if;
  update feed_events set presented_in = null where id = p_event_id;
  update feed_events
     set payload = payload || jsonb_build_object('count', _group_title_count(v_group))
   where id = v_group;
end;
$$;

create or replace function _unpresent_on_reference()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name in ('comments', 'reactions', 'proactive_cluster_actors') then
    perform _unpresent(new.feed_event_id);
  elsif tg_table_name = 'notifications' and new.subject_type = 'feed_event' then
    perform _unpresent(new.subject_id);
  end if;
  return null;
end;
$$;

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

revoke execute on function _unpresent(uuid) from public, anon, authenticated;
revoke execute on function _unpresent_on_reference() from public, anon, authenticated;
revoke execute on function _unpresent_on_review() from public, anon, authenticated;

drop trigger if exists comments_unpresent on comments;
create trigger comments_unpresent after insert on comments
  for each row execute function _unpresent_on_reference();
drop trigger if exists reactions_unpresent on reactions;
create trigger reactions_unpresent after insert on reactions
  for each row execute function _unpresent_on_reference();
drop trigger if exists notifications_unpresent on notifications;
create trigger notifications_unpresent after insert on notifications
  for each row execute function _unpresent_on_reference();
drop trigger if exists proactive_cluster_actors_unpresent on proactive_cluster_actors;
create trigger proactive_cluster_actors_unpresent after insert on proactive_cluster_actors
  for each row execute function _unpresent_on_reference();
drop trigger if exists user_media_unpresent_on_review on user_media;
create trigger user_media_unpresent_on_review after insert or update of note, note_visibility on user_media
  for each row execute function _unpresent_on_review();
