-- An invitation you actually accepted.
-- Security audit 2026-11-01, finding B-1. Supersedes part of the founder decision recorded
-- in `20260912000200`, and the supersession is stated below rather than folded in.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- `redeem_invite` approves the inviter -> invitee edge, whatever the invitee's visibility
-- says, on the reasoning that "the invitee is the caller and it is their own account's
-- access they are granting". That holds only if the caller decided to call. They did not
-- have to: `app/i/[token].tsx` stored the token the moment the screen mounted, and
-- `useRedeemPendingInvite` redeemed it from the layout when the person left the screen or
-- on the next launch, with no tap and nothing on screen. So:
--
--   attacker sends their personal link -> a private account opens it -> leaves ->
--   the attacker is an approved follower of the private account
--
-- `20260912000200` accepted a leaked link into a private *inviter*, because both people
-- had deliberately acted. Here the invitee has not acted at all.
--
-- ===========================================================================
-- THE RULE NOW
--
-- **An edge is only ever created by a call that means "I accept".**
--
-- `accept_invite` is that call. The app sends it from the Accept button and from nowhere
-- else, and everything `20260912000200` decided about a personal invitation still applies
-- to it, because a person who read the screen and pressed Accept is exactly the bilateral
-- consent that decision describes.
--
-- `redeem_invite` keeps its name and signature for installed builds, which send it for an
-- Accept tap and for the silent background redemption alike. **The server cannot tell those
-- two apart, so it must treat every one as the silent one, and it now does nothing.** That
-- is what makes an installed client safe before it receives any update.
--
-- Nothing includes attribution. An attribution is written once and never moves, so writing
-- one on a call nobody can show was a decision would spend the only one an account gets,
-- and block the invitation it actually wanted. An early version of this file kept it for
-- accounts under a day old, and independent review was right to reject that: an account's
-- age does not say how it arrived.
--
-- It raises rather than answers, and the code is chosen for what an installed build does
-- with it. `22023` is on that build's list of certain refusals, so it keeps the token,
-- counts nothing, and puts this message in front of the person: somebody who opens a link
-- in the gap before the update is told what to do, and is shown the invitation after it.
-- An answer of `unavailable` looked equivalent and is not. That build gives up on the fifth,
-- so a slow update would have lost the invitation.
--
-- **The account is part of the call.** `p_accepting_user` says who pressed Accept, and a
-- call from any other session is refused before anything is spent. The app records a press
-- against the account that made it, but a request goes out under whichever session is
-- current when it runs, so a replay queued across an account switch on a shared phone would
-- otherwise accept for somebody who only signed in. Independent review found that too.
--
-- ===========================================================================
-- NAMING THE INVITER
--
-- Consent to "whoever sent this" is not consent. `invite_preview` tells a signed-in caller
-- whose link they are holding, which reverses a choice recorded on the invitation screen
-- ("the inviter is not named before acceptance"). That choice treated the token as a key
-- onto an account the holder has no relationship with. It is 128 random bits that the
-- inviter handed out so that the holder would know who they were, and the same handle has
-- always come back from `redeem_invite` one tap later. A signed-in account can already find
-- any handle through `search_users`.
--
-- Signed-in only, and it answers `unavailable` for a block and for a suspended or missing
-- inviter alike, for the reason `redeem.ts` gives: a separate answer for a block is a way
-- to detect one.
-- ===========================================================================


create or replace function accept_invite(
  p_operation_id   uuid,
  p_token          text,
  p_accepting_user uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_self       uuid := auth.uid();
  v_token_id   uuid;
  v_inviter    uuid;
  v_kind       text;
  v_env        text;
  v_prior      uuid;
  v_visibility profile_visibility;
  v_state      follow_state;
  v_notify     text;
  v_before_out follow_state;
  v_before_in  follow_state;
  v_mutual     boolean := false;
begin
  perform assert_can_write();

  -- Before the claim, so a call refused here spends nothing. See the header.
  if p_accepting_user is distinct from v_self then
    return jsonb_build_object('status', 'refused', 'reason', 'wrong_account');
  end if;

  if not _claim_operation(p_operation_id, 'accept_invite') then
    -- A replay answers with what the original produced, so a client whose reply was
    -- lost can retry and be told what actually happened rather than a status it has
    -- nothing to do with. The inviter is not named: on the refusal branches the
    -- original never established one.
    select ia.inviter_id into v_prior
      from invite_attributions ia where ia.invitee_id = v_self;

    return jsonb_build_object('status', 'already_applied', 'attributed', v_prior is not null);
  end if;

  perform _assert_operation_rate('accept_invite', 'invite.max_redeem_attempts_per_day', 10);

  select coalesce((select value #>> '{}' from app_config where key = 'env.name'), 'nonprod')
    into v_env;

  -- Unknown, revoked, and minted elsewhere are one answer. See 20260819000500.
  --
  -- `for share`, so a revocation cannot commit between this read and the insert below.
  -- `kind` comes along because it is what decides the reverse edge (20260912000100 §2).
  select t.id, t.owner_id, t.kind into v_token_id, v_inviter, v_kind
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
  -- exactly the caller who must be refused.
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
  -- attribution and is never rewritten.
  update profiles
     set invited_by = v_inviter
   where id = v_self and invited_by is null;

  -- The invitee's own welcome (20260823000100). Exactly once by position: every path
  -- that reaches this line has just created the `invite_attributions` row.
  --
  -- The actor is the inviter, so the row draws their avatar and name and routes to
  -- their profile. Blocks and suspension are handled downstream: `my_notifications`
  -- filters every actor through `can_discover_profile`, and `block` deletes the rows
  -- in both directions whatever their type.
  insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
  values (v_self, 'invite_welcome', v_inviter, 'profile', v_inviter);

  if v_kind = 'personal' then
    -- ---------------------------------------------------------------------------
    -- (a) and (b). Two edges, both approved, neither downgraded
    -- ---------------------------------------------------------------------------
    v_state := 'approved';

    -- What the pair looked like before this call, read under the pair lock taken above so
    -- nothing can move between here and the inserts. Read rather than inferred from
    -- `found`, which cannot tell an edge that was created from one that was upgraded --
    -- and the difference decides which row the inviter is sent.
    select f.state into v_before_out
      from follows f where f.follower_id = v_self and f.followee_id = v_inviter;
    select f.state into v_before_in
      from follows f where f.follower_id = v_inviter and f.followee_id = v_self;

    -- The invitee's own edge into the inviter. Approved whatever the *inviter's*
    -- visibility says: minting a personal link and handing it to this person is the
    -- inviter acting, which is the founder decision 20260912000200 carries.
    insert into follows (follower_id, followee_id, state, approved_at)
    values (v_self, v_inviter, 'approved', now())
    on conflict (follower_id, followee_id) do update
       set state       = 'approved',
           approved_at = coalesce(follows.approved_at, now())
     where follows.state = 'pending';

    -- The inviter's edge into the invitee. Approved whatever the *invitee's* visibility
    -- says, because this call means the invitee pressed Accept, on a screen that named the
    -- inviter and said what it grants.
    insert into follows (follower_id, followee_id, state, approved_at)
    values (v_inviter, v_self, 'approved', now())
    on conflict (follower_id, followee_id) do update
       set state       = 'approved',
           approved_at = coalesce(follows.approved_at, now())
     where follows.state = 'pending';

    -- (c). Whichever of the two requests existed has just been answered, so it must stop
    -- asking. Both directions, because either could have been open before the redemption.
    delete from notifications
     where type = 'follow_request'
       and ( (recipient_id = v_inviter and actor_id = v_self)
          or (recipient_id = v_self    and actor_id = v_inviter) );

    -- (d). What each approval releases, in the direction that approval runs.
    -- `_release_recommendations(sender, recipient)`: the followee is the sender, because
    -- approving a follower is deciding to let them see what was being held for them.
    perform _release_recommendations(v_inviter, v_self);
    perform _release_recommendations(v_self, v_inviter);

    if v_before_out is null or v_before_out = 'pending' then
      -- The join row, on the same condition `20260831000100` has always used: the
      -- invitee's own edge was created or upgraded by this call. An invitee who already
      -- followed their inviter told them so at the time, with `follow`, and a join row
      -- beside it would be the second notice about one relationship that PRD §15 forbids.
      v_notify := 'invite_joined';
    elsif v_before_in = 'pending' then
      -- The narrow case the line above cannot reach, and it must not be silent: the
      -- invitee already followed the inviter, and the *inviter* had an open request into
      -- a private invitee which this redemption just approved. `respond_follow_request`
      -- tells a requester their request landed, and with no `invite_joined` to carry the
      -- news there is nothing redundant about saying it here. Same shape as that
      -- function's own row: the approver is the actor, and their profile is the subject.
      v_notify := 'follow_approved';
    end if;
  else
    -- ---------------------------------------------------------------------------
    -- A referral token, and 20260912000100's semantics are carried across unchanged
    -- ---------------------------------------------------------------------------
    --
    -- PRD §17 clauses 2 and 3. The state decision is `follow`'s own and is copied from
    -- it deliberately: 20260817000200 is the one place in the schema that decides
    -- public-or-private, and it decides from the target's own setting. There is no
    -- reverse edge, no request is cleared, nothing is released and no story is posted --
    -- a public campaign link must be able to redeem without connecting two strangers.
    select p.visibility into v_visibility from profiles p where p.id = v_inviter;
    v_state := case when v_visibility = 'private' then 'pending' else 'approved' end;

    insert into follows (follower_id, followee_id, state, approved_at)
    values (v_self, v_inviter, v_state, case when v_state = 'approved' then now() end)
    on conflict (follower_id, followee_id) do nothing;

    if found then
      v_notify := case when v_state = 'approved' then 'invite_joined' else 'follow_request' end;
    else
      -- Already following, in whichever state. Report that state rather than the one
      -- this call would have created, so the client cannot tell somebody their request
      -- is pending when they were approved months ago.
      select f.state into v_state
        from follows f where f.follower_id = v_self and f.followee_id = v_inviter;
    end if;
  end if;

  -- ---------------------------------------------------------------------------
  -- The inviter's row (20260831000100)
  -- ---------------------------------------------------------------------------
  --
  -- **`invite_joined`, in place of the `follow` this used to file.** "Ada Lovelace joined
  -- bingd. from your invite" is the true and useful statement about what just happened,
  -- and "started following you" was the incidental half of it. Filing both would be two
  -- rows for one act, and so would filing `follow_approved` beside it.
  --
  -- **`follow_request` survives on the referral path only**, where an edge into a private
  -- inviter is still a request. That row carries Approve and Decline and is the only place
  -- in the app they exist.
  --
  -- **It is not deleted when the invitee later unfollows.** `unfollow` clears `follow` and
  -- `follow_request` because those rows announce an edge that has stopped existing.
  -- `invite_joined` announces that somebody joined, which stays true. A block still removes
  -- it, in both directions and whatever its type.
  if v_notify is not null then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
    values (v_inviter, v_notify, v_self, 'profile', v_self);
  end if;

  if v_kind = 'personal' then
    -- One story for one relationship (§A14), authored by the inviter because that is the
    -- direction with an audience. Posted unconditionally rather than only when the insert
    -- was new: an inviter who already followed this person has still just had them join,
    -- and `_post_follow_activity` is idempotent per (event, person) by primary key.
    perform _post_follow_activity(v_inviter, v_self);

    -- Whether the pair came out of this mutually connected. Read back rather than assumed
    -- true: it is the one assertion in this function that would notice if either insert
    -- above stopped doing what it says.
    v_mutual := exists (
      select 1 from follows f
       where f.follower_id = v_self and f.followee_id = v_inviter and f.state = 'approved'
    ) and exists (
      select 1 from follows f
       where f.follower_id = v_inviter and f.followee_id = v_self and f.state = 'approved'
    );
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'inviter_id', v_inviter,
    'inviter_username', (select p.username::text from profiles p where p.id = v_inviter),
    'follow_state', v_state,
    -- New in 20260912000100. An older bundle ignores an unknown key, which is what makes
    -- this additive for the public build.
    'connected', v_mutual
  );
end;
$$;

comment on function accept_invite(uuid, text, uuid) is
  'The caller pressed Accept on an invitation. The only client entry that can connect two accounts. Refused unless p_accepting_user is the caller, so a request that outlived an account switch cannot accept for whoever is signed in now. Writes the attribution (once per account, for ever), invited_by and the invitee''s invite_welcome. A valid personal token ends with BOTH directed edges approved, in all four combinations of the two accounts'' visibility (20260912000200): minting a personal link is the inviter acting, and this call is the invitee acting. A pending edge in either direction is upgraded, the follow_request it answered is cleared both ways, and held recommendations are released both ways. Each party is told exactly once: the invitee by invite_welcome, and the inviter by invite_joined when their invitee''s own edge moved, or by follow_approved when the invitee already followed them and this approved the inviter''s own pending request. One Feed story is posted with the inviter as actor (§A14). Answers with connected: whether both edges came out approved, read back. A referral token keeps 20260912000100''s semantics: a one-way follow, or a request into a private inviter. Unknown, revoked and foreign-environment tokens are one refusal, as are self, a block in either direction, and a suspended or missing inviter. Idempotent through the operation ledger. Call it from an explicit tap and nowhere else: the server takes the call as the consent.';

revoke execute on function accept_invite(uuid, text, uuid) from public, anon, authenticated;
grant  execute on function accept_invite(uuid, text, uuid) to authenticated;


create or replace function redeem_invite(p_operation_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();
  raise exception 'Update bingd to accept this invitation.' using errcode = '22023';
end;
$$;

comment on function redeem_invite(uuid, text) is
  'The call installed builds make, for an Accept tap and for a background redemption with no tap alike. Indistinguishable, so it does nothing (20261024000100): no edge, no attribution, no notification. Raises 22023 with a message those builds show as it stands, and keep the token through without counting it, so the invitation is shown after they update. Remove once no supported build sends it.';


create or replace function invite_preview(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_self    uuid := auth.uid();
  v_env     text;
  v_inviter uuid;
  v_kind    text;
  v_person  record;
begin
  select coalesce((select value #>> '{}' from app_config where key = 'env.name'), 'nonprod')
    into v_env;

  select t.owner_id, t.kind into v_inviter, v_kind
    from invite_tokens t
   where t.token = p_token
     and t.revoked_at is null
     and t.env = v_env;

  if v_inviter is null then
    return jsonb_build_object('status', 'refused', 'reason', 'invalid');
  end if;

  if v_inviter = v_self then
    return jsonb_build_object('status', 'refused', 'reason', 'self');
  end if;

  -- One answer for a block and for an account that is gone or suspended. See the header.
  select p.username::text as username, p.display_name
    into v_person
    from profiles p
   where p.id = v_inviter
     and p.status = 'active'
     and not blocked_between(v_self, v_inviter);

  if v_person.username is null then
    return jsonb_build_object('status', 'refused', 'reason', 'unavailable');
  end if;

  if exists (select 1 from invite_attributions ia where ia.invitee_id = v_self) then
    return jsonb_build_object('status', 'refused', 'reason', 'already_attributed');
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'kind', v_kind,
    'inviter_username', v_person.username,
    'inviter_display_name', v_person.display_name
  );
end;
$$;

comment on function invite_preview(text) is
  'Whose invitation the caller is holding, so the Accept screen can name them before anything is granted. Writes nothing. Signed-in only. Answers what accept_invite would answer about the token, with one reason for a block and for a suspended or missing inviter, and never names an account the caller already attributed to.';

revoke execute on function invite_preview(text) from public, anon, authenticated;
grant  execute on function invite_preview(text) to authenticated;
