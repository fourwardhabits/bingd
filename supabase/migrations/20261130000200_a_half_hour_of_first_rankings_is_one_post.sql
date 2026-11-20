-- A half hour of first rankings is one post (founder report, 2026-11-20).
--
-- 20261128000100 grouped a title-page ranking only when its watch evidence was
-- "historical": `_ranking_is_historical` refused `today_default`, a reader date less than
-- `feed.ranking_backfill_days` old, and a ranking with no watch event. In production that
-- left 184 of 199 first rankings standalone: the log sheet offers "Today", and almost
-- everybody keeps it. The founder's rule replaces it:
--
--   Two or more eligible FIRST-TIME rankings by the same person inside one fixed
--   30-minute window are one grouped ranking post, whatever watch date was chosen.
--
-- What is eligible is unchanged apart from the date: a visible `title_ranked` post that is a
-- first ranking (no `update`, no `again`: a rewatch keeps its own card), that nothing
-- references (`_feed_event_referenced`: comments, reactions, notifications, proactive
-- items, award causes), and whose title has no published review. Watchlist saves are a
-- different family and are never candidates. Corrections, manual moves, reranks and Refine
-- post nothing (20261129000300), so there is nothing of theirs to group.
--
-- The mechanism is 20261128000100's, unchanged: a group is a `ranking_batch` row, and each
-- member is hidden behind it through `presented_in`, never deleted or rewritten. Nothing
-- here writes a watch event, a placement, a ranking or a notification.
--
-- Changes:
--
--   1. `rank_group_note`: the historical test is gone. The window is measured from the
--      ranking's own post time (not the moment the client's note arrives), so a note that
--      arrives a little late groups the same way. A solo first ranking is marked
--      `payload.groupable` (a post marked `backfill` by 20261128000100 still pairs).
--   2. `rank_batch_finalize`: an Unranked sitting that ends with no open group adopts the
--      title-page first rankings already marked inside its window, so a title page and a
--      backlog sitting in one half hour are one post too. 20261128000100's body otherwise.
--   3. `consolidate_feed_history`: the same eligibility, without the historical test, so a
--      later operator consolidation follows the same rule. Still operator-only, bounded,
--      logged and reversible; not run by this migration.
--   4. `_ranking_is_historical` and `feed.ranking_backfill_days` are removed: nothing reads
--      them any more.
--
-- Kill switch (unchanged): `feed.ranking_backfill_grouping_enabled` false stops title-page
-- grouping. Rollback: docs/release/ranking-grouping-window/rollback-20261130000200.sql.

-- ---------------------------------------------------------------------------
-- 1. Title-page first rankings: grouped by time alone
-- ---------------------------------------------------------------------------

/**
 * Called by the ranking sheet after a first ranking completes, from every surface but
 * Unranked (whose sitting has its own draft). Old clients never call it, and simply do not
 * group. Everything is re-validated here; the client only says when.
 *
 * Answers `{status}`: `joined` (added to the open group), `grouped` (a new group of this and
 * an earlier first ranking still on its own), `solo` (eligible, nothing to join yet, marked
 * so the next one can pair with it), or `skipped` with a `reason`.
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

-- ---------------------------------------------------------------------------
-- 2. An Unranked sitting adopts the title-page rankings of its half hour
-- ---------------------------------------------------------------------------
--
-- 20261128000100's body, with one addition where it used to publish the draft on its own:
-- the first rankings that `rank_group_note` marked `groupable` (or `backfill`) inside one
-- window of the sitting's start are presented by the sitting's post as well. The window is
-- fixed from the earliest title, the sitting's or theirs. The post is still dated when the
-- sitting ends, as always; the adopted cards leave the Feed and their titles appear in the
-- post. A marked ranking that has since been referenced or reviewed is never adopted.

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

-- ---------------------------------------------------------------------------
-- 3. Operator consolidation: the same eligibility, without the historical test
-- ---------------------------------------------------------------------------
--
-- 20261128000100's body with the two `_ranking_is_historical` uses removed: the
-- `after_watch_or_ambiguous` exclusion count is gone from the report, and a first ranking
-- is eligible whatever its watch date. Everything else (bounds, locks, the re-check under
-- lock, the log, the revert) is unchanged.

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
              and not _feed_title_reviewed(e.actor_id, e.media_item_id))
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

revoke execute on function consolidate_feed_history(text, timestamptz, timestamptz, boolean, integer, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The retired date rule
-- ---------------------------------------------------------------------------

drop function if exists _ranking_is_historical(uuid, uuid, timestamptz);
delete from app_config where key = 'feed.ranking_backfill_days';
