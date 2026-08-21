-- ---------------------------------------------------------------------------
-- The watchlist stops being a private domain and becomes profile content.
--
-- **Founder decision, 2026-08-20, taken in the Preview micropass.** PRD §22 has
-- carried this line since 2026-08-13:
--
--   > The watchlist remains always-private at every visibility level. It is intent
--   > about things you have not watched, which is a different disclosure from a
--   > reaction to something you have — closer to a search history than to an
--   > opinion. Say so if you want it public; it is a one-line change and a separate
--   > decision.
--
-- This is that separate decision, and it is being taken for a product reason rather
-- than a technical one. Top Ranked says what somebody loves; the watchlist says what
-- they want to watch next, and the second is the socially actionable half — "I want
-- to watch that too" is a reason to message somebody, and a private watchlist cannot
-- produce one.
--
-- ## What changes, exactly
--
-- `watchlist_own` (`20260813000500`) was `user_id = auth.uid()`. It becomes
-- `can_i_view(user_id)`, which is the *same oracle* `rankings_read` already uses. So
-- the watchlist now behaves like every other piece of profile content:
--
--   * a public account's watchlist is readable;
--   * a private account's is readable by approved followers only;
--   * a block in either direction hides it, because `can_view_profile` returns false
--     across a block;
--   * a suspended or deleted account's is gone with the rest of the profile.
--
-- Deliberately *not* `can_view_profile(auth.uid(), user_id)`: a definer helper that
-- accepts a viewer lets a caller substitute somebody else and turn the policy into a
-- follow-graph oracle. `20260813001900` settles that argument; this follows it.
--
-- ## What does not change
--
-- **No new table and no new column.** There is **one new index**, and independent review
-- is the reason it exists rather than a claim that the primary key was enough.
--
-- The profile shelf is `where user_id = $1 order by created_at desc limit 12`. The primary
-- key `(user_id, media_item_id)` serves the *filter* but not the *order*, so Postgres has
-- to read and sort the whole of that account's watchlist to return twelve rows — on every
-- profile view, growing with the size of a backlog the shelf never shows. Queue Dragon's
-- top tier is three hundred saved titles, so this is not a hypothetical shape.
--
-- `(user_id, created_at desc, media_item_id)` matches the query's exact ordering,
-- including the tie-break, so the read becomes an index scan that stops after twelve rows.
-- The trailing column is what makes it stop at twelve rather than sort within a timestamp.
--
-- **Writes are untouched.** `watchlist` has never had an insert, update or delete
-- policy — `set_watchlist` (`20260813002300`) is `security definer` and checks the
-- caller itself, and `_leave_watchlist` (`20260815040000`) is a trigger. Widening a
-- *select* policy cannot widen any of those. RLS denies by default, so the absence of
-- the other three policies is still a refusal.
--
-- **`created_at` is now visible to a viewer who can see the row**, and that is
-- intended rather than incidental: the profile shelf is ordered most-recently-added
-- first, so the ordering column has to be readable. It is a save time, not a watch
-- date — watch dates live in `user_media`, which stays owner-only for exactly the
-- reason this table no longer does.
--
-- ## What this does not make public
--
-- Notes and watch dates are still always-private (`user_media_own` is untouched).
-- This moves one row of PRD §22's table and nothing adjacent to it.
-- ---------------------------------------------------------------------------

create index if not exists watchlist_owner_recent
  on watchlist (user_id, created_at desc, media_item_id);

drop policy if exists watchlist_own on watchlist;

create policy watchlist_read on watchlist for select
  using (can_i_view(user_id));

comment on table watchlist is
  'Intent to watch. Reads follow profile visibility (can_i_view), the same rule as rankings and the logged collection: PRD §22, founder decision 2026-08-20. Writes are definer-only through set_watchlist; there is deliberately no insert, update or delete policy.';
