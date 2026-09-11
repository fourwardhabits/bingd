-- A bar the First Five already clears.
--
-- ---------------------------------------------------------------------------
-- What this changes, and it is one number
-- ---------------------------------------------------------------------------
--
-- An invitation activates when the invitee has ranked `invite.activation_rankings`
-- titles. That number has been **ten** since `20260819000500`, taken from PRD §28's
-- definition of product activation, and it was the right number on the day it was
-- written: onboarding did not exist yet, ten ranked titles was the only observable
-- evidence that somebody had actually used the app, and one ranked title is a tap.
--
-- Onboarding now exists. The ten-step flow shipped in `e5e71ce` ends with **Your First
-- Five** -- a pick-and-rank loop, five times, after which the account has a list, a
-- score and somebody to follow. Five rankings is no longer "one tap plus four"; it is
-- the completed onboarding, and it is the moment the product itself declares the new
-- person set up.
--
-- So the invitation bar sat five titles *past* the point the app stops asking. An
-- invitee who did exactly what the app told them to do finished onboarding and their
-- inviter was told nothing, because the funnel's own definition of "this person
-- arrived" had been left behind by the flow that makes them arrive. Production on
-- 2026-09-10 held three attributions and **zero** activations, against invitees with
-- five, zero and five rankings -- two of the three had finished onboarding and neither
-- counted.
--
-- **The number becomes five.** Founder decision, 2026-09-11.
--
-- ---------------------------------------------------------------------------
-- Why this is not a farming hole
-- ---------------------------------------------------------------------------
--
-- The anti-farming property was never carried by the ranking count. It is carried by
-- Invite Instigator's tiers -- 3, 15 and 50 **separate invitees**, each a distinct
-- account with a distinct attribution row, and `invite_attributions` is keyed by
-- `invitee_id` so one person is counted once for ever. Lowering the per-invitee bar
-- from ten taps to five changes the cost of a fake invitee from ten taps to five,
-- against a tier that needs three fake *people*, each with an account, a profile and
-- a redemption. The tiers are unchanged and are not touched here.
--
-- What the bar does buy is that a redemption alone never counts, and that is
-- unchanged: `activated_at` is still a separate column from `accepted_at`, still
-- written only by `_maybe_activate_invite`, and the Invite Instigator query is still
-- `activated_at is not null`.
--
-- ---------------------------------------------------------------------------
-- Both places the number lives, in one file
-- ---------------------------------------------------------------------------
--
-- The number has two homes and they must not be allowed to disagree:
--
--   1. the `app_config` row `invite.activation_rankings`, which is what every live
--      environment actually reads; and
--   2. the `coalesce(..., 10)` written into `_maybe_activate_invite` itself, which is
--      what a database with no such row would use.
--
-- Changing only (1) leaves a function whose source says ten and whose behaviour is
-- five -- the drift `config-defaults.test.mjs` exists because of. Changing only (2)
-- changes nothing anywhere the row exists, which is everywhere. So this file changes
-- both, and `20260819000500` is left exactly as it ran: an applied migration is
-- history, and a correction is the next migration rather than an edit to the last.
--
-- ---------------------------------------------------------------------------
-- What this file deliberately does NOT do
-- ---------------------------------------------------------------------------
--
-- **It does not backfill.** Applying this activates nobody. `_maybe_activate_invite`
-- is only ever called from `_rank_finalize`, so an existing invitee already past five
-- and sitting at `activated_at is null` stays there until their next ranking, which
-- may be never. That is a real gap with a real answer --
-- `scripts/backfill-invite-activation.mjs` -- but the answer writes rows on
-- somebody else's behalf, fires the award trigger and can file backdated
-- notifications, and none of that belongs in a schema migration CI runs unattended
-- against every environment. The backfill is an operator action, taken once,
-- deliberately, with the founder's eyes on it.
--
-- **It does not touch the award.** `award_on_invite_activation` (20260828000100) fires
-- on the `activated_at` transition and nothing about that transition changed. Tiers,
-- `value_at_unlock` and `announced` are untouched.
--
-- **It does not touch redemption.** Both edges of the follow, the `invite_joined` row
-- and the Feed story are written by `redeem_invite` (newest definition
-- `20260912000200`) at redemption time, and none of them reads this number.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The configured value
--
-- `do update` rather than `do nothing`, which is the difference between this file and
-- the insert in `20260819000500`: that one seeded a key that did not exist, this one
-- changes a key that does. Idempotent -- a second apply writes the same five over the
-- same five -- and it repairs an environment where the row had been deleted.
-- ---------------------------------------------------------------------------

insert into app_config (key, value, updated_at)
values ('invite.activation_rankings', '5'::jsonb, now())
on conflict (key) do update
  set value = excluded.value, updated_at = now();

-- ---------------------------------------------------------------------------
-- 2. The written fallback
--
-- Rebuilt in full from its definition in `20260819000500`, not patched. Every line,
-- comment and lock below is carried across; the only difference in the body is
-- `coalesce(..., 10)` becoming `coalesce(..., 5)`. `20260817001300` records why a
-- `create or replace` is assembled from the current definition rather than from an
-- ancestor: `_assert_operation_rate` silently lost its advisory lock that way, and it
-- was invisible in the diff.
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
  'Sets invite_attributions.activated_at the first time an attributed invitee has ranked invite.activation_rankings titles -- five since 20260916000100, which is the completed Your First Five rather than PRD §28''s ten -- and files the inviter''s one invite_activated notification. Exactly once, from the row lock on a guarded UPDATE rather than from any ordering assumption. The activation is recorded even when the inviter is gone, suspended or has blocked the invitee; the notification is not. Internal: it answers a question about a third party''s attribution.';

revoke execute on function _maybe_activate_invite(uuid) from public, anon, authenticated;
