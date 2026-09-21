-- The second hardening file of the Watch History + Lists pass, 2026-09-20.
--
-- `20261011000100` has already run against staging, so it is history and these two
-- corrections arrive as their own file.
--
-- Both are **measured**, by `supabase/tests/perf/watch-history-lists-scale.mjs` against a
-- real PostgreSQL 17 seeded with a 1,200-ranked-title account and 120 background
-- accounts (19,200 feed rows, 19,320 collection rows). Neither changes a rule; each one
-- removes work that was being done per row for no answer.
--
-- ===========================================================================
-- 1. THE FEED'S FIRST PAGE READ THE WHOLE FEED
--
-- `use-feed.ts` pages on the causal keys — `causal_at desc, causal_step desc, id asc`,
-- decided by 20260902000100 so that a ranking, the goal it completes and the award it
-- earns sit together and in order. **No index has ever matched that order.**
-- `feed_events_actor` is `(actor_id, created_at desc)` and `feed_events_recent` is
-- `(created_at desc)`, so a page sorts instead, and the `feed_events_read` policy —
-- `can_i_view(actor_id)` — is then evaluated for **every row the sort touches** rather
-- than for the fifty the page returns.
--
-- Measured, with the policy in place and 19,231 rows:
--
--   Limit (actual time=17409ms) -> Sort -> Seq Scan on feed_events (rows=19231)
--                                          Filter: can_i_view(actor_id)
--
-- That is one screen, at a feed size a few hundred active accounts would produce. The
-- index below gives the planner the client's own order, so a page walks it and stops:
-- the filter runs for the rows it returns plus whatever it skips, not for the table.
--
-- `actor_id` leads, because every activity query filters on the follow set
-- (`.in('actor_id', actorIds)`) before it orders — so the same index serves both halves,
-- and a per-actor ordered walk can be merged without sorting at all.
--
-- ===========================================================================
-- 2. `can_i_view` ASKED THREE QUESTIONS TO ANSWER "IS THIS MINE?"
--
-- `rankings_read` is `can_i_view(user_id)`, and reading your own 1,200-film ranking calls
-- it 1,200 times. Each call reaches `can_view_profile`, which for a non-self subject looks
-- at `profiles`, `blocks` and `follows`. For the **owner's own rows** the answer is
-- already decided by that function's second branch — `when viewer = subject then true` —
-- and everything before it is a null check.
--
-- Measured: `select … from rankings where user_id = <self> and category = 'movies'`
-- took **957ms p50** for 1,200 rows, with the time in the filter rather than the scan:
--
--   Bitmap Heap Scan on rankings (actual time=3.1..1012.9 rows=1200)
--     Filter: (can_i_view(user_id) AND (category = 'movies'))
--     -> Bitmap Index Scan on rankings_lookup (actual time=1.9..1.9)
--
-- So the equality is hoisted into `can_i_view` itself, where every policy that calls it
-- benefits at once: rankings, feed, reactions, comments, the tag readers.
--
-- **It is the same answer, not a shortcut.** `can_view_profile(v, s)` returns `true` for
-- `v = s` unconditionally, *before* its suspension test, so a self-read could not have
-- been refused by the old path either. The `coalesce` keeps the null case identical: with
-- no session, `subject = auth.uid()` is null, `coalesce(..., false)` makes it false, and
-- the call falls through to `can_view_profile(null, subject)` exactly as before.

-- ---------------------------------------------------------------------------
-- 1. The index the client's pagination has always needed
-- ---------------------------------------------------------------------------

create index if not exists feed_events_causal
  on feed_events (actor_id, causal_at desc, causal_step desc, id);

comment on index feed_events_causal is
  'The order use-feed.ts pages in (causal_at desc, causal_step desc, id), behind the '
  'actor filter every activity query applies. Without it a first page sorts the whole '
  'table and the feed_events_read policy is evaluated per row rather than per returned '
  'row: 17.4s at 19,231 rows, measured 2026-09-20.';

-- ---------------------------------------------------------------------------
-- 2. The self case, answered without a subquery
--
-- Rebuilt in full from 20260813001900, which is its only definition: `grep "function
-- can_i_view"` finds that create, this one, and the grants — no rename, so no older body
-- hiding under another name (the rebuild trap).
-- ---------------------------------------------------------------------------

create or replace function can_i_view(subject uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  -- 20261012000100. The owner's own rows, which is the whole of a Collection read, without
  -- three lookups per row. `can_view_profile` answers `true` for viewer = subject anyway;
  -- this says the same thing earlier. The coalesce keeps the no-session case unchanged:
  -- null = null is null, not true, and the fall-through is then byte-for-byte the old
  -- behaviour.
  select coalesce(subject = auth.uid(), false)
      or can_view_profile(auth.uid(), subject);
$$;

comment on function can_i_view is
  'AD-5 visibility from the caller''s own perspective. Policies must call this rather than can_view_profile(auth.uid(), x): a definer helper that accepts a viewer lets any caller substitute someone else and read approved-follow and block relationships between third parties. Since 20261012000100 it answers the self case by equality first, which is what can_view_profile''s own second branch already decided, so that reading 1,200 of your own rankings does not cost 1,200 sets of profile, block and follow lookups.';
