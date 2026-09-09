-- People you could start with.
-- Founder onboarding tranche 2026-09-09, step 9, organic state (`03-social-activation.md` §2B).
--
-- ===========================================================================
-- WHAT THIS IS FOR, AND WHY THE EXISTING TWO WOULD NOT DO
--
-- Onboarding ends with a social step. For somebody who arrived on an invitation there is
-- already an answer: `people_mutuals` walks outward from the edge redemption created, and
-- that walk is socially grounded because every row is a friend of a friend.
--
-- An **organic** signup has no such edge. The two functions that exist cannot help:
--
--   * `people_mutuals` needs a follow to walk from, and this account has none.
--   * `people_taste_matches` needs `taste.min_common` shared titles, seeded 5. An account
--     that has just finished the ranking run has ranked exactly five movies, so to be
--     scored against anybody it would have to have ranked all five of *the same* movies.
--     In a cohort of a hundred that is close to a zero-probability event.
--
-- The floor is deliberately not lowered to populate this screen. `20260827001000` exists
-- to stop thin evidence reading as certainty, and a two-title overlap rendering `91%
-- Match` is the failure it removed. Trading a true empty state for a false confident one
-- is a worse deal at every scale.
--
-- So this is a third, deliberately small function: **who is worth following, for somebody
-- with no relationships at all.**
--
-- ===========================================================================
-- IT RETURNS A FACT AND NEVER A SCORE
--
-- Two numbers, both of them counts a person could check: how many titles this candidate
-- has ranked that the caller has also ranked, and how many they have ranked altogether.
-- There is no percentage here and there must never be one -- a percentage on this screen
-- would be Match under another name, computed over evidence Match itself refuses.
--
-- `Match TBD` is deliberately not borrowed either. On the Leaderboard it means "there is
-- some overlap, just not enough to score", which is a statement about a pair; here there
-- is usually no pair to speak of, and the phrase would imply a comparison nobody ran.
--
-- ===========================================================================
-- THE ELIGIBILITY RULE IS STRICTER THAN MUTUALS, NOT LOOSER
--
-- `20260828000400` lets an eligible **private** account appear in Mutuals, and that is
-- right there: a friend of a friend is socially grounded, the row carries the lock, and
-- the control offers Request.
--
-- This surface has no relationship to trade on. It is a list put in front of a stranger,
-- so it is **public and broadly discoverable only**. `can_discover_profile` supplies the
-- blocks-in-either-direction and suspension rules; `visibility = 'public'` is the extra
-- condition this surface adds on top of them, and it is the whole difference between the
-- two lists.
--
-- `can_discover_profile` is server-only (`20260819000200` revoked it from clients,
-- because a definer helper taking a viewer is a block-graph oracle). This function is
-- definer, takes no viewer, and can only ever answer from `auth.uid()`'s own perspective
-- -- the rule `20260813001900` set for every discovery function in this database.
--
-- ===========================================================================
-- AND IT IS NOT A RECOMMENDATION ENGINE
--
-- Stated because the temptation is real and the next person to read this will feel it.
-- There is no decay, no diversification, no rotation, no popularity weighting and no
-- second-degree walk. The order is: shared titles, then whether they are still active,
-- then how much they have ranked, then a tie-break that never moves.
--
-- The tie-break is `username` and then `user_id`, so the same account asking twice gets
-- the same list twice. A list that reshuffles on a refresh teaches the reader that it
-- means nothing.

-- ---------------------------------------------------------------------------
-- The suggestion list
-- ---------------------------------------------------------------------------

create or replace function people_starter_suggestions(p_limit integer default 5)
returns table (
  user_id       uuid,
  username      text,
  display_name  text,
  avatar_path   text,
  visibility    profile_visibility,
  shared_count  integer,
  ranked_count  integer
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  -- Everything the caller has ranked, in any category. The overlap is a count of titles
  -- and not of movies specifically: a shared season is exactly as much evidence that two
  -- people watch the same things, and restricting the category here would make the number
  -- disagree with the word "shared" the row prints.
  mine as (
    select r.media_item_id
      from rankings r, me
     where r.user_id = me.id
  ),
  candidates as (
    select r.user_id as subject,
           count(*)::integer as ranked_count,
           count(*) filter (where r.media_item_id in (select media_item_id from mine))::integer
             as shared_count,
           max(r.created_at) as last_ranked_at
      from rankings r
      cross join me
     where r.user_id <> me.id
     group by r.user_id
  )
  select p.id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         p.visibility,
         c.shared_count,
         c.ranked_count
    from candidates c
    join profiles p on p.id = c.subject
    cross join me
   -- Public only. This is the one line that separates this list from Mutuals, and the
   -- header says why.
   where p.visibility = 'public'
     and p.status = 'active'
     -- Blocks in either direction, suspension, and the caller themselves.
     and can_discover_profile(me.id, p.id)
     -- Already followed, or already asked. Neither is a suggestion.
     and not exists (
       select 1 from follows own
        where own.follower_id = me.id and own.followee_id = p.id
     )
   order by c.shared_count desc,
            -- Still around. A candidate who has not ranked anything in months is a worse
            -- first follow than one who has, whatever their totals say, because the point
            -- of the follow is a Feed with something in it.
            c.last_ranked_at desc,
            c.ranked_count desc,
            -- The tie-break, and it never moves. `username` is editable, so `id` is what
            -- actually guarantees a stable order; the handle is first only so that a tie
            -- reads alphabetically to a human comparing two runs.
            p.username,
            p.id
   limit least(greatest(coalesce(p_limit, 5), 1), 10);
$$;

comment on function people_starter_suggestions(integer) is
  'Public, broadly discoverable accounts worth following for a caller with no relationships -- the organic state of the onboarding People step. Definer and takes no viewer, so it can only answer from auth.uid()''s own perspective (20260813001900). Ordered by shared ranked titles, then recency of ranking, then volume, then an immutable tie-break (username, id) so a refresh does not reshuffle. Returns two COUNTS and never a score: a percentage here would be taste_match over evidence taste_match itself refuses below app_config taste.min_common. STRICTER than people_mutuals on purpose: a private account may appear in Mutuals through relationship proximity (20260828000400) but is never put in front of a stranger, so this requires visibility = public in addition to can_discover_profile. Excludes the caller, anyone they already follow or have asked to follow, blocks in either direction, and suspended accounts.';

revoke execute on function people_starter_suggestions(integer) from public, anon;
grant  execute on function people_starter_suggestions(integer) to authenticated;
