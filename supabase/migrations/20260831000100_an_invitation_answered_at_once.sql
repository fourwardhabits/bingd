-- ---------------------------------------------------------------------------
-- An invitation, answered at once
-- ---------------------------------------------------------------------------
--
-- `redeem_invite` (20260823000100) already does most of what PRD §17 asks. On a valid
-- acceptance it writes the attribution, sets `invited_by`, files the invitee's
-- `invite_welcome`, creates the one-way follow, and notifies the inviter.
--
-- The inviter's notification is the part that is wrong, and it is wrong in a way that
-- only shows up beside the rest of the funnel.
--
-- **What the inviter sees today.** A plain `follow` row: "Ada Lovelace started
-- following you". Nothing in it says this person came through their invitation. The
-- sentence that *does* say so -- "joined bingd. from your invite" -- belongs to
-- `invite_activated`, which `_maybe_activate_invite` files only once the invitee has
-- ranked ten titles. So the inviter is told the interesting fact days later, or never,
-- and is told a duller fact at the moment it actually happens.
--
-- That is the redemption/activation confusion stated as a defect rather than as a
-- naming problem. **Acceptance and activation are two different events and both are
-- kept**: acceptance is the social fact and is now announced as one; activation stays
-- exactly what it was, the analytics milestone at `invite.activation_rankings`, with
-- its own notification unchanged. This migration moves nothing between them.
--
-- WHAT THIS DOES
--
--   1. `invite_joined`, a new notification type filed to the **inviter** at acceptance
--      **in place of** the generic `follow` row -- not beside it. Two rows naming the
--      same person for the same act is the redundancy PRD §15 exists to prevent, and
--      the invite framing is strictly the more informative of the two.
--   2. Its preference category (`invites`, the one `invite_activated` already uses) and
--      its push eligibility, so the inviter keeps the push the `follow` row gave them.
--   3. A backstop unique index.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- **A private inviter still gets `follow_request`, unchanged.** Their invitee's follow
-- is `pending`, and that row is not an announcement -- it is the *only* Approve and
-- Decline in the app (`app/settings/notifications.tsx` lifts `follow_request` into its
-- own Requests shelf; there is no other requests surface). Replacing it would strand
-- the request, and adding `invite_joined` beside it would be the redundant pair the
-- first clause above refuses. So the private case keeps the actionable row it needs,
-- and the invite framing reaches that inviter at activation as it does today.
--
-- It does not touch the attribution, the token rules, the rate limit, the pair lock,
-- the refusal branches, the follow, the invitee's `invite_welcome`, or what the
-- function returns. `_maybe_activate_invite` is not recreated at all.
-- ---------------------------------------------------------------------------

-- One join announcement per pair, for ever.
--
-- The mechanism is the position of the insert inside `redeem_invite`, exactly as the
-- welcome's is: the line is reachable only when the `invite_attributions` row was
-- genuinely new, and `invitee_id` is that table's primary key, so a given invitee can
-- reach it once in the life of the account. This index is the backstop for a future
-- writer that does not exist yet -- the failure mode of discovering that in production
-- is an inviter told twice that the same person joined.
--
-- Keyed on the pair rather than on the recipient alone, because unlike being invited,
-- *inviting* is a thing an account does many times.
create unique index if not exists notifications_one_join_per_pair
  on notifications (recipient_id, actor_id)
  where type = 'invite_joined';

-- ---------------------------------------------------------------------------
-- Preferences: `invite_joined` is an invite notification
-- ---------------------------------------------------------------------------
--
-- The `invites` category, which `invite_activated` has always used and which the
-- settings screen already draws. The two rows are the two halves of one story and an
-- inviter who has switched invites off has said something about both.
--
-- **This is a category change for the row, and that is the intended reading.** The
-- announcement it replaces was a `follow` and answered to `follows`. An inviter with
-- `invites` off and `follows` on will stop seeing it; one with the reverse will start.
-- That is the setting doing what it says rather than the notification keeping a
-- category it only ever had because of how it happened to be implemented.
--
-- Rebuilt from 20260830000100. Every other line is carried across verbatim.
create or replace function _apply_notification_preference()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_category text;
begin
  if new.type = 'follow_request' then
    return new;
  end if;

  if new.type = 'invite_welcome' then
    return new;
  end if;

  v_category := case new.type
    when 'follow'                then 'follows'
    when 'follow_approved'       then 'follow_accepted'
    when 'comment'               then 'comments'
    -- 20260830000100. A mention is somebody talking to you in a comment, and it
    -- is silenced by the control that says Comments.
    when 'mention'               then 'comments'
    when 'reaction'              then 'reactions'
    when 'watch_tag'             then 'watch_tags'
    when 'recommendation'        then 'recommendations'
    when 'recommendation_ranked' then 'recommendations'
    when 'invite_activated'      then 'invites'
    -- 20260831000100. The other half of the invite story, and the half that arrives
    -- first. Same category, same switch.
    when 'invite_joined'         then 'invites'
    when 'award_earned'          then 'awards'
    when 'goal_completed'        then 'awards'
  end;

  -- An unmapped type is delivered rather than dropped. A notification kind added later
  -- and forgotten here should reach its recipient, not vanish -- the failure mode of the
  -- other default is silent and undetectable.
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
  'switched off. follow_request and invite_welcome are exempt and always delivered. '
  'recommendation_ranked shares the recommendations category (20260827000600); '
  'goal_completed shares awards (20260829000200); mention shares comments '
  '(20260830000100); invite_joined shares invites with invite_activated '
  '(20260831000100). An unmapped type is delivered.';

-- ---------------------------------------------------------------------------
-- Push: `invite_joined` inherits the eligibility of the row it replaces
-- ---------------------------------------------------------------------------
--
-- `follow` is push-eligible and always has been. If `invite_joined` were not, this
-- migration would quietly take a push away from every inviter -- a regression dressed
-- as a copy change, and the kind that is only noticed by the person who stops being
-- told. So it is added here, in the same change as the writer.
--
-- Rebuilt from 20260830000100.
create or replace function _push_eligible(p_type text)
returns boolean
language sql immutable
set search_path = public
as $$
  select p_type = any (array[
    'follow', 'follow_request', 'comment', 'mention', 'reaction', 'watch_tag',
    'recommendation', 'recommendation_ranked', 'invite_activated', 'invite_joined',
    'invite_welcome', 'award_earned', 'goal_completed'
  ]::text[]);
$$;

comment on function _push_eligible(p_type text) is
  'Which notification types may leave the inbox for the lock screen. Thirteen of the fifteen: follow_approved is excluded by PRD §15, and friendship is the reader''s own action (20260827000200). award_earned joined on 20260828, goal_completed on 20260829, mention on 20260830 and invite_joined on 20260831, each with its writer -- invite_joined because it replaces a follow row that was already eligible, and taking that push away would be a silent regression. An unmapped type is not eligible, so a new type has to be added here deliberately.';

-- ---------------------------------------------------------------------------
-- `redeem_invite`, carried across verbatim with one notification changed
-- ---------------------------------------------------------------------------
--
-- The only difference from 20260823000100 is the inviter's notification in the
-- `if found` branch. Everything else -- the operation ledger, the rate limit, the
-- `for share` on the token, the pair lock, every refusal branch, the attribution,
-- `invited_by`, the invitee's welcome, the follow and what the function returns -- is
-- unchanged, and is repeated here in full because `create or replace` replaces the
-- whole body.
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

  -- Unknown, revoked, and minted elsewhere are one answer. See 20260819000500.
  --
  -- `for share`, so a revocation cannot commit between this read and the insert below.
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

  -- PRD §17 clauses 2 and 3. The state decision is `follow`'s own and is copied from
  -- it deliberately: 20260817000200 is the one place in the schema that decides
  -- public-or-private, and it decides from the target's own setting.
  select p.visibility into v_visibility from profiles p where p.id = v_inviter;
  v_state := case when v_visibility = 'private' then 'pending' else 'approved' end;

  insert into follows (follower_id, followee_id, state, approved_at)
  values (v_self, v_inviter, v_state, case when v_state = 'approved' then now() end)
  on conflict (follower_id, followee_id) do nothing;

  if found then
    -- ---------------------------------------------------------------------------
    -- The inviter's row, which is what changed in 20260831000100
    -- ---------------------------------------------------------------------------
    --
    -- **Public inviter: `invite_joined`, in place of the `follow` this used to file.**
    -- The follow row still exists and is unchanged; what moves is only the sentence
    -- the inviter reads. "Ada Lovelace joined bingd. from your invite" is the true and
    -- useful statement about what just happened, and "started following you" was the
    -- incidental half of it. Filing both would be two rows for one act.
    --
    -- The row's Follow back is the inviter's *own* outbound edge and is resolved on
    -- the client from `follow_state_with`, not from anything stored here -- so it says
    -- Follow back, Requested or Following according to what is true when it is drawn,
    -- and keeps saying the right thing after they act on it.
    --
    -- **Private inviter: `follow_request`, exactly as before.** That row carries
    -- Approve and Decline and is the only place in the app they exist. See the header.
    --
    -- Exactly once by position, like the welcome above, with
    -- `notifications_one_join_per_pair` as the backstop.
    --
    -- **It is not deleted when the invitee later unfollows.** `unfollow` clears
    -- `follow` and `follow_request` because those rows announce an edge that has
    -- stopped existing. `invite_joined` announces that somebody joined, which stays
    -- true -- the same reading `invite_activated` has always had. A block still removes
    -- it, in both directions and whatever its type.
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
    values (v_inviter,
            case when v_state = 'approved' then 'invite_joined' else 'follow_request' end,
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

comment on function redeem_invite(uuid, text) is
  'Redeems an invite token for the caller: attribution (once per account, for ever), invited_by, the invitee''s invite_welcome row, and PRD §17''s one-way follow -- approved for a public inviter, a request for a private one. The inviter is told once: invite_joined when the follow was approved (20260831000100), follow_request when it is pending, because that row is the only Approve and Decline in the app. Unknown, revoked and foreign-environment tokens are one refusal. Idempotent through the operation ledger; a replay reports whether an attribution exists without naming the inviter.';
