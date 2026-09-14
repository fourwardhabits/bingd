-- One arrival, one notice.
--
-- ---------------------------------------------------------------------------
-- What the founder saw
-- ---------------------------------------------------------------------------
--
-- Two inbox rows, minutes apart, both reading "Leslie joined bingd from your invite"
-- (founder, physical QA, 2026-09-14). Production, read-only, the same afternoon:
--
--   17:06:21.769  invite_joined     actor leslie -> saisurajkan, subject profile leslie
--   17:10:52.235  invite_activated  actor leslie -> saisurajkan, subject profile leslie
--
-- `invite_attributions.accepted_at` is 17:06:21.769 and `activated_at` is 17:10:52.235,
-- which is also the `created_at` of Leslie's fifth ranking. No `follow` row was filed:
-- `redeem_invite` has replaced that with `invite_joined` since 20260831000100, and the
-- auto-follow is still silent. Neither row reached `push_outbox`.
--
-- ---------------------------------------------------------------------------
-- Why two rows, and why only now
-- ---------------------------------------------------------------------------
--
-- The two types were designed as two milestones of one person: `invite_joined` at
-- acceptance, `invite_activated` at activation, "which does not fire until the invitee
-- has finished their first five, so an inviter can see both over a fortnight". Both draw
-- the same sentence, deliberately, because each was the first time it became true.
--
-- 20260916000100 moved the activation bar from ten rankings to five, the completed Your
-- First Five. That made activation the last step of onboarding, so it now lands a few
-- minutes after acceptance for every invitee who finishes the flow. The fortnight the
-- design relied on became four and a half minutes, and the second row became the
-- same sentence twice.
--
-- ---------------------------------------------------------------------------
-- The rule
-- ---------------------------------------------------------------------------
--
-- **An inviter is told once that somebody joined from their invite.** `redeem_invite`
-- files `invite_joined` whenever the invitee's own edge was created or upgraded, and
-- that row is the notice. `_maybe_activate_invite` still records the activation (the
-- attribution column, Invite Instigator, the `activated` flag the ranking reports), and
-- files `invite_activated` only when the inviter holds no `invite_joined` from this
-- invitee: the redemptions that told the inviter nothing or something else (an invitee
-- who already followed them, a referral request into a private inviter). Those keep
-- their one "joined from your invite" row, as before.
--
-- **At the writer, not in the client.** The inbox renders what the server filed;
-- hiding one of two rows there would leave a push, a badge count and a second row for
-- every other reader of `notifications` to disagree about.
--
-- **Race and retry.** Activation is once per invitee from the guarded UPDATE below,
-- unchanged. `redeem_invite` commits the attribution and its `invite_joined` in one
-- transaction before any ranking can activate it, and both writers take `_lock_pair`
-- for this pair, so the existence check reads a committed answer. Both types map to the
-- `invites` preference category, so a silenced `invite_joined` means a silenced
-- `invite_activated` too, never a first notice arriving at activation instead.
--
-- **Existing rows are left alone.** Applied migrations do not rewrite anybody's inbox.
--
-- `_maybe_activate_invite` is rebuilt in full from its newest definition
-- (20260916000100), not patched: every line, comment and lock is carried across, and the
-- only change in the body is the `invite_joined` check before the insert.
-- ---------------------------------------------------------------------------

create or replace function _maybe_activate_invite(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_needed  integer;
  v_inviter uuid;
begin
  -- Unattributed, or already activated: nothing to do, and no count to run. The read
  -- is on the primary key, so this is one index probe for the ranking of somebody who
  -- was never invited -- which is most rankings.
  select ia.inviter_id into v_inviter
    from invite_attributions ia
   where ia.invitee_id = p_user
     and ia.accepted_at is not null
     and ia.activated_at is null;

  if not found then
    return false;
  end if;

  -- Five since 20260916000100: the completed Your First Five rather than PRD §28's
  -- ten. The configured row is what every live environment reads; this literal is
  -- what a database missing the row falls back to, and the two must agree.
  select coalesce(
           (select (value)::integer from app_config where key = 'invite.activation_rankings'),
           5)
    into v_needed;

  if (select count(*) from rankings r where r.user_id = p_user) < v_needed then
    return false;
  end if;

  -- The transition, and the only place it can happen. See 20260819000500's header: the
  -- predicate is re-evaluated under the row lock, so a second caller finds nothing to
  -- update rather than a second activation to announce.
  update invite_attributions
     set activated_at = now()
   where invitee_id = p_user
     and activated_at is null;

  if not found then
    return false;
  end if;

  -- Deleted inviter: `inviter_id` is set null by the foreign key (20260813001500) and
  -- the activation is still recorded. There is simply nobody to tell.
  if v_inviter is null then
    return true;
  end if;

  perform _lock_pair(p_user, v_inviter);

  -- Re-read under the lock. A block or a suspension committing between the
  -- attribution read above and this insert is what the lock is here to catch.
  if blocked_between(p_user, v_inviter)
     or not exists (select 1 from profiles p where p.id = v_inviter and p.status = 'active')
  then
    return true;
  end if;

  -- One arrival, one notice (20260920000100). The acceptance already told this inviter
  -- that this person joined from their invite; a second row with the same sentence is the
  -- duplicate the founder saw. The activation above still stands.
  if exists (
    select 1 from notifications n
     where n.recipient_id = v_inviter
       and n.actor_id = p_user
       and n.type = 'invite_joined'
  ) then
    return true;
  end if;

  -- `invite_activated` maps to the `invites` category in
  -- `_apply_notification_preference`, mapped by 20260819000300 ahead of this writer so
  -- the switch is honoured on the day it lands. The before-insert trigger drops the
  -- row if the inviter has turned that category off.
  insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
  values (v_inviter, 'invite_activated', p_user, 'profile', p_user);

  return true;
end;
$$;

comment on function _maybe_activate_invite(uuid) is
  'Sets invite_attributions.activated_at the first time an attributed invitee has ranked invite.activation_rankings titles -- five since 20260916000100, which is the completed Your First Five rather than PRD §28''s ten. Exactly once, from the row lock on a guarded UPDATE rather than from any ordering assumption. Files the inviter''s invite_activated notification only when the inviter holds no invite_joined from this invitee (20260920000100): acceptance already said this person joined from their invite, and since the bar became five the two rows arrived minutes apart with the same sentence. The activation is recorded even when the inviter is gone, suspended or has blocked the invitee, or was already told; the notification is not. Internal: it answers a question about a third party''s attribution.';

revoke execute on function _maybe_activate_invite(uuid) from public, anon, authenticated;
