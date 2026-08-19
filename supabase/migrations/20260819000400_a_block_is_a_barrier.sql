-- A block is a barrier, not a filter.
--
-- ---------------------------------------------------------------------------
-- What this fixes, and how it was found
-- ---------------------------------------------------------------------------
--
-- Independent review 23b named this race and could only argue about it, because
-- every test in this repository ran against PGlite — one connection, therefore one
-- transaction, therefore no race can be constructed by any amount of effort. It was
-- closed on the *read* side (`my_notifications` gained `can_discover_profile`) and
-- carried forward as hardening blocker B.
--
-- It is now reproduced. `supabase/tests/concurrency` runs the real migrations against
-- a real PostgreSQL with independent connections, and pauses a writer inside its own
-- SECURITY DEFINER body with a barrier trigger. Three writers fail, deterministically
-- and also at natural timing over fifty repeats:
--
--     T1  add_comment / set_reaction / set_watch_tags
--         passes its visibility or eligibility check
--     T2  block()  --  takes the pair lock, deletes both inboxes, commits in full
--     T1  inserts its notifications row and commits
--
--     -> a notifications row exists between a blocked pair.
--
-- That row is not stale history. `block` deletes every row between the pair, and
-- every writer is refused afterwards by `_assert_reachable`, `can_view_profile` or
-- `_is_mutual_follow` — so under the product model no such row can exist at all. Its
-- presence means a writer committed inside the window the block was meant to close.
--
-- The read-side filter still hides it, and that fix is not being removed. But a row
-- nobody may read is still a row: it survives a later `unblock`, it is what a future
-- push worker would read (AD-10 leaves delivery dark, not absent), and it is a record
-- of contact between two people who have severed it.
--
-- ---------------------------------------------------------------------------
-- The fix is the one the schema already had, applied to the writers that missed it
-- ---------------------------------------------------------------------------
--
-- `follow`, `unfollow`, `respond_follow_request`, `remove_follower`, `block`,
-- `unblock` and `recommend_title` all take `_lock_pair` **before** the check that
-- reads `follows` and `blocks`, for exactly this reason — 20260817000200 says so in
-- its header, and the concurrency suite now proves it holds for them.
--
-- `add_comment`, `set_reaction` and `set_watch_tags` were written at three different
-- times and none of them took it. Nothing about them is special; they were simply the
-- three notification writers not in 20260817000200. So the fix is not a new mechanism,
-- it is the existing one applied to every writer of the shape
--
--     resolve the other party -> check the relationship -> insert an inbox row
--
-- and the shape, rather than the three reproduced sequences, is what the tests assert.
--
-- The ordering inside each function is: **check, then lock, then check again.** The
-- pair is not known until the feed event has been read, so a lock cannot come first;
-- and the check cannot simply move after the lock either, for the reason below.
--
-- ---------------------------------------------------------------------------
-- Why the check is made twice rather than once after the lock
-- ---------------------------------------------------------------------------
--
-- The first draft of this migration resolved `feed_events.actor_id` **without** the
-- visibility predicate, locked the pair, and then checked visibility once. Independent
-- review 25 found that this is an information leak, and it is a deterministic one
-- rather than a statistical one:
--
--   * a feed event that does not exist raises P0002 immediately, having taken no lock;
--   * a feed event that exists but is not viewable resolves an actor and then *waits*
--     on that actor's pair lock.
--
-- and `unfollow` deliberately has no reachability check, so **any caller can hold
-- `_lock_pair(self, X)` against any account they can name**, simply by opening a
-- transaction and unfollowing them. Hold that lock, call `add_comment` with a feed
-- event id, and whether the call hangs tells you whether that event belongs to X —
-- for an account that has blocked you, or gone private, or deleted the event.
--
-- That is the same shape as the oracle review 22 closed on `can_discover_profile`: a
-- private fact recovered one probe at a time from a difference in behaviour rather
-- than from a difference in the answer. Equal error codes do not close it, because
-- the observable is the wait.
--
-- So the original combined existence-and-visibility query is kept exactly as it was,
-- and it still runs **before any lock is taken**. A caller who may not view the event
-- is refused on that line, immediately, having caused no contention — which is the
-- behaviour this schema had before this migration and must keep. Only a caller who
-- has already passed goes on to lock the pair, and the second check under the lock is
-- what closes N1: by then a concurrent block has either committed and is seen, or is
-- queued behind this transaction and will delete what it wrote.
--
-- The second check discloses nothing new, because the caller reaching it has already
-- been told the event is viewable.
--
-- ---------------------------------------------------------------------------
-- Why nothing here can deadlock
-- ---------------------------------------------------------------------------
--
-- `set_watch_tags` is the only writer in the schema that touches more than one pair,
-- so it is the only one that could deadlock against itself. It takes its locks
-- **ordered by the tagged account's uuid**, so two devices saving the same picker
-- with the list in opposite orders take the same keys in the same order. Every other
-- writer takes exactly one pair lock, and a transaction holding one lock and wanting
-- none cannot be part of a cycle.
--
-- The account-scoped lock in `_assert_operation_rate` is always taken first and is
-- always keyed on `auth.uid()`, so no transaction ever takes a pair lock before an
-- account lock. That ordering is uniform across every writer and is what keeps the
-- two lock families from forming a cycle between them.
--
-- Both properties are asserted in `supabase/tests/concurrency/races/lock-pair.mjs`
-- against real sessions, not argued here.
--
-- ---------------------------------------------------------------------------
-- Rebuilt in full, not patched
-- ---------------------------------------------------------------------------
--
-- Each function below is restated whole from its current definition. 20260817001300
-- records why: a `create or replace` assembled from the wrong ancestor is how
-- `_assert_operation_rate` silently lost its advisory lock, and it is invisible in a
-- diff. The only changes are the ones described above; every other line, comment and
-- error is carried across unchanged.

-- ---------------------------------------------------------------------------
-- 1. add_comment
--
-- Was 20260817000100. The existence-and-visibility query is unchanged and still runs
-- first, so a caller who may not view the event is refused before any lock is taken.
-- The pair lock and a second reading of the same predicate are inserted after it.
-- ---------------------------------------------------------------------------

create or replace function add_comment(
  p_operation_id  uuid,
  p_feed_event_id uuid,
  p_body          text,
  p_has_spoilers  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_body  text := btrim(coalesce(p_body, ''));
  v_id    uuid;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'add_comment') then
    -- Idempotent by the ledger, like every other outbox-eligible writer. A retry
    -- after a dropped response must not post the remark twice.
    return jsonb_build_object('status', 'already_applied');
  end if;

  -- The same ceiling reactions got in 20260816000400, and for a stronger reason:
  -- a reaction is a glyph and a comment is text in someone else's notifications.
  -- Lower than 200 because a person having a heavy day on a busy feed reacts far
  -- more often than they write. Config, so raising it is not a migration.
  perform _assert_operation_rate('add_comment', 'comments.max_per_day', 100);

  perform _assert_comment_length(v_body);

  -- Existence and visibility in one query, reported as one failure. Unchanged from
  -- 20260817000100, and it runs **before any lock**, so a caller who may not view the
  -- event causes no contention and cannot learn anything from how long the call took.
  -- See the header: moving this after the lock is an oracle, not a refactor.
  select e.actor_id into v_actor
    from feed_events e
   where e.id = p_feed_event_id
     and can_view_profile(auth.uid(), e.actor_id);

  if v_actor is null then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  -- Same lock and same purpose as `follow`, `block` and `recommend_title`: a block
  -- committing between the check and the insert is precisely the race.
  --
  -- Not for one's own activity: `least(x, x) = greatest(x, x)` makes the call legal
  -- but pointless, and no inbox row is written on that branch anyway.
  if v_actor <> auth.uid() then
    perform _lock_pair(auth.uid(), v_actor);
  end if;

  -- The same predicate again, now under the lock, and this is what closes the race.
  -- A block can no longer commit between here and the insert: it either committed
  -- before this line, and this new statement snapshot sees it; or it is queued behind
  -- this transaction, and will delete the row this one writes. Discloses nothing the
  -- caller was not already told by the query above.
  if not can_view_profile(auth.uid(), v_actor) then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  insert into comments (feed_event_id, author_id, body, has_spoilers)
  values (p_feed_event_id, auth.uid(), v_body, coalesce(p_has_spoilers, false))
  returning id into v_id;

  -- PRD §15's inbox row. Written, not delivered — push is dark in v1 (AD-10) and the
  -- row is what makes turning it on a server flag rather than a release.
  --
  -- One per comment, and deliberately *not* deduplicated the way a reaction is. A
  -- reaction is a state, so ringing twice for one person's one reaction to one event
  -- is noise; a comment is an occurrence, and suppressing the second one would mean a
  -- conversation where only the opening remark is ever announced. The per-day ceiling
  -- above is what bounds this, not a unique index.
  --
  -- Not for your own activity: nobody needs telling that they replied to themselves.
  if v_actor <> auth.uid() then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor, 'comment', auth.uid(), 'feed_event', p_feed_event_id,
            jsonb_build_object('comment_id', v_id));
  end if;

  return jsonb_build_object('status', 'ok', 'comment_id', v_id);
end;
$$;

comment on function add_comment(uuid, uuid, text, boolean) is
  'Posts one flat comment on a feed event. Refuses an event the caller may not view with P0002 -- the same error as a missing one, because telling them apart discloses the activity. Since 20260819000400 the visibility check is made, then the pair lock taken, then the check remade under it -- so a block cannot commit between the check and the inbox row, and a caller who may not view the event is still refused without taking any lock, which is what keeps the refusal from being timeable. Idempotent by operation id, rate-limited per day, and writes one PRD §15 inbox row per comment (never for one''s own activity).';

-- ---------------------------------------------------------------------------
-- 2. set_reaction
--
-- Was 20260816000400. Same split, same reason.
--
-- The lock is taken on every path, including removal, rather than only on the one
-- that writes an inbox row. Removal creates nothing and does not need it — but a
-- rule with an exception is how this gap appeared in the first place, and one pair
-- lock on a toggle costs nothing measurable.
--
-- The pre-existing behaviour that a caller who may not view the event cannot remove
-- their own reaction either is deliberately unchanged. It is the same refusal it has
-- always been, in the same place in the order.
-- ---------------------------------------------------------------------------

create or replace function set_reaction(
  p_operation_id  uuid,
  p_feed_event_id uuid,
  p_kind          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_kind  text := nullif(btrim(coalesce(p_kind, '')), '');
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_reaction') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('set_reaction', 'reactions.max_per_day', 200);

  -- Existence and visibility resolved together, and reported together. A caller who
  -- cannot see the actor must not be able to tell an event they may not view from an
  -- event that is not there — and, since review 25, must not be able to tell them
  -- apart by whether the call waits either. Unchanged, and before any lock.
  select e.actor_id into v_actor
    from feed_events e
   where e.id = p_feed_event_id
     and can_view_profile(auth.uid(), e.actor_id);

  if v_actor is null then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  if v_actor <> auth.uid() then
    perform _lock_pair(auth.uid(), v_actor);
  end if;

  -- The same predicate again, under the lock. See add_comment above.
  if not can_view_profile(auth.uid(), v_actor) then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  if v_kind is null then
    delete from reactions
     where feed_event_id = p_feed_event_id and user_id = auth.uid();
    -- Deliberately not an error when there was nothing to remove. Removal is a
    -- toggle reaching a state, not a transaction against a row: a double tap, or a
    -- retry after a dropped response, means "I have no reaction to this", and that
    -- is now true either way.
    return jsonb_build_object('status', 'ok', 'kind', null);
  end if;

  -- Checked here as well as by the column constraint, so a client gets a field error
  -- it can act on rather than a 23514 it has to guess at. The list is PRD §14's, and
  -- the values are meanings rather than glyph names -- swapping a thumb for a face is
  -- a copy change, never a data migration.
  if v_kind not in ('love', 'agree', 'disagree', 'funny', 'wow', 'moved') then
    raise exception 'unknown reaction %', v_kind using errcode = '22023';
  end if;

  insert into reactions (feed_event_id, user_id, kind)
  values (p_feed_event_id, auth.uid(), v_kind)
  on conflict (feed_event_id, user_id) do update
    set kind = excluded.kind;

  -- PRD §15's inbox event. Written, not delivered: push is deliberately dark in v1
  -- (AD-10), and the row is what makes turning it on a server flag rather than a
  -- release. Recipient-scoped by `notifications_own`, and cascades with either party.
  --
  -- Not for your own activity. A notification telling you that you reacted to
  -- yourself is noise the moment anybody uses their own feed.
  --
  -- `on conflict do nothing` against the partial unique index above, rather than the
  -- `where not exists` this replaced: same behaviour on the ordinary path, and it
  -- stays correct if a later change stops the reaction upsert from serialising the
  -- callers first.
  if v_actor <> auth.uid() then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor, 'reaction', auth.uid(), 'feed_event', p_feed_event_id,
            jsonb_build_object('kind', v_kind))
    on conflict (recipient_id, actor_id, subject_id, type) where type = 'reaction'
      do nothing;
  end if;

  return jsonb_build_object('status', 'ok', 'kind', v_kind);
end;
$$;

comment on function set_reaction(uuid, uuid, text) is
  'Sets, changes or removes the caller''s one reaction to a feed event (PRD §14). Null kind removes, idempotently. Refuses an event the caller may not view with P0002 -- the same error as a missing one, because telling them apart discloses the activity. Since 20260819000400 the visibility check is made, then the pair lock taken, then the check remade under it -- so a block cannot commit between the check and the inbox row, and a caller who may not view the event is still refused without taking any lock, which is what keeps the refusal from being timeable. Rate-limited per day. Writes the PRD §15 inbox row once per (reactor, event), never for one''s own activity.';

-- ---------------------------------------------------------------------------
-- 3. set_watch_tags
--
-- Was 20260817001300. The only writer in the schema that acts on several pairs at
-- once, so it is the only one where the *order* of the locks is load-bearing rather
-- than trivially satisfied.
--
-- Taken ordered by the tagged account's uuid. Two devices saving the same companion
-- list in opposite orders would otherwise take the same two keys in opposite orders,
-- which is the textbook deadlock — and the one this function would have introduced
-- had the locks simply been added in argument order.
--
-- Locked before the eligibility test, because `_can_tag` is `_is_mutual_follow`,
-- which reads `follows` and `blocks`: the same check-then-insert window the other two
-- functions have, with the notification arriving further down the body.
--
-- Only the wanted set is locked. Clearing somebody off a list writes no inbox row and
-- is withdrawal, which — like `unfollow` — must keep working against an account that
-- has since blocked the caller.
-- ---------------------------------------------------------------------------

create or replace function set_watch_tags(
  p_operation_id  uuid,
  p_media_item_id uuid,
  p_tagged_ids    uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max      integer;
  v_wanted   uuid[];
  v_bad      uuid;
  v_added    uuid[];
  v_target   uuid;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_watch_tags') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('set_watch_tags', 'watch_tags.max_calls_per_day', 100);

  if p_tagged_ids is null then
    raise exception 'the companion list is required; send an empty array to clear it'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from user_media
     where user_id = auth.uid() and media_item_id = p_media_item_id
  ) then
    raise exception 'log the watch before saying who you watched it with'
      using errcode = 'P0002';
  end if;

  select coalesce(array_agg(distinct w.uid), '{}') into v_wanted
    from unnest(p_tagged_ids) as w(uid)
   where w.uid is not null;

  select coalesce((select (value)::integer from app_config where key = 'watch_tags.max_per_watch'), 10)
    into v_max;

  if coalesce(array_length(v_wanted, 1), 0) > v_max then
    raise exception 'you can tag up to % people on one watch', v_max using errcode = '22023';
  end if;

  -- Every pair, in uuid order, before anything reads `follows` or `blocks`. The
  -- ordering is what makes two concurrent saves of the same list unable to deadlock;
  -- the ceiling above is what bounds how many locks one transaction can hold.
  for v_target in select u from unnest(v_wanted) as t(u) where u <> auth.uid() order by u loop
    perform _lock_pair(auth.uid(), v_target);
  end loop;

  -- The narrowing, and its grandfather clause. See 20260817001300's header.
  select w.uid into v_bad
    from unnest(v_wanted) as w(uid)
   where not _can_tag(w.uid)
     and not exists (
       select 1 from watch_tags t
        where t.tagger_id = auth.uid()
          and t.tagged_id = w.uid
          and t.media_item_id = p_media_item_id
          and not t.removed_by_tagger
     )
   limit 1;

  if v_bad is not null then
    raise exception 'you can only tag people who follow you back'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(w.uid), '{}') into v_added
    from unnest(v_wanted) as w(uid)
   where not exists (
     select 1 from watch_tags t
      where t.tagger_id = auth.uid()
        and t.tagged_id = w.uid
        and t.media_item_id = p_media_item_id
        and not t.removed_by_tagger
   );

  update watch_tags
     set removed_by_tagger = true
   where tagger_id = auth.uid()
     and media_item_id = p_media_item_id
     and tagged_id <> all (v_wanted);

  insert into watch_tags (tagger_id, tagged_id, media_item_id)
  select auth.uid(), w.uid, p_media_item_id from unnest(v_wanted) as w(uid)
  on conflict (tagger_id, tagged_id, media_item_id) do update
    set removed_by_tagger = false;

  insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
  select w.uid, 'watch_tag', auth.uid(), 'media_item', p_media_item_id, '{}'::jsonb
    from unnest(v_added) as w(uid)
  on conflict (recipient_id, actor_id, subject_id, type) where type = 'watch_tag'
    do nothing;

  return jsonb_build_object('status', 'ok', 'tagged', coalesce(array_length(v_wanted, 1), 0));
end;
$$;

comment on function set_watch_tags(uuid, uuid, uuid[]) is
  'Replaces the caller''s companion list for one of their own watches (PRD §14). A person may be added only if they are a mutual follow; a person already tagged on this watch stays, so narrowing the rule on 2026-08-17 could not strand an existing list. Takes a pair lock per wanted companion, ordered by uuid, before the eligibility test (20260819000400) -- ordered, because this is the one writer that holds more than one and two devices saving the same list could otherwise deadlock. Refuses as a whole rather than partially applying. Removal is a soft delete, so the tagged person''s own removal survives an untag and re-tag. The inbox notice is once per (tagger, tagged, title) for good.';
