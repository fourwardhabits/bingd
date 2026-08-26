-- A conversation you can open: threads, replies, comment reactions, a deletion that
-- is really a deletion, and the two social lists a profile's counts should lead to.
-- Specification: founder follow-up 2026-08-26 (PR #48 final pass), parts C–G and L–N.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS REVERSES, AND WHY THAT IS NOT A REGRESSION
--
-- `20260817000100` built comments with a header that says, at length, that replies and
-- comment reactions are excluded *by absence of a column* — "a schema that cannot
-- express the excluded thing is the only version of the decision that survives a future
-- contributor who did not read this file."
--
-- That reasoning was right and it did its job: nothing drifted into threading by
-- accident for nine days, and this migration is the deliberate act that file demanded.
-- The founder has since asked for one level of replies and for a way to react to
-- somebody else's remark. So the exclusions are lifted **here**, in a file that says so,
-- and each one is replaced by a rule that is enforced rather than merely absent:
--
--   replies              -> `parent_id`, plus `_comments_are_one_deep`, which refuses a
--                           reply to a reply at the row level. The depth bound is now a
--                           trigger instead of a missing column, and it is the stronger
--                           of the two: a missing column stops threading, and this stops
--                           *arbitrary* threading while allowing exactly one level.
--   comment reactions    -> `comment_reactions`, a single like keyed on (comment, user).
--                           Not the six-glyph `reactions` set, which is about a whole
--                           activity; see §3.
--
-- Nothing else in that file's list is lifted. There is still one `text` column, so there
-- is still nowhere to put a URL, a GIF or rich text.
--
-- ---------------------------------------------------------------------------
-- THE BUG THIS FILE EXISTS FOR
--
-- "Delete your own comment -> it disappears for you, but other users still see it when
-- they open comments from the Feed."
--
-- `delete_comment` really does delete the row, and has since day one — so the server was
-- never the cause and no amount of staring at it would have found this. The cause is
-- `lib/query.ts`: the global `staleTime` is 60s and `useComments` does not override it,
-- so the second reader's cached list is served without a refetch for up to a minute
-- after the author retracted their words. That half is fixed on the client.
--
-- The half that belongs here is the one replies create. Once a comment can have replies,
-- deleting it can no longer always mean deleting the row: cascading would delete *other
-- people's writing* because the person above them changed their mind. So §2 introduces
-- a tombstone — and a tombstone is a new way for text to survive a delete, which is
-- exactly the failure being fixed. It therefore **overwrites the body in the same
-- statement**. There is no state of this database in which a deleted comment's text is
-- still stored, so there is no read path, cache or client version that can show it.
--
-- ---------------------------------------------------------------------------
-- AND THE ONE THAT MADE THE SHEET SLOW
--
-- Measured, not guessed. Against 40 comments on one event, under `authenticated` with
-- the policy enforced, and the same read as the table owner with it bypassed:
--
--     owner (RLS bypassed)     0.80 ms
--     authenticated (policy)  20.53 ms
--
-- Twenty-five times, and the plan says where it goes:
--
--     Filter: (feed_event_id = $1 AND can_i_view(author_id) AND (ANY (... SubPlan 2)))
--       SubPlan 2 -> Seq Scan on feed_events e
--                      Filter: (can_i_view(actor_id) AND can_i_view(actor_id))
--
-- Two things. **`can_i_view(author_id)` runs once per comment row** — and
-- `can_view_profile` is up to four subqueries over `profiles`, `blocks` and `follows` —
-- so the visibility oracle is evaluated N times to answer a question whose real
-- arity is "how many distinct authors are in this thread", which is far smaller.
-- **And `can_i_view(actor_id)` appears twice** in the event subplan: once from
-- `comments_read`'s own `exists`, and once more from `feed_events_read` being applied to
-- the same subquery. The event's visibility is one boolean and it was being computed
-- twice per row of a table the policy scans.
--
-- The feed pays a larger version of the same bill before anybody opens anything:
-- `useCommentCounts` reads 340 rows across 31 events in 61 ms, which is 340 oracle
-- calls for 31 numerals.
--
-- §4's two read functions are the fix, and the fix is *arithmetic* rather than a
-- rewritten rule: they are `security definer`, they resolve the event once and each
-- distinct author once, and they call the same `can_view_profile` the policy calls. The
-- authorisation is not reimplemented anywhere — `comments_read` stays exactly as it was
-- and still governs every direct read of the table. What changes is how many times the
-- same question gets asked.
--
-- ---------------------------------------------------------------------------
-- THE SOCIAL LISTS ARE INVOKER, AND THAT IS THE WHOLE OF THEIR PRIVACY
--
-- §5's `followers_of` and `following_of` are `security invoker`, alone among the read
-- functions in this file. They need no privilege the caller does not have: `follows_read`
-- already admits exactly the edges a viewer may see —
--
--     follower_id = auth.uid() or followee_id = auth.uid()
--     or (state = 'approved' and can_i_view(follower_id) and can_i_view(followee_id))
--
-- — which *is* the founder's L3 rule, written down in 20260813001900 and enforced since.
-- A definer version would have had to restate it and would have been the copy that got
-- it wrong. So a private account the viewer cannot see yields no rows, a blocked account
-- is absent from a list rather than counted in it, and none of that is new code.

-- ---------------------------------------------------------------------------
-- 1. A comment can have a parent, and exactly one level of them
--
-- `parent_id` cascades, which is the right dependency: a reply is a remark *on* the
-- comment above it, and a reply orphaned from what it answers is not a comment anybody
-- can read. §2 is what makes the cascade rare — a comment with replies is tombstoned
-- rather than deleted, so the cascade only ever fires for a thread nobody replied to.
--
-- `deleted_at` is what a tombstone is. Nullable and null for every existing row, so this
-- is an add-column on a table with no backfill and no rewrite.
-- ---------------------------------------------------------------------------

alter table comments
  add column parent_id  uuid references comments(id) on delete cascade,
  add column deleted_at timestamptz;

comment on column comments.parent_id is
  'The top-level comment this is a reply to, or null for a top-level comment. Exactly one level deep, enforced by _comments_are_one_deep: a reply naming another reply is re-pointed to their shared root by add_comment before it is ever stored, and the trigger refuses anything that got past that. Cascades, because a reply without the remark it answers is unreadable.';

comment on column comments.deleted_at is
  'When the author retracted this comment. Set only for a top-level comment that still has replies, whose thread would otherwise be destroyed with it -- everything else is deleted outright. The body is overwritten in the same statement, so this column marks a comment whose text no longer exists rather than one that is merely hidden.';

-- The thread read, and the deletion path's "does this still have replies" question.
-- Partial on the replies, because the vast majority of comments have no parent and an
-- index over them all would be mostly nulls.
create index comments_parent on comments (parent_id, created_at) where parent_id is not null;

-- ---------------------------------------------------------------------------
-- The depth bound, as a rule rather than as a convention
--
-- `add_comment` normalises a reply-to-a-reply up to its root, so this trigger should
-- never fire from the app. That is precisely why it is here: the writer's normalisation
-- is what produces the *product* behaviour the founder asked for ("the new reply should
-- still belong to the SAME top-level thread"), and this is what makes the *invariant*
-- true regardless of which writer arrives next. A `check` constraint cannot express it,
-- because the answer lives in another row.
--
-- It also refuses a comment that is its own parent, which the depth rule would otherwise
-- admit for a row whose parent's parent_id happens to be null -- itself.
-- ---------------------------------------------------------------------------

create or replace function _comments_are_one_deep()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_parent_of_parent uuid;
  v_parent_event     uuid;
begin
  if new.parent_id is null then
    return new;
  end if;

  if new.parent_id = new.id then
    raise exception 'a comment cannot reply to itself' using errcode = '22023';
  end if;

  select c.parent_id, c.feed_event_id into v_parent_of_parent, v_parent_event
    from comments c where c.id = new.parent_id;

  if v_parent_event is null then
    raise exception 'no such comment' using errcode = 'P0002';
  end if;

  if v_parent_of_parent is not null then
    raise exception 'replies are one level deep' using errcode = '22023';
  end if;

  -- The cross-post guard, at the row level. `add_comment` checks it too and reports it
  -- as the same P0002 every other unresolvable id gets; this is what makes it an
  -- invariant of the table rather than a check one writer happens to perform.
  if v_parent_event <> new.feed_event_id then
    raise exception 'a reply belongs to the same activity as the comment it answers'
      using errcode = '22023';
  end if;

  return new;
end;
$fn$;

comment on function _comments_are_one_deep() is
  'Refuses a reply to a reply, a reply to a comment on different activity, and a comment that is its own parent. add_comment already re-points a reply-to-a-reply at its root, so this never fires for the app -- it is what keeps the one-level bound true for whatever writer arrives next. Internal.';

create trigger comments_are_one_deep
  before insert or update of parent_id, feed_event_id on comments
  for each row execute function _comments_are_one_deep();

-- ---------------------------------------------------------------------------
-- 2. Writing, editing, deleting -- all three, because all three change
-- ---------------------------------------------------------------------------

/**
 * The root of the thread a reply belongs in, resolved from any comment in it.
 *
 * This is the founder's rule in one expression: "if a user taps Reply on an existing
 * reply, the new reply should still belong to the SAME top-level thread". The client is
 * not trusted to work that out and does not have to -- it sends whichever comment the
 * reader tapped Reply on, and this returns the comment that thread hangs from.
 *
 * Null for a comment that does not exist, is deleted, or is on other activity. The
 * caller turns all three into the same P0002, for the reason 20260817000100's header
 * gives at length: telling them apart is itself the disclosure.
 */
create or replace function _comment_root(p_comment_id uuid, p_feed_event_id uuid)
returns uuid
language sql stable
set search_path = public
as $$
  select coalesce(c.parent_id, c.id)
    from comments c
   where c.id = p_comment_id
     and c.feed_event_id = p_feed_event_id
     -- A tombstone is still a thread and may still be replied under; a comment whose
     -- row is gone is not. `deleted_at` is deliberately *not* excluded here.
     and exists (select 1 from comments r where r.id = coalesce(c.parent_id, c.id));
$$;

comment on function _comment_root(uuid, uuid) is
  'The top-level comment of the thread a given comment belongs to, on a given activity. Returns null for a comment that does not exist or belongs to other activity, which the caller reports as the same P0002 a missing one gets. A tombstoned root is still a valid thread to reply under. Internal.';

/**
 * Posting one comment, or one reply.
 *
 * Everything 20260817000100 established is unchanged: `assert_can_write`, the operation
 * ledger, the per-day ceiling, the length check, and one P0002 for every way an id can
 * fail to resolve. Everything **20260819000400** established is unchanged too, and that
 * sentence is the whole reason the third block below exists.
 *
 * **`p_parent_id`, normalised to a root.** Defaulted, so every existing caller and every
 * test that passes four arguments still resolves to this function and still posts a
 * top-level comment.
 *
 * **A reply notifies the person being replied to** (founder follow-up part E), through
 * the ordinary `comment` type -- which means it inherits the `comments` preference
 * category (`_apply_notification_preference`), push eligibility (`_push_eligible`) and
 * the block filter in `claim_push_batch` with no new code and no new type to review.
 *
 * **And it will not send two.** When the activity's actor is also the author of the
 * comment being replied to -- the ordinary case, somebody replying under a remark on
 * their own ranking -- that is one event and it rings once. Self-notification is
 * suppressed on both, as it always was.
 *
 * ---------------------------------------------------------------------------
 * THE HARDENING THIS FUNCTION ALMOST LOST, AND THE TRAP THAT NEARLY TOOK IT
 * ---------------------------------------------------------------------------
 *
 * The first version of this migration rebuilt `add_comment` from `20260817000100` --
 * its true ancestor by *name*, and the wrong one by *version*. `20260819000400` had
 * replaced that body nine days earlier to close hardening blocker B, and a rebuild from
 * the older text silently deleted the pair lock and the second visibility check along
 * with it. `test:race` went from 93/93 to 88/94; the read-side filter hid the damage
 * from every functional test; the diff showed a function being written, not a guarantee
 * being removed.
 *
 * That is exactly the failure `20260817001300` named and `20260819000500` recorded as
 * the SQL rebuild trap, arriving a third time. The lesson it teaches is not "be
 * careful": it is that the *latest* definition of a function may live under a file name
 * that has nothing to do with the feature, and `git log -S` on the function name is the
 * only reliable way to find it. `supabase/tests/concurrency` is the mechanism that
 * catches it when the reading fails, and it caught this.
 *
 * So the hardening is restated here **whole**, and it is now wider than what it
 * restores, because this function has grown a second counterpart:
 *
 *     check (no lock) -> lock every pair -> pin the parent -> check again -> write
 *
 * ---------------------------------------------------------------------------
 * WHICH PAIRS, AND WHY BOTH
 * ---------------------------------------------------------------------------
 *
 * A single call can now put an inbox row in front of **two** different people:
 *
 *     the activity's actor      -- `v_actor`, since 20260817000100
 *     the author replied to     -- `v_reply_to`, new here
 *
 * N1 says there is no `notifications` row between a blocked pair, and it says it about
 * every pair. A lock on the actor does nothing for the second row: the commenter and
 * the person they are answering are a different two people, and a block between *them*
 * committing between this function's check and its insert leaves precisely the row N1
 * forbids. So the reply path takes its own pair lock, and re-reads its own predicate
 * under it.
 *
 * The predicate for the reply target is `can_view_profile(caller, author)` -- not a new
 * rule invented so the lock would have something to guard. It is `comments_read`'s
 * author predicate: the one `activity_comments` enforces by inner join, so that a
 * comment whose author you cannot see is *absent* rather than anonymised, and the one
 * `set_comment_reaction` restates verbatim for the same definer reason. `_comment_root`
 * already claimed in its own comment that a parent "the caller cannot see" was refused
 * here; this is the line that makes that sentence true. The refusal is the same P0002 a
 * missing parent gets, and it refuses the call as a whole -- `set_watch_tags`'s rule,
 * rather than posting the remark and quietly dropping one of its notifications.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIRST CHECKS STILL COME BEFORE THE FIRST LOCK
 * ---------------------------------------------------------------------------
 *
 * Review 25's MAJOR, unchanged and now re-earned by a second id. `unfollow` has no
 * reachability check, so any caller can hold `_lock_pair(self, X)` against anybody they
 * can name. If this function resolved an id and *then* locked before deciding whether
 * the caller may see it, the wait itself would answer "does this belong to X" for an
 * account that has blocked them. Equal error codes do not close that; the observable is
 * the wait.
 *
 * So the event's existence-and-visibility query and the parent's are both taken first,
 * with no lock held, and a caller who fails either is refused immediately and cheaply.
 * Only a caller who has already been *told* both ids resolve goes on to lock, and the
 * second reading under the locks therefore discloses nothing new.
 *
 * ---------------------------------------------------------------------------
 * THE LOCK ORDER, WHICH IS THE PART THAT CANNOT BE HAND-WAVED
 * ---------------------------------------------------------------------------
 *
 * Two pair locks in one transaction is a deadlock waiting to be written. `_lock_pair`
 * canonicalises *within* a pair -- A-blocks-B and B-follows-A take one key -- and that
 * says nothing at all about the order two *different* pairs are taken in. Calling it
 * twice in semantic order ("the actor first, then the person replied to") is the
 * textbook cycle: one transaction wants actor-then-target, another wants
 * target-then-actor, and both wait forever.
 *
 * The rule used here is `set_watch_tags`'s, which is this schema's existing answer to
 * exactly this question and is therefore not a second mechanism to reason about:
 *
 *     derive the distinct counterparts, drop self and null, ORDER BY the uuid, and
 *     take `_lock_pair(auth.uid(), counterpart)` in that order.
 *
 * **Why ordering by the counterpart is a global order and not merely a local one.**
 * Every pair lock in this schema is `_lock_pair(auth.uid(), X)`, and the key is built
 * from `least(a,b) || ':' || greatest(a,b)` over fixed-width uuid text. For a fixed
 * caller `a`, the map `x -> (least(a,x), greatest(a,x))` is *monotone* in `x`:
 *
 *     x < y < a   ->   (x,a) < (y,a)      both below the caller
 *     a < x < y   ->   (a,x) < (a,y)      both above it
 *     x < a < y   ->   (x,a) < (a,y)      straddling it
 *
 * so ascending counterpart order is ascending canonical-pair order -- a total order on
 * pairs that does not depend on which account is calling. Every transaction in this
 * schema therefore acquires its pair locks along one global order, and a wait-for cycle
 * cannot form. That argument covers cycles of any length, which is why it is written
 * out rather than replaced by "two locks, sorted".
 *
 * `_assert_operation_rate` has already taken its account lock, keyed on `auth.uid()`,
 * before any of this -- the uniform outer level 20260819000400's header describes, and
 * the reason the two lock families cannot cycle against each other either.
 *
 * ---------------------------------------------------------------------------
 * AND ONE LOCK THAT IS NOT A PAIR LOCK
 * ---------------------------------------------------------------------------
 *
 * A block is not the only thing that can commit inside this function's window.
 * `delete_comment` takes `for update` on the row it is retracting and takes no pair lock
 * at all, so nothing above constrains it, and the parent was read before the locks.
 *
 * **What that does not break, so the fix is not sold as more than it is.** The insert
 * cannot reach the foreign key with a dangling `parent_id`: `_comments_are_one_deep`
 * runs BEFORE INSERT, re-reads the parent, and raises the ordinary P0002 when the row is
 * gone -- before any constraint fires. And a root with a live reply is *tombstoned*
 * rather than removed, so the row a reply-to-a-reply points at does not disappear either.
 * Two mechanisms already written down, both still doing their job.
 *
 * **What it does break is who gets told.** `v_reply_to` and `v_deleted_at` were read
 * before the locks and are then used after them, and a retraction inside that window
 * makes both stale:
 *
 *   a root tombstoned in the window   -> this call still writes the reply notification,
 *                                        so the author is told somebody answered a
 *                                        remark they have just withdrawn
 *   a reply removed in the window     -> the notification lands with `reply_to` naming a
 *                                        comment that no longer exists, and the reply
 *                                        itself is stored under a root the reader never
 *                                        chose to answer
 *
 * Reproduced both ways, and mutant 11 in `mutation-check.mjs` is the version without the
 * pin required to do exactly that.
 *
 * So the parent is pinned with `for share` under the pair locks and re-resolved from the
 * pin, which puts this ordering under the same rule as the others: the retraction either
 * committed before this transaction reached the row, and is seen, or it waits behind it.
 * `v_root` and `v_reply_to` are then recomputed rather than carried.
 *
 * It adds no new lock order to reason about. `delete_comment` holds only comments rows
 * and never a pair, so it cannot be waiting on anything this transaction holds; and this
 * transaction takes its one comments row lock last and goes straight to the insert, so it
 * is never the party waiting while holding one.
 *
 * Asserted rather than argued: `races/notification-block.mjs` requires the blocker to be
 * found waiting on the *named* key for each of the two pairs, and `races/lock-pair.mjs`
 * fires overlapping two-lock comments in opposite semantic roles and fails on 40P01.
 */
create or replace function add_comment(
  p_operation_id  uuid,
  p_feed_event_id uuid,
  p_body          text,
  p_has_spoilers  boolean default false,
  p_parent_id     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid;
  v_body         text := btrim(coalesce(p_body, ''));
  v_id           uuid;
  v_root         uuid := null;
  -- The author of the comment that was tapped, whatever state it is in. This is the
  -- *visibility* subject, and the second pair that has to be locked.
  v_reply_author uuid := null;
  -- The same person, unless they have retracted the remark being answered -- a
  -- tombstone is somewhere to reply, not somebody to tell. This is the notification
  -- recipient, and it is deliberately a second variable rather than the same one.
  v_reply_to     uuid := null;
  v_deleted_at   timestamptz;
  v_counterpart  uuid;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'add_comment') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('add_comment', 'comments.max_per_day', 100);

  perform _assert_comment_length(v_body);

  -- Existence and visibility in one query, reported as one failure. 20260817000100,
  -- and it runs **before any lock** -- 20260819000400 and review 25. Moving it after
  -- the lock is a timing oracle, not a refactor.
  select e.actor_id into v_actor
    from feed_events e
   where e.id = p_feed_event_id
     and can_view_profile(auth.uid(), e.actor_id);

  if v_actor is null then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  if p_parent_id is not null then
    v_root := _comment_root(p_parent_id, p_feed_event_id);

    -- Covers a comment that does not exist, and one belonging to other activity.
    if v_root is null then
      raise exception 'no such comment' using errcode = 'P0002';
    end if;

    -- Who wrote it, and whether it still says anything. One query, because these are
    -- two facts about one row and reading it twice invites them to disagree.
    select c.author_id, c.deleted_at
      into v_reply_author, v_deleted_at
      from comments c
     where c.id = p_parent_id;

    -- And the third way a parent fails to resolve: an author this caller may not see.
    -- Before any lock, for review 25's reason -- a caller who cannot see the author is
    -- refused without ever waiting on them, so the refusal stays untimeable.
    if v_reply_author is null or not can_view_profile(auth.uid(), v_reply_author) then
      raise exception 'no such comment' using errcode = 'P0002';
    end if;

    -- Tell the author of the comment that was actually tapped, not the root's, because
    -- that is the person whose words are being answered -- and because a
    -- reply-to-a-reply is re-pointed to the root above, without which the person
    -- replied to would never hear about it. Nobody is told about a tombstone.
    if v_deleted_at is null then
      v_reply_to := v_reply_author;
    end if;
  end if;

  -- Every pair this transaction is about to write across, in one deterministic order.
  --
  -- `union` deduplicates the ordinary case where the activity's actor is also the
  -- author being answered, so that pair is locked once rather than twice; `order by`
  -- is what makes two concurrent comments holding the same two pairs in opposite
  -- semantic roles unable to deadlock. The header gives the argument for why ordering
  -- by the counterpart is a global order on the keys and not merely a local one.
  --
  -- Self is excluded: `least(x, x) = greatest(x, x)` makes the call legal but
  -- pointless, and no inbox row is written on that branch anyway.
  for v_counterpart in
    select c.u
      from (select v_actor as u union select v_reply_author) as c
     where c.u is not null
       and c.u <> auth.uid()
     order by c.u
  loop
    perform _lock_pair(auth.uid(), v_counterpart);
  end loop;

  -- The same predicates again, now under the locks, and this is what closes the race.
  -- A block can no longer commit between here and the inserts: it either committed
  -- before this line, and this new statement snapshot sees it; or it is queued behind
  -- this transaction, and will delete the rows this one writes. Neither re-reading
  -- discloses anything the caller was not already told above.
  if not can_view_profile(auth.uid(), v_actor) then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  -- And the parent, re-resolved from a pin rather than from what was read above.
  --
  -- `delete_comment` takes `for update` on the row it retracts and takes no pair lock, so
  -- the locks above say nothing about it. What that costs is not the insert -- the
  -- BEFORE INSERT trigger re-reads the parent and answers the ordinary P0002 for a row
  -- that is gone -- it is *who gets told*: `v_reply_to` and `v_deleted_at` were read
  -- before the locks, so a retraction inside the window announces a reply to a remark its
  -- author has just withdrawn, or names a `reply_to` that no longer exists. See the
  -- header, and mutant 11.
  --
  -- `for share` is what decides that ordering here rather than leaving it to whichever
  -- statement reached the row first. Pinning the *tapped* comment pins the whole thread:
  -- if it is the root, the share lock is on the row the reply's foreign key names; if it
  -- is a reply, then its root has a live reply — this one — so `delete_comment` tombstones
  -- that root rather than removing it, and its "delete the tombstone whose last reply just
  -- went" branch finds this row still there.
  --
  -- No new lock order to reason about. `delete_comment` holds only comments rows, never
  -- a pair, so it cannot be waiting on anything this transaction holds; and this
  -- transaction takes its one comments row lock last and then goes straight to the
  -- insert, so it is never the party waiting while holding one.
  if p_parent_id is not null then
    perform 1 from comments c where c.id = p_parent_id for share;

    -- Re-asked rather than re-derived, so the cross-post rule and the "a tombstoned root
    -- is still a thread" rule stay written once, in `_comment_root`. A new statement
    -- snapshot, so a retraction that committed while this transaction waited above is
    -- seen here — and answered with the same P0002 a parent that never existed gets.
    v_root := _comment_root(p_parent_id, p_feed_event_id);

    select c.author_id, c.deleted_at
      into v_reply_author, v_deleted_at
      from comments c
     where c.id = p_parent_id;

    if v_root is null
       or v_reply_author is null
       or not can_view_profile(auth.uid(), v_reply_author) then
      raise exception 'no such comment' using errcode = 'P0002';
    end if;

    -- Recomputed, not carried: a parent tombstoned inside the window is somewhere to
    -- reply and nobody to tell, and `delete_comment` has already taken away the rows
    -- that announced it.
    v_reply_to := case when v_deleted_at is null then v_reply_author end;
  end if;

  insert into comments (feed_event_id, author_id, body, has_spoilers, parent_id)
  values (p_feed_event_id, auth.uid(), v_body, coalesce(p_has_spoilers, false), v_root)
  returning id into v_id;

  -- PRD §15's inbox row, for the owner of the activity. Unchanged.
  if v_actor <> auth.uid() then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor, 'comment', auth.uid(), 'feed_event', p_feed_event_id,
            jsonb_build_object('comment_id', v_id));
  end if;

  -- And for the person being replied to, when that is somebody else again. The
  -- `<> v_actor` is what stops the ordinary case ringing twice.
  if v_reply_to is not null and v_reply_to <> auth.uid() and v_reply_to <> v_actor then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_reply_to, 'comment', auth.uid(), 'feed_event', p_feed_event_id,
            jsonb_build_object('comment_id', v_id, 'reply_to', p_parent_id));
  end if;

  return jsonb_build_object('status', 'ok', 'comment_id', v_id, 'parent_id', v_root);
end;
$$;

comment on function add_comment(uuid, uuid, text, boolean, uuid) is
  'Posts one comment, or one reply, on a feed event. A reply naming another reply is stored against their shared root, so threads are exactly one level deep and the client never has to work that out. Refuses an event or a parent the caller may not reach -- including a parent whose author they may not see -- with the same P0002 a missing one gets. Carries 20260819000400''s hardening, restated here after this migration''s first draft rebuilt the function from its pre-hardening ancestor and dropped it: both visibility checks are made before any lock, then every pair this call could notify is locked in ascending counterpart-uuid order -- one global order, so two overlapping comments cannot deadlock -- then the parent is pinned with `for share` against a concurrent retraction and every check is remade under those locks. Idempotent by operation id, rate-limited per day, and writes an inbox row for the activity''s actor and for the person replied to: never twice when they are the same person, never to oneself, and never to a tombstone.';

-- The four-argument form is gone: `create or replace` on a signature with a new
-- defaulted parameter creates a *second* function, and PostgREST resolving
-- `add_comment(p_operation_id, p_feed_event_id, p_body, p_has_spoilers)` against two
-- candidates is an ambiguity error rather than a choice. Dropped explicitly so the
-- overload cannot linger in a database that has already applied 20260817000100.
drop function if exists add_comment(uuid, uuid, text, boolean);

/**
 * Editing your own.
 *
 * One line added to 20260817000100's version: `and deleted_at is null`. A tombstone has
 * no body to rewrite, and an edit that "succeeded" against one would put text back into
 * a comment its author has already retracted -- the exact resurrection §2's header is
 * about. Folded into the same predicate as ownership, so it is the same P0002 and
 * discloses nothing.
 */
create or replace function edit_comment(
  p_operation_id uuid,
  p_comment_id   uuid,
  p_body         text,
  p_has_spoilers boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_at   timestamptz;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'edit_comment') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_comment_length(v_body);

  update comments
     set body         = v_body,
         has_spoilers = coalesce(p_has_spoilers, has_spoilers),
         edited_at    = now()
   where id = p_comment_id
     and author_id = auth.uid()
     and deleted_at is null
  returning edited_at into v_at;

  if v_at is null then
    raise exception 'no such comment' using errcode = 'P0002';
  end if;

  return jsonb_build_object('status', 'ok', 'edited_at', v_at);
end;
$$;

comment on function edit_comment(uuid, uuid, text, boolean) is
  'Rewrites one of the caller''s own comments and stamps edited_at. "Not found", "not yours" and "already deleted" are one P0002. Deliberately does not re-check the event''s visibility: an author blocked after the fact must still be able to change or retract their own words.';

/**
 * Deleting your own, which is now two outcomes rather than one.
 *
 * **A top-level comment that still has replies is tombstoned.** Removing it would take
 * other people's writing with it through the cascade, and a thread that vanishes because
 * the person at the top of it changed their mind is the more surprising of the two
 * behaviours -- the founder's option A. The row survives *only* to hold the replies
 * together, and it survives with nothing in it:
 *
 *   - `body` is overwritten. Not blanked, because `comments_body_present` forbids an
 *     empty one and a constraint that has to be relaxed for this is a constraint that
 *     stops protecting everything else. The word stored is not rendered by anything --
 *     §4 returns `null` for a deleted body and the client draws its own "Comment
 *     deleted" from `deleted_at` -- so it is a placeholder rather than copy.
 *   - `has_spoilers` goes false: it was a claim about text that no longer exists.
 *   - `edited_at` is cleared, so a tombstone does not read as "edited".
 *
 * **Everything else is deleted outright** -- a reply, and a top-level comment nobody
 * answered. That is the founder's "if comment has no replies: remove it fully".
 *
 * **And deleting the last reply under a tombstone takes the tombstone too.** Otherwise
 * "Comment deleted" sits alone in a thread with nothing under it, which is a worse
 * artefact than the empty state it replaced. The tombstone exists to hold replies; with
 * none left it has no job.
 */
create or replace function delete_comment(
  p_operation_id uuid,
  p_comment_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent    uuid;
  v_replies   integer;
  v_outcome   text;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'delete_comment') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  -- Ownership, existence and "not already a tombstone" resolved together, and locked,
  -- so two deletes of one comment cannot both decide it has replies. 20260817000100's
  -- rule about one answer for every failure is unchanged.
  select c.parent_id into v_parent
    from comments c
   where c.id = p_comment_id
     and c.author_id = auth.uid()
     and c.deleted_at is null
   for update;

  if not found then
    raise exception 'no such comment' using errcode = 'P0002';
  end if;

  select count(*)::integer into v_replies
    from comments r
   where r.parent_id = p_comment_id and r.deleted_at is null;

  if v_parent is null and v_replies > 0 then
    update comments
       set deleted_at   = now(),
           body         = 'deleted',
           has_spoilers = false,
           edited_at    = null
     where id = p_comment_id;
    v_outcome := 'tombstoned';
  else
    delete from comments where id = p_comment_id;
    v_outcome := 'removed';

    -- The tombstone above this reply, if that was the last thing holding it up.
    if v_parent is not null then
      delete from comments c
       where c.id = v_parent
         and c.deleted_at is not null
         and not exists (select 1 from comments r where r.parent_id = c.id);
    end if;
  end if;

  -- The inbox rows that announced it go too, whichever outcome. Both writers in
  -- `add_comment` put the new comment's id in the payload, so this reaches the reply
  -- notification as well as the activity one.
  delete from notifications
   where type = 'comment'
     and actor_id = auth.uid()
     and payload ->> 'comment_id' = p_comment_id::text;

  return jsonb_build_object('status', 'ok', 'outcome', v_outcome);
end;
$$;

comment on function delete_comment(uuid, uuid) is
  'Deletes one of the caller''s own comments, and the inbox rows that announced it. A top-level comment with replies is tombstoned rather than removed, so the replies under it -- other people''s writing -- survive; its body is overwritten in the same statement, so no read path, cache or client version can show retracted text. Everything else is removed outright, and removing the last reply under a tombstone removes the tombstone. "Not found", "not yours" and "already deleted" are one P0002.';

-- ---------------------------------------------------------------------------
-- 3. Reacting to a comment
--
-- **A like, and not the six.** `reactions` is a closed set of six meanings about a whole
-- activity -- love, agree, disagree, funny, wow, moved -- and PRD §14 chose them for
-- reacting to *what somebody watched and how they placed it*. A comment is one remark
-- inside that, and "disagree" on a remark is a reply rather than a glyph. The founder
-- asked for the smallest thing that works: one toggle and a count. So this table has no
-- `kind` column, which is the same discipline 20260817000100 applied to threading --
-- the excluded thing has nowhere to go.
--
-- It is a separate table rather than a nullable `comment_id` on `reactions` for a reason
-- that is not tidiness: `reactions.feed_event_id` is `not null` and every read, policy
-- and index in this database assumes it. Widening that column would put a second shape
-- behind every existing reaction query.
--
-- No notification. `notifications.subject_type` is `feed_event` or `media_item`, and a
-- comment reaction is neither -- it would need a third subject kind, a preference
-- category, a push sentence and a routing case, which is four reviewed decisions for the
-- quietest event in the product. Founder instruction: deferred rather than improvised.
-- ---------------------------------------------------------------------------

create table comment_reactions (
  comment_id uuid not null references comments(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- The primary key is the idempotency. One person's like of one comment is one row
  -- however many times it is pressed, and a retry after a lost reply is the same insert.
  primary key (comment_id, user_id)
);

comment on table comment_reactions is
  'One like per person per comment (founder follow-up 2026-08-26 part D). Deliberately has no kind column: the six meanings in `reactions` are about a whole activity, and the smallest thing that works on a single remark is a toggle and a count. Written only through set_comment_reaction. Never notifies -- see the migration header.';

-- "Who liked this comment", which is the count in every thread read.
create index comment_reactions_comment on comment_reactions (comment_id);
-- "Delete my account", and the half of the primary key a per-user sweep needs first.
create index comment_reactions_user on comment_reactions (user_id);

/**
 * Read authorisation is **two** predicates, exactly as `reactions_read` is.
 *
 * The first is the comment's own, restated by reference rather than by copy:
 * `exists (select 1 from comments c where c.id = comment_id)` is evaluated as the
 * querying role, so `comments_read` applies to it -- meaning a reaction is admitted only
 * when the caller may read the comment it is on. A blocked author's comment is
 * invisible, so the likes on it are too.
 *
 * The second is `can_i_view(user_id)`, and **leaving it out was a real hole**, found by
 * independent review 43 as a Major. Without it, the row is admitted on the strength of
 * the *comment* alone -- so a blocked account liking a comment this reader can see puts
 * that account's `user_id` into a `select comment_id, user_id from comment_reactions`
 * that PostgREST will happily serve. The comment being readable says nothing about
 * whether the person who liked it is, and those are two different disclosures.
 *
 * 20260816000200 wrote the same pair for `reactions` for the same reason, and the whole
 * point of a convention is that a new table follows it. This is that table doing so.
 *
 * `anon` is revoked for the reason comments are: no signed-out surface renders any of
 * this, and a grant should follow a surface rather than precede it.
 */
alter table comment_reactions enable row level security;

create policy comment_reactions_read on comment_reactions for select
  using (
    can_i_view(user_id)
    and exists (select 1 from comments c where c.id = comment_id)
  );

revoke select on comment_reactions from anon;

/**
 * Setting it, as an assignment rather than a flip.
 *
 * `p_on` is the state the reader's control is asking for, not "toggle". That is what
 * makes a replay safe in a way a flip could never be: a tap whose reply is lost, retried
 * by a reader who now sees the old state, converges on what they asked for instead of
 * undoing it. The operation ledger stops the retry spending a second rate slot; the
 * primary key stops it writing a second row; and `p_on` stops it meaning the opposite
 * thing. Three mechanisms, and only the third survives a client that has forgotten its
 * operation id.
 *
 * Refuses a deleted or unreachable comment with the same P0002 everything else here
 * uses. The visibility question is asked as the *caller* -- `can_view_profile` on both
 * the comment's author and the event's actor, which is `comments_read` restated for a
 * definer that has stepped outside it. That restatement is unavoidable: a definer
 * function does not have the policy applied to it, and this one has to be definer to
 * write a table with no insert policy, which is this database's rule for every writer.
 */
create or replace function set_comment_reaction(
  p_operation_id uuid,
  p_comment_id   uuid,
  p_on           boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_comment_reaction') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('set_comment_reaction', 'comment_reactions.max_per_day', 300);

  select true into v_ok
    from comments c
    join feed_events e on e.id = c.feed_event_id
   where c.id = p_comment_id
     and c.deleted_at is null
     and can_view_profile(auth.uid(), c.author_id)
     and can_view_profile(auth.uid(), e.actor_id);

  if v_ok is null then
    raise exception 'no such comment' using errcode = 'P0002';
  end if;

  if coalesce(p_on, false) then
    insert into comment_reactions (comment_id, user_id)
    values (p_comment_id, auth.uid())
    on conflict (comment_id, user_id) do nothing;
  else
    delete from comment_reactions
     where comment_id = p_comment_id and user_id = auth.uid();
  end if;

  return jsonb_build_object('status', 'ok', 'on', coalesce(p_on, false));
end;
$$;

comment on function set_comment_reaction(uuid, uuid, boolean) is
  'Sets or clears the caller''s like on one comment. Takes the state wanted rather than "toggle", so a retry after a lost reply converges instead of undoing itself. Refuses a deleted comment, or one on activity or by an author the caller may not see, with the same P0002 a missing one gets -- comments_read''s two predicates, restated for a definer the policy does not apply to.';

-- ---------------------------------------------------------------------------
-- 4. Reading a thread, and counting threads
--
-- See the header for the measurement. Both functions are `security definer` and both
-- resolve the *same* rule `comments_read` states, once per subject instead of once per
-- row:
--
--   the event's actor  -- one call, hoisted out of the row loop entirely
--   each author        -- one call per distinct author, not per comment
--
-- They also return the author's identity in the same statement, which removes the
-- second round trip PostgREST was making for the `profiles:author_id(...)` embed. The
-- sheet went from two requests to one.
--
-- Neither takes a viewer. 20260813001900's rule: a client-reachable function that
-- accepts one is a follow-graph oracle, and the perspective here is always the caller's.
-- ---------------------------------------------------------------------------

create or replace function activity_comments(p_feed_event_id uuid)
returns table (
  id             uuid,
  parent_id      uuid,
  author_id      uuid,
  username       text,
  display_name   text,
  avatar_path    text,
  body           text,
  has_spoilers   boolean,
  created_at     timestamptz,
  edited_at      timestamptz,
  deleted_at     timestamptz,
  reaction_count integer,
  reacted_by_me  boolean
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  -- The event, once. Returning no rows here is the whole of the privacy answer: a
  -- reader who may not see the activity gets an empty thread and cannot tell that from
  -- an activity with no comments, which is the same silence 20260817000100 chose.
  event as (
    select e.id
      from feed_events e, me
     where e.id = p_feed_event_id
       and can_view_profile(me.id, e.actor_id)
  ),
  rows as (
    select c.* from comments c, event where c.feed_event_id = event.id
  ),
  -- Each author, once. This is the line the twenty-five-fold cost was in.
  authors as (
    select p.id, p.username::text as username, p.display_name, p.avatar_path
      from profiles p, me
     where p.id in (select distinct r.author_id from rows r)
       and can_view_profile(me.id, p.id)
  ),
  -- And each *reactor* once, for the same reason and at the same arity. A like count is
  -- a number about people, so it is filtered by the same rule that decides whether those
  -- people can be seen at all.
  reactors as (
    select p.id
      from profiles p, me
     where p.id in (
             select distinct cr.user_id
               from comment_reactions cr
               join rows r on r.id = cr.comment_id
           )
       and can_view_profile(me.id, p.id)
  ),
  /**
   * Which tombstones are worth drawing **for this reader**.
   *
   * A tombstone exists only to hold replies together, and whether it has any is a
   * viewer-relative question: `delete_comment` runs as the owner and counts every reply,
   * because a reply the *author* cannot see is still a reply somebody else can read and
   * must not be destroyed. But the reader who blocked its author sees none of them, and
   * would be left looking at "Comment deleted" with nothing under it — a spacer holding
   * nothing apart. Independent review 43 found it as a Minor.
   *
   * So the row survives in the table and is dropped from *this* result, which is the only
   * place the answer can be right for everybody at once.
   */
  live_roots as (
    select r.id
      from rows r
     where r.deleted_at is null
        or exists (
             select 1
               from rows reply
               join authors a on a.id = reply.author_id
              where reply.parent_id = r.id
                and reply.deleted_at is null
           )
  )
  select r.id,
         r.parent_id,
         r.author_id,
         a.username,
         a.display_name,
         a.avatar_path,
         -- A retracted comment's text does not leave the database. The row is returned
         -- so the replies under it keep their place; the body is not.
         case when r.deleted_at is null then r.body end,
         r.has_spoilers,
         r.created_at,
         r.edited_at,
         r.deleted_at,
         -- Counted through the same visibility rule the policy applies, and not merely
         -- summed. This function is definer, so `comment_reactions_read` does *not*
         -- protect it: without the join a blocked account's like would be included in a
         -- number this reader is shown, which is the "absent rather than counted
         -- anonymously" rule `useReactions` states for the activity-level reactions and
         -- which independent review 43 found missing here.
         (select count(*)::integer
            from comment_reactions cr
            join reactors rv on rv.id = cr.user_id
           where cr.comment_id = r.id),
         exists (
           select 1 from comment_reactions cr, me
            where cr.comment_id = r.id and cr.user_id = me.id
         )
    from rows r
    -- Inner, which is `comments_read`'s author predicate: a comment whose author this
    -- reader may not see is *absent* rather than anonymised. A blocked person's remark
    -- does not appear, and neither does the fact that they made one.
    join authors a on a.id = r.author_id
    -- And a tombstone only where this reader can see something under it. Joining on the
    -- *root* rather than on the row is what makes one condition cover both cases: a root
    -- must be live to appear, and a reply must have a live root to appear under.
    join live_roots lr on lr.id = coalesce(r.parent_id, r.id)
   -- Oldest first, because a conversation runs downward -- and the root before its
   -- replies, because the client draws one indent level and needs no sorting of its own.
   order by coalesce(r.parent_id, r.id), (r.parent_id is not null), r.created_at, r.id;
$$;

comment on function activity_comments(uuid) is
  'One activity''s comments and replies, oldest first, roots before their replies, with each author named and each comment''s like count and the caller''s own like resolved in the same statement. Definer and takes no viewer (20260813001900). States comments_read''s rule rather than a new one -- the event''s actor once, each distinct author once -- which is the whole of the twenty-five-fold cost the per-row policy was paying. Returns a null body for a retracted comment: the row survives to hold its replies, the text does not.';

/**
 * How many comments each event on screen has, for this viewer.
 *
 * The same shape as above and for the same reason: 340 rows across 31 events cost 340
 * oracle calls, and this costs one per event plus one per distinct author across the
 * whole set.
 *
 * **A tombstone is not counted.** The numeral on a feed row is "how many things are
 * there to read", and a retracted comment is not one -- it is a spacer holding a thread
 * together. Counting it would make a feed row promise a conversation that opens onto
 * "Comment deleted".
 *
 * The array is bounded, because a client that sends ten thousand event ids should get a
 * refusal rather than a slow answer. Thirty is the feed page; sixty is twice that.
 */
create or replace function activity_comment_counts(p_feed_event_ids uuid[])
returns table (feed_event_id uuid, comment_count integer)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  ids as (
    select distinct unnest(coalesce(p_feed_event_ids, '{}'::uuid[])) as id limit 60
  ),
  events as (
    select e.id
      from feed_events e
      join ids on ids.id = e.id
     cross join me
     where can_view_profile(me.id, e.actor_id)
  ),
  rows as (
    select c.feed_event_id, c.author_id
      from comments c
      join events on events.id = c.feed_event_id
     where c.deleted_at is null
  ),
  authors as (
    select p.id
      from profiles p, me
     where p.id in (select distinct r.author_id from rows r)
       and can_view_profile(me.id, p.id)
  )
  select r.feed_event_id, count(*)::integer
    from rows r
    join authors a on a.id = r.author_id
   group by r.feed_event_id;
$$;

comment on function activity_comment_counts(uuid[]) is
  'How many readable comments each of the given events has, for the caller. One visibility call per event and one per distinct author across the whole set, rather than one per row -- the same arithmetic activity_comments makes, applied to the feed''s numerals. Excludes retracted comments: the count promises something to read. Definer, takes no viewer, and caps the input at sixty events.';

-- ---------------------------------------------------------------------------
-- 5. Followers and Following, as lists rather than as numbers
--
-- Founder follow-up parts L–N. `security invoker`, alone in this file, because
-- `follows_read` already *is* the rule and a definer copy would be the copy that got it
-- wrong. See the migration header.
--
-- **The search is inside the list, never across the directory.** `p_query` filters the
-- rows this caller may already see; there is no branch in which an empty result set is
-- refilled from anywhere. That is part M's rule, and it is structural here: the `from`
-- clause is `follows`, so nothing outside one person's edges can be reached.
--
-- **Match is not returned** (part N). `taste_match` reads two whole ranking catalogues
-- and computes a correlation; a list of fifty people would be fifty of those. The
-- founder's instruction was to include it only if a batch could produce it cleanly, and
-- nothing here can, so the rows carry identity and a follow state and nothing else.
-- `people_taste_matches` remains the surface that shows a number, where the candidate
-- set is already bounded to thirty for exactly this reason.
--
-- Keyset would be better than offset and is not worth it here: a follow list is ordered
-- by a name, the page is fifty, and the founder's requirement is "do not hardcode first
-- 30 forever". Offset over a stable, unique sort (`username` is unique) cannot skip or
-- repeat a row the way an offset over a non-unique key can.
-- ---------------------------------------------------------------------------

create or replace function followers_of(
  p_user_id uuid,
  p_query   text default null,
  p_limit   integer default 50,
  p_offset  integer default 0
)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility
)
language sql stable security invoker
set search_path = public
as $$
  select p.id, p.username::text, p.display_name, p.avatar_path, p.visibility
    from follows f
    join profiles p on p.id = f.follower_id
   where f.followee_id = p_user_id
     and f.state = 'approved'
     -- `follows_read` has already decided which edges are visible; this is the profile
     -- side, and `profiles_read` decides it. Stated as a join rather than a filter so a
     -- row whose profile is unreadable is absent rather than half-drawn.
     and p.status = 'active'
     and (
       p_query is null
       or btrim(p_query) = ''
       or p.username::text ilike '%' || btrim(p_query) || '%'
       or coalesce(p.display_name, '') ilike '%' || btrim(p_query) || '%'
     )
   order by coalesce(p.display_name, p.username::text), p.username
   limit least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function followers_of(uuid, text, integer, integer) is
  'The accounts following the given person, as far as the caller is allowed to know. security invoker, so follows_read and profiles_read are the entire authorisation: a private account the caller cannot view yields nothing, and a blocked account is absent from a list rather than counted in it. p_query searches display name and username within this list only -- there is no path from here to the directory. Ordered by name, which is unique enough to page over.';

create or replace function following_of(
  p_user_id uuid,
  p_query   text default null,
  p_limit   integer default 50,
  p_offset  integer default 0
)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility
)
language sql stable security invoker
set search_path = public
as $$
  select p.id, p.username::text, p.display_name, p.avatar_path, p.visibility
    from follows f
    join profiles p on p.id = f.followee_id
   where f.follower_id = p_user_id
     and f.state = 'approved'
     and p.status = 'active'
     and (
       p_query is null
       or btrim(p_query) = ''
       or p.username::text ilike '%' || btrim(p_query) || '%'
       or coalesce(p.display_name, '') ilike '%' || btrim(p_query) || '%'
     )
   order by coalesce(p.display_name, p.username::text), p.username
   limit least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function following_of(uuid, text, integer, integer) is
  'The accounts the given person follows, as far as the caller is allowed to know. security invoker for the same reason followers_of is: follows_read is already exactly this rule. Searches within the list only, never the directory, and never returns a taste match -- one correlation per row is what part N forbids.';

-- ---------------------------------------------------------------------------
-- 6. A push that can reach the conversation
--
-- `claim_push_batch` returns jsonb, so this adds a key and changes no signature.
--
-- **`n.subject_id` directly, and no join.** The `fe` join above it is deliberately
-- narrowed to `fe.actor_id = n.recipient_id` -- the recipient's *own* activity -- which
-- is right for resolving a title and wrong for this: a reply notification's recipient is
-- another commenter, not the actor, and the join yields null for them. The notification's
-- own `subject_id` column has no such restriction and needs none, because it discloses
-- nothing on its own: the client can only open the thread, and the thread is read through
-- `activity_comments`, which asks `can_view_profile` about the event before returning a
-- single row. An id in a payload buys exactly what an id in anybody's hands buys here --
-- nothing (20260817000100's header).
-- ---------------------------------------------------------------------------

create or replace function claim_push_batch(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed uuid[];
  v_jobs    jsonb;
  v_dead    uuid[];
begin
  delete from push_outbox o
   where (o.failures >= 3 or o.attempts >= 6)
     and (o.state = 'pending' or o.claimed_at < now() - interval '5 minutes');

  with due as (
    select o.notification_id
      from push_outbox o
     where o.failures < 3
       and o.attempts  < 6
       and (
         o.state = 'pending'
         or (o.state = 'claimed' and o.claimed_at < now() - interval '5 minutes')
       )
     order by o.created_at
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
     for update skip locked
  ),
  taken as (
    update push_outbox o
       set state      = 'claimed',
           claimed_at = now(),
           attempts   = o.attempts + 1
      from due
     where o.notification_id = due.notification_id
    returning o.notification_id
  )
  select coalesce(array_agg(notification_id), '{}'::uuid[]) into v_claimed from taken;

  if array_length(v_claimed, 1) is null then
    return jsonb_build_array();
  end if;

  select coalesce(array_agg(n.id), '{}'::uuid[]) into v_dead
    from notifications n
   where n.id = any (v_claimed)
     and (
       (n.actor_id is not null and not can_discover_profile(n.recipient_id, n.actor_id))
       or not exists (
         select 1 from device_tokens d
          where d.user_id = n.recipient_id and d.revoked_at is null
       )
     );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'notification_id', j.id,
        'attempt',         j.attempt,
        'type',            j.type,
        'actor_username',  j.actor_username,
        'actor_name',      j.actor_name,
        'media_item_id',   j.media_item_id,
        'media_kind',      j.media_kind,
        'media_title',     j.media_title,
        'series_title',    j.series_title,
        -- The conversation this push is about, so a tap on the lock screen lands where
        -- a tap on the inbox row lands. See the section header.
        'feed_event_id',   j.feed_event_id,
        'tokens',          j.tokens
      )
      order by j.created_at
    ),
    jsonb_build_array()
  )
  into v_jobs
  from (
    select n.id,
           o.attempts                              as attempt,
           n.type,
           n.created_at,
           p.username::text                        as actor_username,
           coalesce(p.display_name, p.username::text) as actor_name,
           m.id                                    as media_item_id,
           m.kind::text                            as media_kind,
           m.title                                 as media_title,
           parent.title                            as series_title,
           case when n.subject_type = 'feed_event' then n.subject_id end as feed_event_id,
           (
             select jsonb_agg(jsonb_build_object('token', d.token, 'platform', d.platform))
               from device_tokens d
              where d.user_id = n.recipient_id
                and d.revoked_at is null
           )                                       as tokens
      from notifications n
      join push_outbox o on o.notification_id = n.id
      left join profiles p
             on p.id = n.actor_id
            and p.status = 'active'
      left join feed_events fe
             on n.subject_type = 'feed_event'
            and fe.id = n.subject_id
            and fe.actor_id = n.recipient_id
      left join media_items m
             on m.id = case
                         when n.subject_type = 'media_item' then n.subject_id
                         else fe.media_item_id
                       end
      left join media_items parent
             on parent.id = m.parent_id
     where n.id = any (v_claimed)
       and not (n.id = any (v_dead))
       and p.id is not null
  ) j;

  delete from push_outbox o
   where o.notification_id = any (v_claimed)
     and o.notification_id not in (
       select (job ->> 'notification_id')::uuid from jsonb_array_elements(v_jobs) as job
     );

  return v_jobs;
end;
$$;

comment on function claim_push_batch(integer) is
  'Claims up to p_limit queued pushes and returns everything needed to send them, recipients and tokens resolved server-side. Takes no recipient and cannot be pointed at one. Applies can_discover_profile exactly as my_notifications does, so a notification that raced a block is not pushed. Five-minute lease with skip locked, so delivery is at least once, bounded at three settled failures and six claims. Reaps rows that have hit either ceiling. Since 20260826000600 it also carries feed_event_id, so a tapped comment or reply push opens the same conversation the inbox row does.';

-- ---------------------------------------------------------------------------
-- 7. Privileges
--
-- 20260813001800 made execute default-deny, so every grant here is deliberate and
-- every absence is a decision. `_comment_root` and `_comments_are_one_deep` are not
-- granted: one is reached only from a definer that already authorised the caller, and
-- the other is a trigger, which runs as the table's owner regardless.
-- ---------------------------------------------------------------------------

grant execute on function add_comment(uuid, uuid, text, boolean, uuid)  to authenticated;
grant execute on function edit_comment(uuid, uuid, text, boolean)       to authenticated;
grant execute on function delete_comment(uuid, uuid)                    to authenticated;
grant execute on function set_comment_reaction(uuid, uuid, boolean)     to authenticated;

revoke execute on function activity_comments(uuid)            from public, anon;
grant  execute on function activity_comments(uuid)            to authenticated;
revoke execute on function activity_comment_counts(uuid[])    from public, anon;
grant  execute on function activity_comment_counts(uuid[])    to authenticated;

revoke execute on function followers_of(uuid, text, integer, integer) from public, anon;
grant  execute on function followers_of(uuid, text, integer, integer) to authenticated;
revoke execute on function following_of(uuid, text, integer, integer) from public, anon;
grant  execute on function following_of(uuid, text, integer, integer) to authenticated;

revoke execute on function claim_push_batch(integer) from public, anon, authenticated;
grant  execute on function claim_push_batch(integer) to service_role;

-- The like has a ceiling for the reason every other write does: a modified client that
-- can toggle without bound is a modified client that can fill a table. Higher than
-- comments (100) because a like is a tap and a comment is a sentence, and lower than
-- reactions on activity, which are the same gesture on a much larger surface.
insert into app_config (key, value)
values ('comment_reactions.max_per_day', '300'::jsonb)
on conflict (key) do nothing;
