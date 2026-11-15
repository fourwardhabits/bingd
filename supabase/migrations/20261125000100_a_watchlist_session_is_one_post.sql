-- A watchlist session is one post (Feed Activity Grouping, PR A, 2026-11-15).
--
-- ---------------------------------------------------------------------------
-- WHAT CHANGES
-- ---------------------------------------------------------------------------
--
-- Saving twelve titles in a sitting used to put twelve `watchlist_added` posts in every
-- follower's Feed. Now the first save in a 30-minute window creates the post, and every
-- save after it inside that window joins the same post as a member:
--
--   * **One stable social object.** The post keeps its id, so its comments and reactions,
--     and its `causal_at`, so its place in the Feed's keyset order: it never jumps to the
--     top as it grows (20260912000100's rule for follow stories, and 20261020000100's for
--     ranking sittings). Its `media_item_id` stays the first title saved, which is what a
--     single-title reader (every store binary in the field) draws.
--   * **A fixed window, not a sliding one.** A save joins the actor's latest group only
--     while `now()` is within `feed.watchlist_group_minutes` (30) of that group's own
--     start. No inactivity timer and no closing job: an expired group simply stops being
--     appended to, and the next save starts another.
--   * **Watchlist only.** Rankings are untouched; a `ranking_batch` is never a candidate.
--
-- ---------------------------------------------------------------------------
-- THE DURABLE ANNOUNCEMENT, RECONCILED
-- ---------------------------------------------------------------------------
--
-- 20260820000300 made each (actor, title) announceable once, ever, with the partial unique
-- index `feed_events_watchlist_once`: a remove and a re-add restored the row without a
-- second post, because the first post's conversation is the one that lasts. That guarantee
-- moves to **membership**: `feed_watchlist_titles_once` is unique on (actor, title), and
-- every existing `watchlist_added` event is backfilled below as a one-title group of its
-- own, so a title announced before this migration can never be announced again either.
--
-- The old index is **kept**, and stays true: a group's `media_item_id` is its first member,
-- and a title is a member of at most one group, so no two events can share (actor, title).
-- It is now the second lock rather than the first.
--
-- ---------------------------------------------------------------------------
-- COMPATIBILITY
-- ---------------------------------------------------------------------------
--
--   * `set_watchlist(uuid, uuid, boolean)` keeps its signature, grants and return values.
--     The watchlist row is written exactly as before, and before the Feed is touched.
--   * A group is an ordinary `watchlist_added` row with `media_item_id` set and
--     `payload.count` added. A binary that predates this reads it as the single-title post
--     it always drew; a current one reads the count and opens the members.
--   * The membership table has a surrogate key, so PostgREST does not take it for a
--     feed_events <-> media_items junction and every existing `media_items:media_item_id`
--     embed keeps resolving (the lesson of 20261022000100).
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--
-- `feed.watchlist_grouping_enabled` false: the next save writes a single-title post exactly
-- as 20260820000300 did (with its membership row, so the once-ever guarantee holds), and no
-- existing group is touched. Groups, members, comments and reactions all survive. Nothing
-- here needs reversing to roll the client back.

-- ---------------------------------------------------------------------------
-- 1. Membership
-- ---------------------------------------------------------------------------

create table if not exists feed_watchlist_titles (
  id            bigint generated always as identity primary key,
  event_id      uuid not null references feed_events(id) on delete cascade,
  actor_id      uuid not null references profiles(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  added_at      timestamptz not null default now(),
  constraint feed_watchlist_titles_once unique (actor_id, media_item_id)
);

comment on table feed_watchlist_titles is
  'The titles in one watchlist_added feed post, in the order they were saved (id). '
  'feed_watchlist_titles_once makes each (actor, title) announceable once, ever, which is '
  'the remove/re-add guarantee 20260820000300 gave the event itself. NOT client-readable: '
  'RLS on, no policy, no grant. Read through watchlist_group_titles(), which applies the '
  'feed row''s own visibility. Surrogate key on purpose (see 20261022000100).';

create index if not exists feed_watchlist_titles_event
  on feed_watchlist_titles (event_id, id);

alter table feed_watchlist_titles enable row level security;
revoke all on feed_watchlist_titles from public, anon, authenticated;

-- The window probe: the actor's latest watchlist post, by the column the Feed pages on.
create index if not exists feed_events_watchlist_window
  on feed_events (actor_id, causal_at desc)
  where type = 'watchlist_added';

-- Every post that exists today is a one-title group of its own. Historical posts are never
-- combined: none of them carries `payload.count`, and only a post that does is appended to.
insert into feed_watchlist_titles (event_id, actor_id, media_item_id, added_at)
select fe.id, fe.actor_id, fe.media_item_id, fe.created_at
  from feed_events fe
 where fe.type = 'watchlist_added'
   and fe.media_item_id is not null
 order by fe.created_at, fe.id
on conflict (actor_id, media_item_id) do nothing;

insert into app_config (key, value) values
  ('feed.watchlist_grouping_enabled', 'true'::jsonb),
  ('feed.watchlist_group_minutes', '30'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The writer
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
             'count', (select count(*) from feed_watchlist_titles where event_id = v_event))
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

create or replace function set_watchlist(
  p_operation_id  uuid,
  p_media_item_id uuid,
  p_present       boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_watchlist') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  if p_present is null then
    raise exception 'present is required' using errcode = '22023';
  end if;

  -- Refuses an id that is not a title, before anything is written.
  perform _media_kind(p_media_item_id);

  if p_present then
    insert into watchlist (user_id, media_item_id)
    values (auth.uid(), p_media_item_id)
    on conflict (user_id, media_item_id) do nothing;

    -- Same transaction: the post and the row commit together or not at all, and no
    -- temporary post is ever written to be deleted later.
    perform _post_watchlist_activity(auth.uid(), p_media_item_id);
  else
    -- The post outlives the row: "added" is a past-tense fact, and deleting it would take
    -- other people's reactions and comments with it.
    delete from watchlist
     where user_id = auth.uid() and media_item_id = p_media_item_id;
  end if;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function set_watchlist(uuid, uuid, boolean) is
  'Adds or removes one title on the caller''s watchlist. An add also announces the title as '
  'Feed activity in the same transaction (_post_watchlist_activity, 20261125000100): saves '
  'within one 30-minute window are one post, and each title is announced once, ever, so a '
  're-add restores the row without new activity. A removal deletes the row and leaves the '
  'post and its membership. Idempotent by the operation ledger.';

-- ---------------------------------------------------------------------------
-- 3. The member list
-- ---------------------------------------------------------------------------

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
  /**
   * Gated on the post being one the caller may see at all: `can_view_profile` on the
   * post's own actor, which is the predicate the Feed is built on, read from the row and
   * never taken from the caller. A post the caller may not see returns nothing, the same
   * silence a deleted post gives.
   */
  select mi.id, mi.kind, mi.title, mi.season_number, mi.release_date, mi.poster_path,
         parent.title,
         (row_number() over (order by wt.id))::integer
    from feed_events fe
    join feed_watchlist_titles wt on wt.event_id = fe.id
    join media_items mi           on mi.id = wt.media_item_id
    left join media_items parent  on parent.id = mi.parent_id
   where fe.id = p_event_id
     and fe.type = 'watchlist_added'
     and auth.uid() is not null
     and can_view_profile(auth.uid(), fe.actor_id)
   order by wt.id;
$$;

comment on function watchlist_group_titles(uuid) is
  'Every title in one watchlist_added post, in the order they were saved, with what a title '
  'row needs. Visibility is the feed row''s own (can_view_profile on its actor). The only read '
  'path into feed_watchlist_titles.';

revoke execute on function watchlist_group_titles(uuid) from public, anon;
grant execute on function watchlist_group_titles(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. A post outlives its first title
-- ---------------------------------------------------------------------------
--
-- `feed_events.media_item_id` cascades from `media_items`, so removing a group's
-- representative title from the catalogue would delete the whole post and every comment
-- and reaction on it. Before such a delete, a group with other members takes its next
-- member as representative, and its count drops by one. A one-title post goes, as before.
-- Catalogue deletion is an operator action (nothing in the app deletes media_items).

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

drop trigger if exists watchlist_group_keeps_its_post on media_items;
create trigger watchlist_group_keeps_its_post
  before delete on media_items
  for each row
  execute function _watchlist_group_keeps_its_post();
