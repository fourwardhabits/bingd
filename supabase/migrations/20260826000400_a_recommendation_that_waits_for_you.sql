-- A recommendation that waits for you.
-- Specification: PRD §13 (For You stays algorithmic) · PRD §15 (inbox) · PRD §22
-- (blocks) · founder tranche, 2026-08-26.
--
-- ===========================================================================
-- THE BUG THIS MIGRATION IS ABOUT
--
-- `20260817001300` wrote one rule and called it the friendship rule: a recommendation
-- may only be sent to a **mutual follow**. `_is_mutual_follow` tests both edges, and
-- `RecommendSheet`'s picker intersects the same two directions so that it offers only
-- people the server will accept.
--
-- The consequence nobody wrote down is that **following somebody is not enough to tell
-- them about a film**. A person who follows twenty accounts and is followed back by
-- three can recommend to three. The other seventeen are not refused with an
-- explanation — they are *absent from the picker*, so the feature reads as though
-- those people cannot be recommended to at all, and there is no message anywhere in
-- the product that says why.
--
-- Worse, the failure is silent in the direction that matters. If the relationship
-- lapses between the picker being drawn and the tap landing, `recommend_title` answers
-- `{"status":"refused","reason":"not_mutual"}` and **the recommendation is gone**. The
-- person meant to send something, the app said no, and nothing was stored. That is the
-- one outcome this tranche exists to make impossible.
--
-- ===========================================================================
-- THE RULE THAT REPLACES IT
--
--   Sender follows recipient, approved            → may send.
--   Recipient also follows sender                 → delivered.
--   Recipient does not follow sender              → stored as a pending request.
--   Either block                                  → refused, and nothing is stored.
--
-- Send eligibility is now **one-way and outbound**: `_may_recommend_to`. The mental
-- model is "you can recommend titles to people you follow", which is a sentence a user
-- can hold. Being followed *by* somebody grants nothing — that direction is the one an
-- unwanted sender controls, and it is exactly the direction that must not authorise a
-- write into somebody else's screen.
--
-- Delivery is the second edge, and it is a *trust* test rather than an authorisation
-- one: following somebody back is how a recipient says "put this person's suggestions
-- straight in my list". Until they do, the recommendation is held where they can see
-- it, add it, or throw it away — and it is never lost.
--
-- ===========================================================================
-- WHY THE STATE GOES ON THE EXISTING ROW
--
-- A pending recommendation is a recommendation. It has the same sender, the same
-- recipient, the same title and the same uniqueness rule, and it becomes an ordinary
-- one by a single state change. A second table would duplicate the (sender, recipient,
-- title) key, the block semantics, the `opened_at` rule and the award that counts
-- sends — four things to keep in step for one column's worth of difference, which is
-- the argument `20260817001300` already made against a friendship table.
--
-- ===========================================================================
-- WHAT IS DELIBERATELY NOT HERE
--
-- **No notification row for a pending request, ever.** Not at send, not at Add, not at
-- release. The Notifications timeline is a social-event log and the request signal
-- lives on the recommendations surface; a pending request that also filed an inbox row
-- would put a decision into a chronological list that has no way to represent one, and
-- would move the Bell badge for something the Bell cannot resolve. A bulk release is
-- the case that makes this obvious: following one person could otherwise fire five
-- notifications for an act the reader had just performed themselves.
--
-- **No second permission graph.** There is no "allow recommendations" toggle and no
-- recommendation blocklist. Follow, unfollow and block are the three controls, and
-- they already mean the three things a recipient needs to say.
--
-- **No message, no reply, no read receipt.** Dismissing is silent to the sender and so
-- is adding. See §25 below on why the sender cannot be allowed to read the state at
-- all.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The state
--
-- Three values and no more. `pending` is the held request, `delivered` is an ordinary
-- recommendation, `dismissed` is a tombstone the recipient wrote.
--
-- `dismissed` is a stored state rather than a deletion for one reason: a bulk release
-- must be able to tell "not yet decided" from "decided against", and a deleted row
-- says neither. It is also what stops a dismissed recommendation reappearing when the
-- recipient later follows the sender.
--
-- The default is `delivered`, which backfills every existing row correctly: until this
-- migration a recommendation could only be created between mutual follows, so every
-- row already in the table is one the recipient was entitled to see.
-- ---------------------------------------------------------------------------

create type recommendation_state as enum ('pending', 'delivered', 'dismissed');

alter table title_recommendations
  add column state recommendation_state not null default 'delivered';

comment on column title_recommendations.state is
  'pending: held as a request because the recipient does not follow the sender. delivered: in the recipient''s ordinary Recommendations list. dismissed: the recipient threw it away, and it will never be released by a later follow. Backfilled to delivered, which is correct for every row written before 20260826000400 -- a recommendation then required a mutual follow.';

-- Serves the requests read model and the per-pair pending cap, both of which ask the
-- same question: what is pending, for this recipient, from whom, newest first.
create index title_recommendations_pending
  on title_recommendations (recipient_id, sender_id, recommended_at desc)
  where state = 'pending';


-- ---------------------------------------------------------------------------
-- 2. Who may read what, and the oracle this closes
--
-- `title_recommendations_read` admitted both parties to the whole row. With a `state`
-- column on it that policy becomes **a behavioural oracle pointed at the recipient**:
-- the sender selects one column and learns whether their recommendation was added,
-- ignored, or thrown away. Nothing in the product tells them that and nothing should
-- — a recipient who has to consider what the sender will see when they dismiss
-- something is a recipient who will not dismiss it.
--
-- Two mechanisms, because one policy cannot do it. RLS filters rows; hiding a *column*
-- from one party and not the other is a column privilege.
--
--   * The **recipient** policy admits only `delivered` rows. So every ordinary read
--     path -- including `recommendations_to_me`, which is `security invoker` and must
--     stay that way -- sees the delivered list and nothing else, without containing a
--     state filter of its own that could be got wrong. This is the same argument
--     `20260817001300` made for leaving blocked senders to `profiles_read`: the
--     function has no visibility logic, so it cannot have the wrong visibility logic.
--
--   * The **sender** policy admits their own rows in any state, because Hype Courier
--     counts them (`awards/use-awards.ts` reads this table directly) and the picker
--     marks people a title has already gone to. Neither needs `state`.
--
--   * `state` is then **granted to nobody**. Column privileges are what stop the
--     sender selecting it, and the recipient does not need it either: the two RPCs
--     that report it are `security definer` and answer only about `auth.uid()`.
--
-- A column added later inherits no privilege, which is the safe direction: a new
-- column is unreadable until somebody grants it deliberately.
-- ---------------------------------------------------------------------------

drop policy title_recommendations_read on title_recommendations;

create policy title_recommendations_recipient on title_recommendations for select
  using (recipient_id = auth.uid() and state = 'delivered');

create policy title_recommendations_sender on title_recommendations for select
  using (sender_id = auth.uid());

-- Restated in full rather than amended. `grant select (cols)` does not narrow an
-- existing table-wide `grant select`, so the revoke is what does the work and leaving
-- it implicit would be a privilege nobody can check -- review 17j's standing rule.
revoke select on title_recommendations from authenticated;
grant select (
  id, sender_id, recipient_id, media_item_id, created_at, recommended_at, opened_at
) on title_recommendations to authenticated;
revoke all on title_recommendations from anon;


-- ---------------------------------------------------------------------------
-- 3. The predicates
--
-- Both take the other party only, so neither can be turned into a "how do these two
-- strangers stand" oracle. The same shape, and the same reason, as `_is_mutual_follow`
-- -- which stays exactly where it is, because `_can_tag` still uses it. Putting your
-- name on somebody's watch is still a mutual act; telling them about a film is not,
-- and this tranche is the founder separating the two.
-- ---------------------------------------------------------------------------

create or replace function _may_recommend_to(p_other uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select p_other is not null
     and p_other <> auth.uid()
     and exists (select 1 from profiles p where p.id = p_other and p.status = 'active')
     -- `blocked_between` rather than an inline select on `blocks`: `blocks_read` hides
     -- a block from the person it was made against, so a subquery returns false for
     -- exactly the caller who must be refused.
     and not blocked_between(p_other, auth.uid())
     and exists (
       select 1 from follows f
        where f.follower_id = auth.uid() and f.followee_id = p_other
          and f.state = 'approved'
     );
$$;

comment on function _may_recommend_to(uuid) is
  'True when the caller approvedly follows the named account, it is active, and neither has blocked the other. The one place the send rule is written. Deliberately one-way and outbound: being followed by somebody authorises nothing, because that is the direction an unwanted sender controls. Internal, and takes only the other party so it can never be asked about two third parties.';

create or replace function _delivers_directly_to(p_other uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from follows f
     where f.follower_id = p_other and f.followee_id = auth.uid()
       and f.state = 'approved'
  );
$$;

comment on function _delivers_directly_to(uuid) is
  'True when the named account approvedly follows the caller -- the trust half of the rule, which decides delivered versus pending. Not an authorisation test and never used as one: _may_recommend_to has already run by the time this is asked. Internal, and phrased from the caller''s side so it cannot be asked about anybody else''s pair.';


-- ---------------------------------------------------------------------------
-- 4. Releasing what was held
--
-- One helper, called from every path where a follow toward the sender becomes
-- approved. There are three of them and missing one is the whole failure mode, so they
-- are named here and each is amended below:
--
--   * `follow`                    -- a public account, approved outright.
--   * `respond_follow_request`    -- a private account approving later.
--   * `set_profile_visibility`    -- a private account going public, which approves
--                                    every pending request at once.
--
-- **Pending only.** `dismissed` is excluded by the `where`, which is the whole of "a
-- dismissed recommendation is never released by a later follow". `delivered` is
-- excluded by it too, so a release cannot re-deliver something and cannot move a row
-- that an individual Add has already taken.
--
-- **No notification, deliberately.** See the header. The recipient has just followed
-- somebody; a burst of inbox rows describing the consequence of their own tap is noise
-- with no decision in it.
--
-- **Idempotent by construction.** The state guard is the idempotency: a second call
-- finds nothing pending and updates nothing. That is what makes it safe to call from
-- three writers that already claim their own operation ids, and safe under a replay of
-- any of them.
--
-- Takes both parties because it genuinely is about a pair and neither is necessarily
-- `auth.uid()` -- in `respond_follow_request` the caller is the *sender*. It is
-- internal and revoked below; it reads no row it does not write and reports nothing.
-- ---------------------------------------------------------------------------

create or replace function _release_recommendations(p_sender uuid, p_recipient uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released integer;
begin
  if p_sender is null or p_recipient is null or p_sender = p_recipient then
    return 0;
  end if;

  -- Defence in depth. Every caller has already established that no block exists --
  -- `block` deletes both follow edges, so an approved follow and a block cannot
  -- coexist -- but a release is a write into somebody's list and "usually" is not a
  -- privacy argument.
  if blocked_between(p_sender, p_recipient) then
    return 0;
  end if;

  update title_recommendations
     set state = 'delivered'
   where sender_id = p_sender
     and recipient_id = p_recipient
     and state = 'pending';

  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

comment on function _release_recommendations(uuid, uuid) is
  'Moves every pending recommendation from one sender to one recipient into delivered, exactly once, and silently. Called from follow, respond_follow_request and set_profile_visibility -- the three paths by which a follow toward the sender becomes approved. Dismissed rows are excluded, which is what makes a dismissal final. Files no notification: a burst describing the consequence of the reader''s own tap carries no decision. Internal.';


-- ---------------------------------------------------------------------------
-- 5. Sending one
--
-- Rebuilt in full rather than patched. `create or replace` in a schema with a history
-- is the trap `20260817000200` records -- `_assert_operation_rate` lost its advisory
-- lock that way, invisibly, because the diff against the *previous* migration showed
-- nothing. Reproducing the body means the diff against `20260817001300` is the thing a
-- reviewer reads.
--
-- WHAT CHANGED, IN ORDER
--
-- 1. `_is_mutual_follow` becomes `_may_recommend_to`. The refusal is renamed
--    `not_following` because it now means one thing rather than four.
-- 2. A per-pair pending ceiling, checked only when the send would *add* to it.
-- 3. The row is written with a state, decided by `_delivers_directly_to`.
-- 4. The notification is filed only when the row **enters** `delivered`, which happens
--    at most once per row and only ever here.
--
-- DUPLICATE SEMANTICS, restated because the state adds a case:
--
--   delivered → delivered   `recommended_at` moves. No notification. Unchanged.
--   pending   → pending     `recommended_at` moves. Already counted against the cap.
--   dismissed → pending     The recipient may see it again. Counts against the cap.
--   dismissed → delivered   They follow now. Notified, because they never were.
--
-- A `delivered` row is **never** demoted, and that is the founder's unfollow rule
-- written in one line: unfollowing somebody does not reach backwards into what they
-- already sent you. Only the *next* new title returns to Requests.
--
-- THE CEILING
--
-- Five pending per (sender, recipient) is a small number on purpose. The abuse surface
-- is already narrow -- a sender must follow the recipient to send at all -- so this is
-- not a spam defence so much as a guarantee that the Requests sheet stays a list
-- somebody will actually read. It is checked *after* the operation claim, like every
-- other refusal here, so a refused attempt still costs a slot against the hourly rate
-- limit. Free retries against a ceiling are how a ceiling becomes a busy loop.
--
-- It is asked of the **pair** rather than of the row being sent, and the comment at the
-- check itself says why: a ceiling that answers differently depending on what the
-- recipient did with a particular title is the privacy boundary of this whole tranche,
-- rebuilt out of a refusal code.
-- ---------------------------------------------------------------------------

create or replace function recommend_title(
  p_operation_id  uuid,
  p_recipient_id  uuid,
  p_media_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind      media_kind;
  v_id        uuid;
  v_state     recommendation_state;
  v_next      recommendation_state;
  v_direct    boolean;
  v_created   boolean;
  v_pending   integer;
  v_cap       integer;
  v_refusal   text;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'recommend_title') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  -- Burst first, then the daily ceiling. Both count the same kind; the hour is the
  -- one that catches a script and the day is the one that bounds a person.
  perform _assert_operation_rate('recommend_title', 'recommendations.max_per_hour', 20, interval '1 hour');
  perform _assert_operation_rate('recommend_title', 'recommendations.max_per_day', 50, interval '1 day');

  -- Before the eligibility check, because the check is what reads `follows` and
  -- `blocks`, and a block committing between the check and the insert is the race. It
  -- is also what serialises this against `follow` on the same pair, which is the whole
  -- of the send-versus-follow-back race: either this sees the approved edge and
  -- delivers, or it stores a pending row that the follow then releases. Never both.
  perform _lock_pair(auth.uid(), p_recipient_id);

  if p_recipient_id = auth.uid() then
    v_refusal := 'yourself';
  elsif not _may_recommend_to(p_recipient_id) then
    -- Missing, suspended, blocked either way, or simply not followed by the caller.
    -- One answer for all four: telling them apart tells a blocked caller they are
    -- blocked.
    v_refusal := 'not_following';
  else
    select m.kind into v_kind from media_items m where m.id = p_media_item_id;

    -- PRD §10. A series is not a thing anybody watched, so it is not a thing anybody
    -- can be told to watch. A title that does not exist reports the same way, and
    -- discloses nothing by doing so: `media_items_read` is `using (true)`.
    if v_kind is null or rankable_category(v_kind) is null then
      v_refusal := 'not_recommendable';
    end if;
  end if;

  if v_refusal is not null then
    -- Returned rather than raised, so this attempt keeps its claim and counts against
    -- the ceiling. See `20260817001300`'s header.
    return jsonb_build_object('status', 'refused', 'reason', v_refusal);
  end if;

  select r.id, r.state into v_id, v_state
    from title_recommendations r
   where r.sender_id = auth.uid()
     and r.recipient_id = p_recipient_id
     and r.media_item_id = p_media_item_id;

  v_direct := _delivers_directly_to(p_recipient_id);

  -- ---------------------------------------------------------------------------
  -- The ceiling, asked BEFORE the existing row's state is consulted.
  --
  -- **That ordering is the whole of it, and the first version got it wrong.** The cap
  -- used to be asked only when a send would *add* to the queue -- skipped for a resend
  -- of something already pending, on the reasoning that it had been counted already.
  -- Codex found what that buys a determined sender: with the queue full, resending a
  -- **pending** title succeeded and resending a **dismissed** one was refused, because
  -- only the second was trying to enter `pending`. Two different answers to the same
  -- call, separated by a decision the recipient made in private. That is the exact
  -- oracle §2 revokes a column privilege to prevent, rebuilt out of a refusal code.
  --
  -- So the question is now asked of the *pair* and nothing else: is the recipient
  -- following back, and how many of this sender's recommendations are waiting. Neither
  -- half is a fact about any one recommendation, and neither can be made into one.
  --
  -- What the sender can still learn is the aggregate -- that several of theirs are
  -- waiting -- and that is deliberate: it is what the refusal message says out loud
  -- (§22). Any cap discloses that it has been reached; what none of them may disclose
  -- is *which* item is which.
  --
  -- `v_direct` gates it because a recipient who follows back has said "send me things",
  -- and their queue is empty anyway: the release empties it the moment the follow lands.
  -- The only way to reach this with `v_direct` true is a resend of a row delivered
  -- before an unfollow, and refusing that would be a ceiling applied to somebody who
  -- has opted out of needing one.
  --
  -- The cost is that a sender at the ceiling cannot bump their own waiting
  -- recommendation back to the top of the list. That is not a loss worth an oracle,
  -- and it is arguably the better behaviour: the thing they are resending is already
  -- waiting, which is what the message tells them.
  -- ---------------------------------------------------------------------------
  if not v_direct then
    select coalesce(
             (select (value)::integer from app_config where key = 'recommendations.max_pending_per_pair'),
             5)
      into v_cap;

    select count(*) into v_pending
      from title_recommendations r
     where r.sender_id = auth.uid()
       and r.recipient_id = p_recipient_id
       and r.state = 'pending';

    if v_pending >= v_cap then
      -- Neutral on purpose. It says how many are waiting and nothing about what the
      -- recipient has or has not done with any of them.
      return jsonb_build_object('status', 'refused', 'reason', 'too_many_pending');
    end if;
  end if;

  -- The state this send is aiming at. A delivered row stays delivered whatever the
  -- relationship has since become -- see the header on unfollow.
  if v_state = 'delivered' then
    v_next := 'delivered';
  elsif v_direct then
    v_next := 'delivered';
  else
    v_next := 'pending';
  end if;

  v_created := v_id is null;

  if v_created then
    insert into title_recommendations (sender_id, recipient_id, media_item_id, state)
    values (auth.uid(), p_recipient_id, p_media_item_id, v_next)
    returning id into v_id;
  else
    -- `opened_at` is deliberately absent from this SET list, and its absence is
    -- load-bearing: see the comment on the column.
    update title_recommendations
       set recommended_at = now(),
           state = v_next
     where id = v_id;
  end if;

  -- Filed when, and only when, the row **enters** delivered. That is at most once per
  -- row: `delivered` is terminal, so a resend of a delivered row takes the `v_state =
  -- 'delivered'` branch above and lands here with `v_state` already delivered.
  --
  -- A pending row files nothing, which is the rule this tranche is built on. An Add
  -- and a release file nothing either, and they are elsewhere -- so this statement is
  -- the only writer of a `recommendation` notification in the schema, and a
  -- recommendation the recipient can see is the only kind that ever produced one.
  if v_next = 'delivered' and v_state is distinct from 'delivered' then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (p_recipient_id, 'recommendation', auth.uid(), 'media_item', p_media_item_id,
            jsonb_build_object('recommendation_id', v_id));
  end if;

  -- `created` keeps its old meaning -- a row that did not exist before -- because the
  -- client uses it for nothing else and a second meaning would be a silent change.
  -- `delivered` is new and is what the sender is *not* told about: it is here for
  -- tests and operators, and §17 of the brief is that the sending experience says
  -- "Sent" either way.
  return jsonb_build_object(
    'status', 'ok',
    'created', v_created,
    'id', v_id,
    'delivered', v_next = 'delivered'
  );
end;
$$;

comment on function recommend_title(uuid, uuid, uuid) is
  'Recommends one exact title to somebody the caller approvedly follows. Delivers immediately when that person follows the caller back, and otherwise stores it as a pending request that the recipient can add or dismiss -- a recommendation is never refused for the relationship alone and never silently lost. A stranger, a one-way follow in the wrong direction, a block, a suspension and a series are refused by returning {"status":"refused"} rather than by raising, so a refused attempt still costs a rate-limit slot. At most five pending per (sender, recipient). A notification is filed only when the row enters delivered, which happens at most once and only here.';


-- ---------------------------------------------------------------------------
-- 6. Reading the delivered ones back
--
-- Rebuilt for one reason: it must not return pending rows, and **it does not say so**.
--
-- The filter is the recipient's RLS policy (§2), and leaving it there rather than
-- adding `and r.state = 'delivered'` to the body is deliberate. This function is
-- `security invoker` and its entire safety argument is that it contains no visibility
-- logic of its own -- `profiles_read` is what drops a blocked or newly private sender,
-- and now `title_recommendations_recipient` is what drops a request. A body that
-- restated the rule would be a second opinion to keep in step, and the column it would
-- have to read is the one §2 grants to nobody.
--
-- Everything else is carried over unchanged, and the `create or replace` is here
-- rather than absent so that the dependency is written down where the next reader of
-- this function will find it.
-- ---------------------------------------------------------------------------

create or replace function recommendations_to_me(p_limit integer default 100)
returns table (
  id                  uuid,
  sender_id           uuid,
  sender_username     text,
  sender_display_name text,
  sender_avatar_path  text,
  media_item_id       uuid,
  media_kind          media_kind,
  media_title         text,
  series_title        text,
  poster_path         text,
  release_date        date,
  genres              text[],
  original_language   text,
  runtime_minutes     integer,
  recommended_at      timestamptz,
  opened_at           timestamptz
)
language sql stable security invoker
set search_path = public
as $$
  select r.id,
         r.sender_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         m.id,
         m.kind,
         m.title,
         parent.title,
         m.poster_path,
         m.release_date,
         m.genres,
         m.original_language,
         m.runtime_minutes,
         r.recommended_at,
         r.opened_at
    from title_recommendations r
    join profiles p    on p.id = r.sender_id and p.status = 'active'
    join media_items m on m.id = r.media_item_id
    left join media_items parent on parent.id = m.parent_id
   -- Pending and dismissed rows are absent because `title_recommendations_recipient`
   -- does not admit them, not because of anything written here. See the header.
   where r.recipient_id = auth.uid()
   order by (r.opened_at is not null), r.recommended_at desc
   limit least(greatest(coalesce(p_limit, 100), 1), 200);
$$;

comment on function recommendations_to_me(integer) is
  'The caller''s "Sent to you" list, unopened first and newest within that. security invoker on purpose, and now for two reasons: profiles_read is what makes a blocked or newly private sender disappear, and title_recommendations_recipient is what makes a pending request disappear -- so this function contains no visibility logic of its own and cannot get it wrong. Cannot be asked about another account.';


-- ---------------------------------------------------------------------------
-- 7. Reading the pending ones
--
-- `security definer`, and that is a decision rather than a convenience.
--
-- **A private sender is invisible to the person holding their request.** The sender
-- follows the recipient; the recipient does not follow back. If the sender's profile
-- is private then `can_view_profile(sender, recipient)` is false -- correctly -- so an
-- invoker query returns a request with no name, no handle and no picture attached, and
-- the one screen whose entire purpose is to let somebody decide about it cannot draw
-- the person they are deciding about.
--
-- This is exactly the shape of `my_notifications` and `my_blocks`, and it earns definer
-- the same way: the filter is `recipient_id = auth.uid()`, it is not a parameter, and
-- it cannot be made one. There is no way to ask this function about anybody else.
--
-- WHAT IT DISCLOSES, STATED PLAINLY
--
-- The handle, display name and picture of every account that has sent the caller a
-- recommendation. That set is, by construction, people who chose to follow the caller
-- *and then* chose to send them something -- a narrower set than `my_notifications`
-- already names, reached by two deliberate acts. A blocked account discloses nothing:
-- `block` deletes the pending rows and the `blocked_between` filter below would drop
-- them anyway.
--
-- ORDERING
--
-- Sender groups by their newest request, newest group first; newest request within a
-- group. Done here rather than on the client so that the sheet and any count drawn
-- above it cannot disagree -- the same rule `use-sent-to-you.ts` follows.
--
-- THE COUNT
--
-- `count(*) over ()` is evaluated before `limit`, so `total_pending` is the true total
-- even when the list is capped. The compact alert row is a number the reader is
-- entitled to trust, and a capped list presented as a total is the defect review 21c
-- named on the unopened chip.
-- ---------------------------------------------------------------------------

create or replace function recommendation_requests(p_limit integer default 100)
returns table (
  id                  uuid,
  sender_id           uuid,
  sender_username     text,
  sender_display_name text,
  sender_avatar_path  text,
  media_item_id       uuid,
  media_kind          media_kind,
  media_title         text,
  series_title        text,
  poster_path         text,
  release_date        date,
  genres              text[],
  original_language   text,
  runtime_minutes     integer,
  recommended_at      timestamptz,
  total_pending       bigint
)
language sql stable security definer
set search_path = public
as $$
  select r.id,
         r.sender_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         m.id,
         m.kind,
         m.title,
         parent.title,
         m.poster_path,
         m.release_date,
         m.genres,
         m.original_language,
         m.runtime_minutes,
         r.recommended_at,
         count(*) over ()
    from title_recommendations r
    -- Inner, and `active`, so a suspended sender's requests stop appearing rather than
    -- being drawn anonymously. The same rule `my_notifications` follows: "somebody
    -- recommended this to you" with no somebody is not a thing to show.
    join profiles p    on p.id = r.sender_id and p.status = 'active'
    join media_items m on m.id = r.media_item_id
    left join media_items parent on parent.id = m.parent_id
   where r.recipient_id = auth.uid()
     and r.state = 'pending'
     -- Definer, so no policy is doing this. `block` already deletes these rows; this
     -- is the guarantee that does not depend on that having happened.
     and not blocked_between(r.sender_id, auth.uid())
   order by max(r.recommended_at) over (partition by r.sender_id) desc,
            r.sender_id,
            r.recommended_at desc
   limit least(greatest(coalesce(p_limit, 100), 1), 200);
$$;

comment on function recommendation_requests(integer) is
  'The caller''s pending recommendation requests, grouped by sender -- newest sender activity first, newest request within a sender. Definer for the same reason my_notifications is: a private sender who follows the caller without being followed back fails can_view_profile, so an invoker query could not name the person whose request is being decided about. Takes no recipient and cannot be asked about anybody else. total_pending is counted before the limit, so a capped list still reports a true total.';


-- ---------------------------------------------------------------------------
-- 8. Adding one
--
-- **Add, not Accept.** The recipient is not admitting somebody to anything; they are
-- moving one title into their own list. Nothing about the sender changes -- they are
-- not followed, their other requests are not released, and they are not told.
--
-- No operation id, for the reason `mark_recommendation_opened` has none: this is
-- idempotent by construction and writes nothing anybody else can see. The guard is
-- `state = 'pending'`, and both transitions out of pending are terminal, so a replay
-- after a lost reply finds a row that is already `delivered` and does nothing. It also
-- makes the race safe without a lock: an Add and a concurrent bulk release contend on
-- the same row, whichever commits second finds the guard false, and there is only ever
-- one row to begin with -- so a duplicate delivery is not merely unlikely, it has
-- nowhere to live.
--
-- Silent about rows that are not the caller's, and about rows that were never pending:
-- "that exists but is not yours" is a fact about somebody else's screen.
-- ---------------------------------------------------------------------------

create or replace function add_recommendation(p_recommendation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_added integer;
begin
  perform assert_can_write();

  update title_recommendations r
     set state = 'delivered'
   where r.id = p_recommendation_id
     and r.recipient_id = auth.uid()
     and r.state = 'pending'
     -- A block severs the pair, and `block` deletes these rows -- but if one survived
     -- some path nobody has thought of, adding it would write a blocked account's
     -- suggestion into the caller's list. Cheap, and the direction of the mistake
     -- matters.
     and not blocked_between(r.sender_id, auth.uid());

  get diagnostics v_added = row_count;

  -- No notification, in either direction. The recipient performed this act, and the
  -- sender is deliberately told nothing about what happened to what they sent. The
  -- recommendation appearing in Recommendations is the whole of the outcome.
  return jsonb_build_object('status', 'ok', 'added', v_added > 0);
end;
$$;

comment on function add_recommendation(uuid) is
  'Moves one of the caller''s own pending recommendation requests into their ordinary Recommendations list, once. Does not follow the sender, does not release their other requests, and notifies nobody. No operation id: idempotent by construction -- the state guard makes a replay a no-op -- and it writes nothing anybody else can see, which is the exception mark_recommendation_opened already occupies.';


-- ---------------------------------------------------------------------------
-- 9. Dismissing one, and dismissing all
--
-- Dismissing is **final for that recommendation and permissive about the sender**. The
-- row becomes a tombstone that a later follow will not release, and that is the whole
-- of it: the sender is not blocked, not unfollowed, not told, and may send the same
-- title again tomorrow -- which will arrive as a new pending request, because
-- `recommend_title` moves a dismissed row back to pending.
--
-- That last part is intentional and worth defending. A dismissal that also suppressed
-- future sends would be a second permission graph built out of tombstones, invisible
-- to both parties and impossible to review. The controls for "stop sending me things"
-- are unfollow and block, and they already say it.
--
-- `dismiss_all_recommendation_requests` takes an operation id where the single-row
-- writers do not, and the asymmetry is the point: the single-row ones are addressed at
-- a row that either is or is not pending, so a replay is a no-op. This one is
-- addressed at *whatever is pending when it runs*, so a replay after a lost reply
-- would sweep away requests that arrived in between -- a bulk destructive action
-- silently eating something the reader never saw. `_claim_operation` is exactly the
-- ledger for that.
-- ---------------------------------------------------------------------------

create or replace function dismiss_recommendation(p_recommendation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dismissed integer;
begin
  perform assert_can_write();

  update title_recommendations r
     set state = 'dismissed'
   where r.id = p_recommendation_id
     and r.recipient_id = auth.uid()
     and r.state = 'pending';

  get diagnostics v_dismissed = row_count;

  return jsonb_build_object('status', 'ok', 'dismissed', v_dismissed > 0);
end;
$$;

comment on function dismiss_recommendation(uuid) is
  'Throws away one of the caller''s own pending recommendation requests. The row becomes a tombstone rather than a deletion, so a later follow will not release it. The sender is not notified, not unfollowed and not blocked, and may send the same title again -- the controls for stopping that are unfollow and block. No operation id, for the same reason add_recommendation has none.';

create or replace function dismiss_all_recommendation_requests(p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dismissed integer;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'dismiss_all_recommendation_requests') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  update title_recommendations r
     set state = 'dismissed'
   where r.recipient_id = auth.uid()
     and r.state = 'pending';

  get diagnostics v_dismissed = row_count;

  return jsonb_build_object('status', 'ok', 'dismissed', v_dismissed);
end;
$$;

comment on function dismiss_all_recommendation_requests(uuid) is
  'Throws away every pending recommendation request the caller holds, from everybody. Follows, unfollows and blocks nobody, and notifies nobody. Takes an operation id where the single-row writers do not: this one is addressed at whatever is pending when it runs, so a replay after a lost reply would sweep requests that arrived in between.';


-- ---------------------------------------------------------------------------
-- 10. The three paths a follow becomes approved by
--
-- Each is rebuilt in full and each gains exactly one call. The bodies are otherwise
-- carried over verbatim from `20260817000200` and `20260817000600`, for the reason
-- those migrations record: `create or replace` in a schema with a history hides what
-- was lost, and reproducing the body is what makes the diff readable.
--
-- The release sits **inside** each transaction, under whatever lock that writer
-- already holds. In `follow` that is `_lock_pair(caller, followee)` -- the same key
-- `recommend_title` takes -- which is what makes send-versus-follow-back deterministic
-- rather than lucky: a send either sees the approved edge and delivers, or stores a
-- pending row that this then releases. There is one row, so there is one outcome.
-- ---------------------------------------------------------------------------

create or replace function follow(p_operation_id uuid, p_followee_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visibility profile_visibility;
  v_state      follow_state;
  v_existing   follow_state;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'follow') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  -- Per hour, not per day (api.md §11). A mass-follow script is a burst.
  perform _assert_operation_rate('follow', 'follow.max_per_hour', 60, interval '1 hour');

  -- Before the reachability check, not after: the check is what reads `blocks`, and a
  -- block committing between the check and the insert is precisely the race.
  perform _lock_pair(auth.uid(), p_followee_id);

  -- The followee's own row, shared, so that a concurrent `set_profile_visibility` on
  -- that account either commits before this reads it or waits until after this has
  -- inserted (20260817000600).
  perform 1 from profiles where id = p_followee_id for share;

  v_visibility := _assert_reachable(p_followee_id);

  -- A public account is followed outright; a private one receives a request. This is
  -- the only place in the schema that decides which, and it decides it from the
  -- target's own setting rather than from anything the caller sends.
  v_state := case when v_visibility = 'private' then 'pending' else 'approved' end;

  select f.state into v_existing
    from follows f
   where f.follower_id = auth.uid() and f.followee_id = p_followee_id;

  -- Already there. Return the state rather than raising, and never downgrade: if an
  -- approved follow exists and the account has since become private, re-following must
  -- not demote it to pending.
  if v_existing is not null then
    -- NEW (20260826000400). A follow that was already approved has already released
    -- whatever it was going to release, and this call changed nothing -- so there is
    -- nothing to do here. Stated rather than left implicit, because "the release lives
    -- on the insert path" is the sort of thing a later reader has to check.
    return jsonb_build_object('status', 'ok', 'state', v_existing);
  end if;

  insert into follows (follower_id, followee_id, state, approved_at)
  values (auth.uid(), p_followee_id, v_state,
          case when v_state = 'approved' then now() end);

  -- PRD §15's inbox row. Two types, because they are two different things to be
  -- told: somebody followed you, or somebody is waiting on you.
  insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
  values (p_followee_id,
          case when v_state = 'approved' then 'follow' else 'follow_request' end,
          auth.uid(), 'profile', auth.uid());

  -- NEW (20260826000400). Following somebody is how a recipient says "their
  -- suggestions can come straight through", so everything they are already holding
  -- from that person is released now. Only on `approved`: a pending request has
  -- decided nothing yet, and `respond_follow_request` below is where that case lands.
  -- Silent -- see `_release_recommendations`.
  if v_state = 'approved' then
    perform _release_recommendations(p_followee_id, auth.uid());
  end if;

  return jsonb_build_object('status', 'ok', 'state', v_state);
end;
$$;

comment on function follow(uuid, uuid) is
  'Follows a public account outright and files a request against a private one. Refuses a missing, suspended or blocked target with the same P0002. Never downgrades an existing approved follow to pending. Takes a share lock on the followee''s profile row so a concurrent visibility change cannot leave a public account holding a pending request. Releases every recommendation that account was holding for the caller when the follow lands approved (20260826000400), inside the same pair lock recommend_title takes -- which is what makes a send racing a follow-back deliver exactly once. Rate-limited per hour.';

create or replace function respond_follow_request(
  p_operation_id uuid,
  p_requester_id uuid,
  p_approve      boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_found boolean := false;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'respond_follow_request') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _lock_pair(auth.uid(), p_requester_id);

  if p_approve then
    update follows
       set state = 'approved', approved_at = now()
     where follower_id = p_requester_id
       and followee_id = auth.uid()
       and state = 'pending';
    v_found := found;

    if v_found then
      -- The requester is told they are in. Without this the pending state is a
      -- silence they have to keep checking.
      insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
      values (p_requester_id, 'follow_approved', auth.uid(), 'profile', auth.uid());

      -- NEW (20260826000400). The other half of the release, and the half that is easy
      -- to miss: the caller here is the **sender** of the held recommendations, and
      -- the requester is the recipient. A private account approving a follower is that
      -- follower deciding to trust them, answered late.
      perform _release_recommendations(auth.uid(), p_requester_id);
    end if;
  else
    delete from follows
     where follower_id = p_requester_id
       and followee_id = auth.uid()
       and state = 'pending';
    v_found := found;
    -- Declining is deliberately silent. Telling somebody they were turned down is a
    -- message nobody chose to send. Nothing is released: the follow did not happen.
  end if;

  -- The request has been dealt with either way, so it should stop appearing.
  delete from notifications
   where recipient_id = auth.uid()
     and actor_id = p_requester_id
     and type = 'follow_request';

  if not v_found then
    -- No pending request from that account. Same P0002 whether the requester does not
    -- exist, never asked, or has already been answered.
    raise exception 'no such request' using errcode = 'P0002';
  end if;

  return jsonb_build_object('status', 'ok', 'approved', p_approve);
end;
$$;

comment on function respond_follow_request(uuid, uuid, boolean) is
  'Approves or declines a pending request to follow the caller. Declining is silent by design and releases nothing -- the follow did not happen. Approving releases every recommendation the caller was holding for that requester (20260826000400): the requester asked to follow, and this is that decision answered late. Clears the request from the caller''s inbox either way. P0002 when there is no pending request.';

create or replace function set_profile_visibility(
  p_operation_id uuid,
  p_visibility   profile_visibility
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current  profile_visibility;
  v_approved integer := 0;
  v_follower uuid;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_profile_visibility') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('set_profile_visibility', 'profile.max_edits_per_day', 20);

  if p_visibility is null then
    raise exception 'visibility is required' using errcode = '22023';
  end if;

  -- `for update`, for a race the pair lock cannot reach: a follower can read
  -- `private`, be told to wait while this transaction promotes everybody it can see,
  -- and then insert a `pending` row into a profile that is now public. `follow` takes
  -- `for share` on this same row, so the two conflict (20260817000600).
  select p.visibility into v_current from profiles p where p.id = auth.uid()
    for update;
  if v_current is null then
    raise exception 'no profile to update' using errcode = '42704';
  end if;

  if v_current = p_visibility then
    return jsonb_build_object('status', 'ok', 'visibility', p_visibility, 'approved', 0);
  end if;

  update profiles set visibility = p_visibility where id = auth.uid();

  if p_visibility = 'public' then
    -- NEW (20260826000400). The loop replaces a `select count(*) into` over the same
    -- CTE, because each promoted follower is now a release as well as a number. This
    -- is the third path a follow becomes approved by, and the one that would have been
    -- missed: going public approves every pending request at once, so somebody who
    -- asked to follow this account weeks ago is now following it, and whatever this
    -- account sent them is theirs.
    for v_follower in
      with promoted as (
        update follows
           set state = 'approved', approved_at = now()
         where followee_id = auth.uid()
           and state = 'pending'
        returning follower_id
      )
      select follower_id from promoted
    loop
      v_approved := v_approved + 1;
      perform _release_recommendations(auth.uid(), v_follower);
    end loop;

    -- The requests have been answered by the setting rather than by the user, so the
    -- inbox rows go with them. Left behind they would offer Approve and Decline for a
    -- decision that has already been made.
    delete from notifications
     where recipient_id = auth.uid()
       and type = 'follow_request';
  end if;

  return jsonb_build_object('status', 'ok', 'visibility', p_visibility, 'approved', v_approved);
end;
$$;

comment on function set_profile_visibility(uuid, profile_visibility) is
  'Sets the caller''s profile visibility. Going public approves every pending request *silently* -- nobody decided about those people, the account stopped requiring a decision, and a follow_approved notification would attribute an act the user did not perform -- and releases every recommendation the caller was holding for each of them (20260826000400), which is the third and least obvious path a follow becomes approved by. Going private does not remove existing followers: that is remove_follower''s job.';


-- ---------------------------------------------------------------------------
-- 11. Block
--
-- A pending request from somebody the user has just blocked is an unresolved decision
-- about a person they have said they want gone. It is deleted, in both directions, for
-- the same reason `block` already deletes both inboxes of the other.
--
-- **Delivered rows are left alone**, and that is the founder's call rather than an
-- oversight. An accepted recommendation is part of the reader's own collection
-- history; a safety action should not reach into it. It disappears from their list
-- anyway while the block stands, because `recommendations_to_me` is `security invoker`
-- and `profiles_read` drops the sender -- so nothing leaks, and unblocking restores a
-- list rather than resurrecting a decision.
--
-- Dismissed rows are left alone too. They are tombstones and they name nobody on any
-- screen.
--
-- Rebuilt in full, per the rule in §10.
-- ---------------------------------------------------------------------------

create or replace function block(p_operation_id uuid, p_blocked_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'block') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  if p_blocked_id is null or p_blocked_id = auth.uid() then
    raise exception 'you cannot block yourself' using errcode = '22023';
  end if;

  -- Deliberately *not* `_assert_reachable`. Blocking must work against a suspended
  -- account, and must be idempotent against an existing block rather than raising.
  if not exists (select 1 from profiles where id = p_blocked_id) then
    raise exception 'no such account' using errcode = 'P0002';
  end if;

  -- Taken before the first deletion, so a follow arriving concurrently either happens
  -- entirely before this block (and is deleted below) or entirely after it (and is
  -- refused by `_assert_reachable`). It is also the lock `follow` holds while it
  -- releases recommendations, so a block cannot interleave with a release.
  perform _lock_pair(auth.uid(), p_blocked_id);

  delete from follows
   where (follower_id = auth.uid() and followee_id = p_blocked_id)
      or (follower_id = p_blocked_id and followee_id = auth.uid());

  -- Growth provenance between two people who have severed contact is not a record
  -- worth keeping warm. Only unaccepted attributions are voided.
  update invite_attributions
     set token_id = null
   where accepted_at is null
     and ((invitee_id = auth.uid()      and inviter_id = p_blocked_id)
       or (invitee_id = p_blocked_id and inviter_id = auth.uid()));

  insert into blocks (blocker_id, blocked_id)
  values (auth.uid(), p_blocked_id)
  on conflict (blocker_id, blocked_id) do nothing;

  -- Anything either of them sent the other stops being an inbox item.
  delete from notifications
   where (recipient_id = auth.uid()      and actor_id = p_blocked_id)
      or (recipient_id = p_blocked_id and actor_id = auth.uid());

  -- NEW (20260826000400). Both directions, because a block is symmetric and the user
  -- may be on either end of the held request. Deleted rather than dismissed: a
  -- tombstone exists to survive a later follow, and there is not going to be one.
  delete from title_recommendations
   where state = 'pending'
     and ((sender_id = auth.uid()      and recipient_id = p_blocked_id)
       or (sender_id = p_blocked_id and recipient_id = auth.uid()));

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function block(uuid, uuid) is
  'Blocks an account: removes the follow in both directions, voids unaccepted invite attributions between the pair, clears both inboxes of the other, deletes any pending recommendation request between them in either direction (20260826000400), and inserts the block. Delivered recommendations are deliberately left in place -- they are the reader''s own history, and profiles_read hides the sender while the block stands. Everything else follows from can_view_profile. Idempotent, and works against a suspended account.';


-- ---------------------------------------------------------------------------
-- 12. Configuration and privileges
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values
  ('recommendations.max_pending_per_pair', '5'::jsonb)
on conflict (key) do nothing;

grant execute on function recommendation_requests(integer)                to authenticated;
grant execute on function add_recommendation(uuid)                        to authenticated;
grant execute on function dismiss_recommendation(uuid)                    to authenticated;
grant execute on function dismiss_all_recommendation_requests(uuid)       to authenticated;

-- Internal, and said out loud rather than left to the default-privileges revoke in
-- 20260813001800. All three answer questions about the follow graph or write into
-- somebody's list, and `_release_recommendations` is the only one here that takes two
-- accounts -- which is precisely why it must never be callable from a client.
revoke execute on function _may_recommend_to(uuid)                   from public, anon, authenticated;
revoke execute on function _delivers_directly_to(uuid)               from public, anon, authenticated;
revoke execute on function _release_recommendations(uuid, uuid)      from public, anon, authenticated;
