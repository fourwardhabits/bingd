-- The one-off backfill that follows `20260916000100`.
--
-- NOT a migration, and the directory is different on purpose: nothing replays this, CI
-- never runs it, and a fresh environment must not. It is a statement an operator runs
-- once, against a database that already had invitees when the bar moved from ten to five.
--
-- `scripts/backfill-invite-activation.mjs` reads this file rather than carrying its own
-- copy, and `supabase/tests/invite-activation-backfill.test.mjs` runs this file rather
-- than a paraphrase of it. Two spellings of one write that drift apart are worse than
-- either alone.
--
-- ---------------------------------------------------------------------------
-- What it stamps, and why not `now()`
-- ---------------------------------------------------------------------------
--
-- `greatest(the bar-th ranking, accepted_at)`, and both halves are load-bearing.
--
-- `activated_at` is a historical fact — *when did this person arrive* — and it is the
-- left-hand side of every invite-to-activation latency figure anybody will compute.
-- `now()` would say the whole backlog arrived the night an operator ran a script.
--
-- The ranking alone is wrong too, and in production it is wrong for **every** row rather
-- than in some edge case: onboarding ranks five titles and *then* the invitation is
-- redeemed, so the fifth ranking precedes `accepted_at` by a minute or so. Stamping it
-- would record an invitation activating before it was accepted. `20260819000500` already
-- names this shape — it is why the count is `>=` and not `=`.
--
-- ---------------------------------------------------------------------------
-- Idempotent, and re-runnable without thought
-- ---------------------------------------------------------------------------
--
-- The guard is `and ia.activated_at is null` on the UPDATE itself, so a second run matches
-- nothing, fires no trigger and writes nothing. Under READ COMMITTED a concurrent run
-- blocks on the row lock and re-evaluates the predicate on release — the same argument
-- `_maybe_activate_invite` makes for itself.
--
-- The bar is read from `app_config` rather than written here, so running this *before*
-- `20260916000100` is applied uses the old ten and finds nobody: a no-op, not a wrong
-- answer.
--
-- ---------------------------------------------------------------------------
-- What it sets off, deliberately, and what it does not
-- ---------------------------------------------------------------------------
--
-- `award_on_invite_activation` (`20260828000100`) fires on this UPDATE exactly as it does
-- on the live path — it is `after update of activated_at ... when (new.activated_at is not
-- null and old.activated_at is null)` and this is that. Any Invite Instigator tier the
-- inviter now reaches is recorded on `award_unlocks` with `value_at_unlock` frozen at the
-- crossing count, **announced immediately** (a public feed post, because the track is
-- social, and a congratulations notification), and `announced` set to true. It does not
-- stay false; false is what `20260828000100`'s own rollout inserted directly, bypassing
-- the announcer.
--
-- No `invite_activated` row is filed, because that lives inside `_maybe_activate_invite`
-- and this does not call it. That is the point rather than an oversight: the row is a
-- message between two people about something that just happened, it is push-eligible, and
-- the thing it would announce happened days ago.
--
-- Run the reporting half first — `node scripts/backfill-invite-activation.mjs --target
-- <env>` — which prints every tier that would cross before anything is written.

with bar as (
  select coalesce(
           (select (value)::integer from app_config where key = 'invite.activation_rankings'),
           5) as n
),
qualified as (
  select ia.invitee_id,
         greatest(
           (select r.created_at
              from rankings r
             where r.user_id = ia.invitee_id
             order by r.created_at, r.media_item_id
            offset (select n from bar) - 1
             limit 1),
           ia.accepted_at
         ) as qualified_at
    from invite_attributions ia
   where ia.accepted_at is not null
     and ia.activated_at is null
     and (select count(*) from rankings r where r.user_id = ia.invitee_id) >= (select n from bar)
)
update invite_attributions ia
   set activated_at = q.qualified_at
  from qualified q
 where ia.invitee_id = q.invitee_id
   and ia.activated_at is null
returning ia.invitee_id, ia.inviter_id, ia.activated_at;
