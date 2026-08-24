-- ---------------------------------------------------------------------------
-- An invitation says hello back
-- ---------------------------------------------------------------------------
--
-- A person who joins through a Bingd invitation is already followed *to* their
-- inviter by `redeem_invite` — PRD §17 clause 2, and `20260819000500` implements it
-- after independent review 26 rejected leaving it out. The inviter is notified. The
-- invitee is told nothing at all.
--
-- So the one person in the exchange who has never seen the app before arrives with a
-- follow they did not watch happen, an inbox with nothing in it, and no name anywhere
-- on screen belonging to the person who brought them. A beta tester reported exactly
-- that: a Feed that begins empty even though somebody specifically invited them.
--
-- This adds the missing half. One row, for the invitee, naming the inviter.
--
-- **It is an inbox row and not a push.** Push has never been built (AD-10), and
-- nothing here changes that.
--
-- WHAT THIS DOES NOT DO
--
-- It does not create, remove or alter a follow. The follow that already happens is
-- `20260819000500`'s and is untouched — this migration only recreates `redeem_invite`
-- to add one insert, and every other line of that function is carried across verbatim.
-- It does not change token validity, the attribution row, the rate limit, the pair
-- lock, the refusal branches, or what the function returns.
-- ---------------------------------------------------------------------------

-- One welcome per account, for ever.
--
-- The mechanism is the position of the insert inside `redeem_invite`, which is only
-- reachable when the attribution row was genuinely new. This index is the backstop:
-- `invite_attributions.invitee_id` is a primary key, so a second welcome could only
-- come from a future writer that has not been written yet, and the failure mode of
-- discovering that in production is a returning user greeted twice.
--
-- Keyed on the recipient alone, deliberately. Not on the actor: being invited is a
-- thing that happens to an account once, whoever did it.
create unique index if not exists notifications_one_welcome_per_account
  on notifications (recipient_id)
  where type = 'invite_welcome';

-- ---------------------------------------------------------------------------
-- Preferences: delivered always, like a follow request
-- ---------------------------------------------------------------------------
--
-- `invite_welcome` is deliberately given no category, and is exempted explicitly
-- rather than left to fall through the unmapped-type default.
--
-- The fall-through would deliver it too, and the result would be identical today —
-- but "unmapped types are delivered" exists so that a kind somebody forgot to map
-- still reaches its recipient, and relying on it here would make this look like the
-- oversight it is meant to catch. `recommendation` was exactly that once.
--
-- The reason it has no category is the same reason `follow_request` has none: it
-- fires once, at the moment an account is created, and the person it fires for has
-- never opened the notification settings screen and has nothing there to have chosen.
-- A preference that could silence it could only ever be silenced by accident, and the
-- row it would drop is the only thing in the app naming the person who brought them.
create or replace function _apply_notification_preference()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_category text;
begin
  -- A request is always delivered: an account that could silence it would receive
  -- requests it can never see and never answer.
  if new.type = 'follow_request' then
    return new;
  end if;

  -- A welcome is always delivered. See the header above.
  if new.type = 'invite_welcome' then
    return new;
  end if;

  v_category := case new.type
    when 'follow'           then 'follows'
    when 'follow_approved'  then 'follow_accepted'
    when 'comment'          then 'comments'
    when 'reaction'         then 'reactions'
    when 'watch_tag'        then 'watch_tags'
    when 'recommendation'   then 'recommendations'
    when 'invite_activated' then 'invites'
    when 'award_earned'     then 'awards'
  end;

  -- An unmapped type is delivered rather than dropped. A notification kind added
  -- later and forgotten here should reach its recipient, not vanish -- the failure
  -- mode of the other default is silent and undetectable.
  if v_category is null then
    return new;
  end if;

  if _notifies(new.recipient_id, v_category) then
    return new;
  end if;

  return null;
end;
$fn$;

comment on function _apply_notification_preference() is
  'Before-insert gate on notifications. Drops a row whose category the recipient has '
  'switched off. follow_request and invite_welcome are exempt and always delivered.';

-- ---------------------------------------------------------------------------
-- `redeem_invite`, carried across verbatim with one insert added
-- ---------------------------------------------------------------------------
--
-- The only difference from `20260819000500` is the block marked "The invitee's own
-- welcome". Everything else -- the operation ledger, the rate limit, the `for share`
-- on the token, the pair lock, every refusal branch, the attribution, `invited_by`,
-- the follow and the inviter's own notification -- is unchanged, and is repeated here
-- in full because `create or replace` replaces the whole body.
create or replace function redeem_invite(p_operation_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_self       uuid := auth.uid();
  v_token_id   uuid;
  v_inviter    uuid;
  v_env        text;
  v_prior      uuid;
  v_visibility profile_visibility;
  v_state      follow_state;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'redeem_invite') then
    -- A replay answers with what the original produced, so a client whose reply was
    -- lost can retry and be told what actually happened rather than a status it has
    -- nothing to do with. The inviter is not named: on the refusal branches the
    -- original never established one.
    select ia.inviter_id into v_prior
      from invite_attributions ia where ia.invitee_id = v_self;

    return jsonb_build_object('status', 'already_applied', 'attributed', v_prior is not null);
  end if;

  perform _assert_operation_rate('redeem_invite', 'invite.max_redeem_attempts_per_day', 10);

  select coalesce((select value #>> '{}' from app_config where key = 'env.name'), 'nonprod')
    into v_env;

  -- Unknown, revoked, and minted elsewhere are one answer. See the header.
  --
  -- `for share`, so a revocation cannot commit between this read and the insert below.
  -- See "The token is locked, not merely read" above.
  select t.id, t.owner_id into v_token_id, v_inviter
    from invite_tokens t
   where t.token = p_token
     and t.revoked_at is null
     and t.env = v_env
     for share;

  if v_token_id is null then
    return jsonb_build_object('status', 'refused', 'reason', 'invalid');
  end if;

  if v_inviter = v_self then
    -- `no_self_invite` would catch this as a 23514, which is a constraint failure
    -- rather than an answer. Opening your own link is the ordinary way somebody
    -- checks what they just shared.
    return jsonb_build_object('status', 'refused', 'reason', 'self');
  end if;

  perform _lock_pair(v_self, v_inviter);

  -- `blocked_between` rather than a subquery on `blocks`: `blocks_read` hides a block
  -- from the person it was made against, so a direct read would return false for
  -- exactly the caller who must be refused. Same reasoning as `_assert_reachable`.
  if blocked_between(v_self, v_inviter) then
    return jsonb_build_object('status', 'refused', 'reason', 'blocked');
  end if;

  -- A suspended inviter gains no attribution while suspended, and the invitee is not
  -- told which of the two it was: `unavailable` covers a deleted profile as well, in
  -- the window before the cascade lands.
  if not exists (select 1 from profiles p where p.id = v_inviter and p.status = 'active') then
    return jsonb_build_object('status', 'refused', 'reason', 'unavailable');
  end if;

  insert into invite_attributions (invitee_id, inviter_id, token_id, accepted_at)
  values (v_self, v_inviter, v_token_id, now())
  on conflict (invitee_id) do nothing;

  if not found then
    -- Already invited by somebody -- possibly by this same inviter, on another device
    -- or in a lost reply. Either way the row does not move. The existing inviter is
    -- deliberately not named: it may be an account this caller cannot see.
    return jsonb_build_object('status', 'refused', 'reason', 'already_attributed');
  end if;

  -- Growth provenance, which PRD §17 requires on every account from day one and which
  -- is impossible to reconstruct later. Guarded on null so it records the first
  -- attribution and is never rewritten -- the same "for good" rule the primary key
  -- gives the row above.
  update profiles
     set invited_by = v_inviter
   where id = v_self and invited_by is null;

  -- ---------------------------------------------------------------------------
  -- PRD §17's acceptance semantics, clauses 2, 3 and 4
  -- ---------------------------------------------------------------------------
  --
  -- **The first version of this function wrote the attribution and stopped there**,
  -- and recorded the omission in the PRD as a deliberate narrowing. Independent
  -- review 26 rejected that, correctly: a specification is not amended by a note
  -- saying it was not implemented, and the reasons offered -- a smaller concurrency
  -- surface, a stricter reading of the privacy clauses -- were arguments for an
  -- implementation convenience, not authorisation to change what acceptance means.
  --
  -- So acceptance does what §17 says it does:
  --
  --   2. it creates a one-way follow from recipient to inviter;
  --   3. a **private** inviter receives a follow *request* instead, subject to normal
  --      approval -- so the private setting is honoured rather than bypassed;
  --   4. the inviter is notified, and the inbox row is what prompts them to follow
  --      back. They are never auto-followed, which clause 4 also requires and which
  --      no line here does.
  --
  -- Clauses 1, 5, 6 and 7 were already met: acceptance is an explicit tap on
  -- `app/i/[token].tsx`, the recipient is unnamed to the inviter until this commits,
  -- a block voids the invitation above, and the attribution is written independently
  -- of the follow.
  --
  -- **The state decision is `follow`'s own and is copied from it deliberately.**
  -- `20260817000200` is the one place in the schema that decides public-or-private,
  -- and it decides from the target's own setting rather than from anything the caller
  -- sends. This reproduces that rule rather than inventing a second one.
  --
  -- **Calling `follow()` instead was considered and is wrong.** It claims its own
  -- operation id and spends its own hourly slot, so a redemption would consume a
  -- follow the person had not made, and a replay of *this* operation would be a
  -- second genuine follow attempt. The rows are written here, under the pair lock
  -- this transaction already holds, which is also the lock `follow` and `block` take.
  --
  -- `on conflict do nothing`, because an invitee who already follows their inviter is
  -- ordinary -- they were sent the link by somebody they know -- and re-adding must
  -- never downgrade an approved follow to pending. Same rule, same reason, as
  -- `follow`'s "never downgraded" branch. The notification is filed only when a row
  -- was actually created, so an existing follow does not produce a second notice.
  -- ---------------------------------------------------------------------------
  -- The invitee's own welcome, which is new in this migration
  -- ---------------------------------------------------------------------------
  --
  -- **Exactly-once by position rather than by guard.** Every path that reaches this
  -- line has just created the `invite_attributions` row: a replay returns
  -- `already_applied` at the ledger, a second inviter returns `already_attributed`
  -- at the `on conflict do nothing` above, and the primary key on `invitee_id` means
  -- there is never a third caller. The partial unique index added alongside this is
  -- a backstop for a future path, not the mechanism.
  --
  -- **Filed here rather than on the client**, because the client cannot be trusted
  -- with a once-per-account write. A redemption reply is lost on a bad connection,
  -- the app is closed mid-OAuth, the tree remounts — and `useRedeemPendingInvite`
  -- retries all three, which is correct for an idempotent RPC and would be a second
  -- notification for anything written in a `.then()`.
  --
  -- The actor is the inviter, so the row draws their avatar and name and routes to
  -- their profile through the resolver every other actor-bearing kind uses.
  -- Blocks and suspension are already handled downstream: `my_notifications` filters
  -- every actor through `can_discover_profile`, and a block deletes the rows in both
  -- directions.
  insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
  values (v_self, 'invite_welcome', v_inviter, 'profile', v_inviter);

  select p.visibility into v_visibility from profiles p where p.id = v_inviter;
  v_state := case when v_visibility = 'private' then 'pending' else 'approved' end;

  insert into follows (follower_id, followee_id, state, approved_at)
  values (v_self, v_inviter, v_state, case when v_state = 'approved' then now() end)
  on conflict (follower_id, followee_id) do nothing;

  if found then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
    values (v_inviter,
            case when v_state = 'approved' then 'follow' else 'follow_request' end,
            v_self, 'profile', v_self);
  else
    -- Already following, in whichever state. Report that state rather than the one
    -- this call would have created, so the client cannot tell somebody their request
    -- is pending when they were approved months ago.
    select f.state into v_state
      from follows f where f.follower_id = v_self and f.followee_id = v_inviter;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'inviter_id', v_inviter,
    'inviter_username', (select p.username::text from profiles p where p.id = v_inviter),
    'follow_state', v_state
  );
end;
$$;

