-- Reactions default on. Awards do not, because nothing writes one.
-- Specification: docs/product/PRD.md §15 · AD-10 · founder Preview pass, 2026-08-20
--
-- ===========================================================================
-- WHAT CHANGES
--
-- One line of `_notification_default`: `reactions` goes from false to true.
--
-- The founder's instruction for the beta is that every notification category that
-- **actually works** should be on for a new account. Seven of the eight do. The
-- eighth is `awards`, and it stays off — see below.
--
-- ===========================================================================
-- WHY THIS IS NOT A DATA MIGRATION, AND WHY THAT IS THE WHOLE POINT
--
-- `20260819000300` put the default in a function and made *absence* mean "the
-- category's default" rather than "true". That decision is what makes this change
-- three lines instead of a backfill, and it is also what makes it safe:
--
--   * An account with **no row** for `reactions` never expressed a preference. It gets
--     the new default, which is the intended effect.
--   * An account with a row — `true` or `false` — chose. `_notifies` coalesces to the
--     row and never reaches `_notification_default`, so **an explicit choice is
--     untouched by construction**, not by a `where` clause somebody has to get right.
--
-- That second bullet is the founder's hard requirement: a beta tester who switched
-- reactions off during testing must still have them off tomorrow. Nothing here writes,
-- updates or deletes a single row of `notification_preferences`. There is no backfill
-- because a backfill is exactly the thing that would break it.
--
-- Forward-only. Rolling back is the same three lines with `false`, and no data to undo.
--
-- ===========================================================================
-- WHY `reactions` MOVES
--
-- `20260819000300` defaulted it off with a reason worth restating before overruling it:
-- one tap, from anybody who can see the activity, on every event, and "the median
-- notification carries no information beyond somebody saw this".
--
-- That is an argument about volume, and volume is a property of a *populated* app. In a
-- friend beta with a handful of accounts, a reaction is one of the few signals that
-- anything is happening at all — and an account that has silently never received one is
-- indistinguishable from a feature that does not work. The founder's call, and the
-- volume argument comes back the day the numbers justify it.
--
-- It stays deduped per (reactor, event) for good, so this cannot become a stream from
-- one person re-reacting.
--
-- ===========================================================================
-- WHY `awards` DOES NOT MOVE
--
-- **Nothing writes an `award_earned` notification.** The type exists, the category
-- exists, the trigger maps it and the settings screen shows a switch — and no writer
-- anywhere produces the row. Award tiers are computed on the device from raw table
-- reads (`src/features/awards`), and no server-side state records which tier an account
-- has reached, so a *crossing* cannot be told from a *state* without a durable unlock
-- ledger this run is not building. `docs/product/deferred-roadmap.md` §5.
--
-- Defaulting it on would turn a switch that does nothing into a switch that does
-- nothing and claims otherwise. The founder's instruction is explicit on this: Awards
-- only if award notifications have a durable writer; otherwise do not pretend the
-- functionality exists.
--
-- `invites` is the opposite case and is already on: `20260819000500` gave
-- `invite_activated` a writer, so that switch governs real traffic.

create or replace function _notification_default(p_category text)
returns boolean
language sql immutable
set search_path = public
as $$
  -- Absence means *this*, rather than meaning true. One is false, and it is named here
  -- rather than inferred, so adding a category defaults it on by omission -- which is
  -- the safe direction: a notification that arrives unwanted is a setting somebody
  -- turns off, and one that never arrives is a bug nobody can see.
  --
  -- `awards` is false because nothing writes an award notification, not because award
  -- notifications are unwanted. The day a durable unlock ledger exists, this line goes
  -- and the category defaults on with the other seven.
  select case p_category
    when 'awards' then false
    else true
  end;
$$;

comment on function _notification_default(text) is
  'What a category means when the account has no row for it. Seven of eight are true, which is what absence has meant since 20260813000900; awards is false because nothing writes one. reactions moved to true on 20260820 (founder Preview pass). Accounts with an explicit row are unaffected -- _notifies coalesces to the row and never reaches this. Internal.';
