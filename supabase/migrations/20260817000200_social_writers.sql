-- The social graph becomes writable.
-- Specification: api.md §3 · PRD §22 · founder addendum 2026-08-16 §4 (the two-user gate).
--
-- ---------------------------------------------------------------------------
-- WHAT WAS MISSING
--
-- `follows` and `blocks` were created on day one (20260813000300), have had read
-- policies since, and are consulted by `can_view_profile` — which is to say the entire
-- visibility architecture is built on two tables that **no code path could ever write
-- a row into**. api.md §3 has specified `follow`, `unfollow`, `respond_follow_request`,
-- `remove_follower`, `block` and `unblock` from the start; none existed.
--
-- Nothing surfaced it because nothing needed an edge until now: the feed seeded its
-- follow set from fixtures, and every test that needed a relationship inserted the row
-- directly as the table owner. The founder's two-user acceptance gate is what makes it
-- load-bearing — "A finds B, follows where permitted, B reciprocates" is not
-- expressible against this database as it stands.
--
-- ---------------------------------------------------------------------------
-- WHO CAN BE FOLLOWED, AND WHY IT IS NOT `can_view_profile`
--
-- Every other cross-account writer in this schema gates on `can_view_profile`. This
-- one must not, and the reason is the private-account flow.
--
-- `can_view_profile(viewer, private-account-you-do-not-follow)` is **false**. If
-- `follow` required it, a follow *request* to a private account would be refused —
-- which is the one thing the pending state exists for. `follows.state = 'pending'`,
-- `respond_follow_request`, and the `approved_at` column would all be unreachable
-- code.
--
-- So the predicate is the three conditions that are genuinely disqualifying, resolved
-- in one query so they report as one answer:
--
--   the account does not exist
--   the account is not active        (suspended or deactivated)
--   a block exists in either direction
--
-- All three raise the same P0002 with the same message, because distinguishing them
-- is the disclosure: a caller must not be able to tell "you are blocked" from "no such
-- account", and a blocked person learning they are blocked from an error code is
-- exactly the harassment vector `blocks_read` hides the row to prevent.
--
-- What a caller *can* learn from a successful call is whether the target is public or
-- private, because the returned state is `approved` or `pending`. That is not a leak
-- worth closing: they had to already hold the account's uuid, and telling them their
-- request is awaiting approval is the whole point of making it.
--
-- Note also what this does **not** make discoverable. A private account still cannot
-- be found — `profiles_read` is `can_i_view(id)` and `search_users` (20260817000300)
-- inherits it. Following a private account requires already having its id, which in
-- practice means an invite link. That is the architecture the invite flow was designed
-- around (api.md §7 step 5) rather than a consequence discovered here.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The rate limiter gains a window
--
-- `_assert_operation_rate` hardcoded `interval '1 day'`, which is right for reactions,
-- comments and tags. api.md §11 specifies follows are limited **per hour** — a
-- mass-follow script is a burst, and a daily ceiling that a burst fits inside is not a
-- limit on the thing being limited.
--
-- Dropped and recreated with a defaulted fourth parameter rather than overloaded: two
-- functions whose argument sets are a subset of one another make a three-argument call
-- ambiguous, and the existing three-argument callers must keep resolving. This is the
-- shape 20260816000000 used for the note writers, for the same reason.
-- ---------------------------------------------------------------------------

drop function if exists _assert_operation_rate(text, text, integer);

create or replace function _assert_operation_rate(
  p_kind       text,
  p_config_key text,
  p_fallback   integer,
  p_window     interval default interval '1 day'
)
returns void
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_max  integer;
  v_used integer;
begin
  select coalesce((select (value)::integer from app_config where key = p_config_key), p_fallback)
    into v_max;

  select count(*) into v_used
    from processed_operations
   where user_id = auth.uid()
     and kind = p_kind
     and processed_at > now() - p_window;

  if v_used > v_max then
    raise exception 'you have done that too many times today'
      using errcode = '53400',
            hint = format('%s is limited to %s per %s', p_kind, v_max, p_window);
  end if;
end;
$$;

comment on function _assert_operation_rate(text, text, integer, interval) is
  'Per-window ceiling on one kind of operation, counted from processed_operations rather than from the rows the operation creates -- so a follow-and-unfollow loop is bounded, which counting follows would not be. Window defaults to a day; follows use an hour (api.md §11). Internal: exposing it would report another account''s activity level.';

-- ---------------------------------------------------------------------------
-- The shared gate
--
-- One helper, so that the "exists, active, not blocked either way" rule is written
-- once. Every writer below that acts on another account calls it, and the error it
-- raises is identical in all of them.
--
-- `blocked_between` rather than an inline select on `blocks`: `blocks_read`
-- deliberately hides a block from the person it was made against, so a subquery here
-- would return false for precisely the caller who must be refused. That is the same
-- reasoning `watch_tag_visible` and `_can_tag` record; getting it wrong is silent.
-- ---------------------------------------------------------------------------

create or replace function _assert_reachable(p_target uuid)
returns profile_visibility
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_visibility profile_visibility;
begin
  if p_target is null then
    raise exception 'no such account' using errcode = 'P0002';
  end if;

  if p_target = auth.uid() then
    raise exception 'you cannot do that to yourself' using errcode = '22023';
  end if;

  select p.visibility into v_visibility
    from profiles p
   where p.id = p_target
     and p.status = 'active';

  if v_visibility is null or blocked_between(auth.uid(), p_target) then
    raise exception 'no such account' using errcode = 'P0002';
  end if;

  return v_visibility;
end;
$$;

comment on function _assert_reachable(uuid) is
  'Raises P0002 unless the target account exists, is active, and has no block in either direction -- one error for all three, because telling them apart tells a blocked caller they are blocked. Returns the target''s visibility, which is what decides whether a follow is approved or pending. Internal: it answers questions about a named third party.';

-- ---------------------------------------------------------------------------
-- 1. Following
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

  v_visibility := _assert_reachable(p_followee_id);

  -- A public account is followed outright; a private one receives a request. This is
  -- the only place in the schema that decides which, and it decides it from the
  -- target's own setting rather than from anything the caller sends.
  v_state := case when v_visibility = 'private' then 'pending' else 'approved' end;

  select f.state into v_existing
    from follows f
   where f.follower_id = auth.uid() and f.followee_id = p_followee_id;

  -- Already there. Return the state rather than raising: following someone you follow
  -- is a tap that reached the state it meant, and a retry after a dropped response
  -- must not be an error.
  --
  -- Critically, an existing row is **never downgraded**. If an approved follow exists
  -- and the account has since become private, re-following must not demote it to
  -- pending — that would let anyone revoke their own approved access by tapping twice,
  -- and worse, would fire a fresh request notification at the followee.
  if v_existing is not null then
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

  return jsonb_build_object('status', 'ok', 'state', v_state);
end;
$$;

comment on function follow(uuid, uuid) is
  'Follows a public account outright and files a request against a private one. Refuses a missing, suspended or blocked target with the same P0002, because telling them apart tells a blocked caller they are blocked. Never downgrades an existing approved follow to pending. Rate-limited per hour (api.md §11).';

create or replace function unfollow(p_operation_id uuid, p_followee_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'unfollow') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  -- No reachability check, deliberately. Unfollowing is withdrawal, and it must work
  -- against an account that has since been suspended or has blocked the caller —
  -- otherwise a block would trap the follow row in place, and the blocked person would
  -- go on being counted as a follower of somebody who wants nothing to do with them.
  -- Nothing here can disclose anything: the row is the caller's own.
  delete from follows
   where follower_id = auth.uid() and followee_id = p_followee_id;

  -- The request that is being withdrawn should stop asking. Left behind, a private
  -- account would go on seeing a pending request for a follow that no longer exists,
  -- and approving it would resurrect nothing.
  delete from notifications
   where recipient_id = p_followee_id
     and actor_id = auth.uid()
     and type in ('follow', 'follow_request');

  -- Not an error when there was nothing to remove. Like removing a reaction, this is a
  -- toggle reaching a state rather than a transaction against a row.
  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function unfollow(uuid, uuid) is
  'Removes the caller''s follow or withdraws their pending request, and the inbox row that announced it. Idempotent, and deliberately works against a suspended account or one that has blocked the caller -- otherwise a block would trap the follow in place.';

-- ---------------------------------------------------------------------------
-- 2. The private account's side
-- ---------------------------------------------------------------------------

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
    end if;
  else
    delete from follows
     where follower_id = p_requester_id
       and followee_id = auth.uid()
       and state = 'pending';
    v_found := found;
    -- Declining is deliberately silent. Telling somebody they were turned down is a
    -- message nobody chose to send, and it invites the exchange the private setting
    -- exists to avoid. The request simply stops existing; they may ask again.
  end if;

  -- The request has been dealt with either way, so it should stop appearing.
  delete from notifications
   where recipient_id = auth.uid()
     and actor_id = p_requester_id
     and type = 'follow_request';

  if not v_found then
    -- No pending request from that account. Same P0002 whether the requester does not
    -- exist, never asked, or has already been answered: all three are "there is
    -- nothing here to respond to", and only the caller's own inbox could distinguish
    -- them anyway.
    raise exception 'no such request' using errcode = 'P0002';
  end if;

  return jsonb_build_object('status', 'ok', 'approved', p_approve);
end;
$$;

comment on function respond_follow_request(uuid, uuid, boolean) is
  'Approves or declines a pending request to follow the caller. Declining is silent by design -- being told you were turned down is a message nobody chose to send. Clears the request from the caller''s inbox either way. P0002 when there is no pending request, whatever the reason.';

create or replace function remove_follower(p_operation_id uuid, p_follower_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'remove_follower') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  -- The caller's own inbound edge, so no reachability check and nothing to disclose.
  -- Silent to the removed follower, for the same reason declining is silent.
  delete from follows
   where follower_id = p_follower_id and followee_id = auth.uid();

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function remove_follower(uuid, uuid) is
  'Removes somebody who follows the caller, in either state. Silent to them, and idempotent. Not a block: they may follow again, which is the difference the two controls have to keep.';

-- ---------------------------------------------------------------------------
-- 3. Blocking
--
-- api.md §3: "Removes follows both ways, voids invitations, hides tags", in one
-- transaction. Everything else — feed, leaderboard, match, tagging, comments, the
-- public pages — follows automatically, because they all read through
-- `can_view_profile`, which already consults `blocks`. That is AD-5 paying for itself:
-- this function writes one row and deletes two, and seven surfaces change.
--
-- Not queueable (PRD §18). A safety action whose effect is an hour late is not a
-- safety action.
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
  -- account — a suspension can be lifted, and the person who wanted the block still
  -- wants it — and it must be idempotent against an existing block rather than
  -- raising, because the caller cannot see `blocks` rows made against them and a
  -- second tap must not be an error. The only refusal is a target that is not a real
  -- account, which the foreign key enforces anyway.
  if not exists (select 1 from profiles where id = p_blocked_id) then
    raise exception 'no such account' using errcode = 'P0002';
  end if;

  delete from follows
   where (follower_id = auth.uid() and followee_id = p_blocked_id)
      or (follower_id = p_blocked_id and followee_id = auth.uid());

  -- Growth provenance between two people who have severed contact is not a record
  -- worth keeping warm. Only unaccepted attributions are voided: an accepted one is
  -- historical fact about how somebody joined, and rewriting it would corrupt the
  -- invite metrics rather than protect anybody.
  update invite_attributions
     set token_id = null
   where accepted_at is null
     and ((invitee_id = auth.uid()      and inviter_id = p_blocked_id)
       or (invitee_id = p_blocked_id and inviter_id = auth.uid()));

  insert into blocks (blocker_id, blocked_id)
  values (auth.uid(), p_blocked_id)
  on conflict (blocker_id, blocked_id) do nothing;

  -- Anything either of them sent the other stops being an inbox item. The rows would
  -- otherwise sit there naming somebody the user has just said they want gone.
  delete from notifications
   where (recipient_id = auth.uid()      and actor_id = p_blocked_id)
      or (recipient_id = p_blocked_id and actor_id = auth.uid());

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function block(uuid, uuid) is
  'Blocks an account: removes the follow in both directions, voids unaccepted invite attributions between the pair, clears both inboxes of the other, and inserts the block. Everything else follows from can_view_profile. Idempotent, and works against a suspended account.';

create or replace function unblock(p_operation_id uuid, p_blocked_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'unblock') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  -- Deliberately does not restore the follows the block removed (api.md §3).
  -- Recreating a relationship somebody severed would be surprising, and following
  -- again is one tap.
  delete from blocks
   where blocker_id = auth.uid() and blocked_id = p_blocked_id;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function unblock(uuid, uuid) is
  'Removes the caller''s block. Does not restore the follows the block deleted, per api.md §3: recreating a severed relationship would be surprising, and following again is one tap.';

-- ---------------------------------------------------------------------------
-- 4. Reading the relationship back
--
-- The client needs one answer per person on screen: am I following them, is it
-- pending, do they follow me, have I blocked them. All four are already readable
-- through `follows_read` and `blocks_read`, and the client could assemble them from
-- two selects — but every surface that shows a person would then repeat the
-- assembly, and one of them would get the pending case wrong.
--
-- Definer is not needed and is not used: `follows_read` admits the caller's own rows
-- in both directions, and `blocks_read` admits blocks the caller made. Invoker means
-- this function cannot become an oracle about anybody else's graph, because it can
-- only ever read what the caller could have selected.
-- ---------------------------------------------------------------------------

create or replace function follow_state_with(p_user_ids uuid[])
returns table (
  user_id       uuid,
  following     follow_state,
  followed_by   follow_state,
  blocked       boolean
)
language sql stable security invoker
set search_path = public
as $$
  select u.id,
         (select f.state from follows f
           where f.follower_id = auth.uid() and f.followee_id = u.id),
         (select f.state from follows f
           where f.follower_id = u.id and f.followee_id = auth.uid()),
         exists (select 1 from blocks b
                  where b.blocker_id = auth.uid() and b.blocked_id = u.id)
    from unnest(coalesce(p_user_ids, '{}'::uuid[])) as u(id);
$$;

comment on function follow_state_with(uuid[]) is
  'The caller''s relationship with each of a set of accounts: outgoing follow state, incoming follow state, and whether the caller has blocked them. security invoker, so it can only ever report what follows_read and blocks_read already let the caller select -- it cannot be pointed at somebody else''s graph.';

-- ---------------------------------------------------------------------------
-- 5. Privileges and configuration
-- ---------------------------------------------------------------------------

grant execute on function follow(uuid, uuid)                          to authenticated;
grant execute on function unfollow(uuid, uuid)                        to authenticated;
grant execute on function respond_follow_request(uuid, uuid, boolean) to authenticated;
grant execute on function remove_follower(uuid, uuid)                 to authenticated;
grant execute on function block(uuid, uuid)                           to authenticated;
grant execute on function unblock(uuid, uuid)                         to authenticated;
grant execute on function follow_state_with(uuid[])                   to authenticated;

insert into app_config (key, value)
values ('follow.max_per_hour', '60'::jsonb)
on conflict (key) do nothing;
