-- The second hardening file of the Watch History + Lists pass, 2026-09-20.
--
-- `20261011000100` has already run against staging, so it is history and this correction
-- arrives as its own file.
--
-- It contains **one change**, and the reason the file is named for a second one is worth
-- keeping: an index was written for the feed, measured, and **rejected**. Both numbers are
-- from `supabase/tests/perf/watch-history-lists-scale.mjs` against a real PostgreSQL 17
-- seeded with a 1,200-ranked-title account and 120 background accounts — 19,232 feed rows,
-- 19,320 collection rows, 126,000 comparisons.
--
-- ===========================================================================
-- WHAT THIS FIXES: `can_i_view` ASKED THREE QUESTIONS TO ANSWER "IS THIS MINE?"
--
-- `rankings_read` is `can_i_view(user_id)`, so reading your own 1,200-film ranking calls it
-- 1,200 times, and each call reaches `can_view_profile`, which for a non-self subject looks
-- at `profiles`, `blocks` and `follows`. For the **owner's own rows** that answer is already
-- decided by that function's second branch — `when viewer = subject then true` — and
-- everything before it is a null check.
--
-- Measured, on the Collection read (`select … from rankings where user_id = <self> and
-- category = 'movies' order by position`, 1,200 rows):
--
--   before   407.7ms p50
--   after     18.4ms p50
--
--   Bitmap Heap Scan on rankings (actual time=1.2..29.3 rows=1200)
--     Filter: (can_i_view(user_id) AND (category = 'movies'))
--     -> Bitmap Index Scan on rankings_lookup (actual time=0.7..0.7)
--
-- The index was never the problem; the per-row filter was. So the equality is hoisted into
-- `can_i_view` itself, where every policy that calls it benefits at once — rankings, the
-- feed, reactions, comments and the tag readers.
--
-- **It is the same answer, not a shortcut.** `can_view_profile(v, s)` returns `true` for
-- `v = s` unconditionally and *before* its suspension test, so a self-read could not have
-- been refused by the old path either. The `coalesce` keeps the null case identical: with no
-- session `subject = auth.uid()` is null, `coalesce(…, false)` makes it false, and the call
-- falls through to `can_view_profile(null, subject)` exactly as before.
--
-- ===========================================================================
-- WHAT WAS MEASURED AND NOT SHIPPED, SO THAT NOBODY ADDS IT AGAIN
--
-- `use-feed.ts` pages on `causal_at desc, causal_step desc, id asc` (20260902000100, so
-- that a ranking, the goal it completes and the award it earns stay together), and **no
-- index matches that order**. The obvious conclusion is wrong:
--
--   feed page 1, 31 followees, 19,232 rows   2180ms without a matching index
--                                             2385ms with `(actor_id, causal_at desc,
--                                                            causal_step desc, id)`
--
-- The index changes nothing because the sort is not the cost. The cost is
-- `feed_events_read` — `can_i_view(actor_id)` — evaluated once per row the actor filter
-- matches, about 4,650 of them here, at roughly 0.7ms each. The self fast path above cannot
-- help: on a feed, every actor is somebody else.
--
-- That is a **pre-existing** property of the visibility model (20260813001900), not
-- something this tranche introduced, and it does not have a bounded fix — making it cheap
-- means changing how visibility is resolved for a set of actors rather than per row, which
-- is a design change and was explicitly out of scope for this pass. It is recorded in the
-- integration report as the first performance follow-up, with these numbers.

create or replace function can_i_view(subject uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  -- 20261012000100. The owner's own rows — which is the whole of a Collection read — without
  -- three lookups per row. `can_view_profile` answers `true` for viewer = subject anyway;
  -- this says the same thing earlier and 22x faster over 1,200 rows. The coalesce keeps the
  -- no-session case byte-for-byte what it was: `null = null` is null, not true.
  select coalesce(subject = auth.uid(), false)
      or can_view_profile(auth.uid(), subject);
$$;

comment on function can_i_view is
  'AD-5 visibility from the caller''s own perspective. Policies must call this rather than can_view_profile(auth.uid(), x): a definer helper that accepts a viewer lets any caller substitute someone else and read approved-follow and block relationships between third parties. Since 20261012000100 it answers the self case by equality first -- which is what can_view_profile''s own second branch already decided -- so that reading 1,200 of your own rankings costs 1,200 comparisons rather than 1,200 sets of profile, block and follow lookups (407ms to 18ms, measured).';
