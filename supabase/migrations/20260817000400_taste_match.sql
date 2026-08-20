-- Taste Match: how close two people's opinions actually are.
-- Specification: founder addendum 2026-08-16 §3.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS NOT
--
-- It is **not** a recommendation. Phase B is closed and nothing here touches it: this
-- reads `rankings` and returns a number, and no part of the For You pipeline consults
-- it. The founder was explicit, and it is worth stating in the schema because the two
-- would otherwise look like the same kind of thing.
--
-- It is **not** `community_score` or `following_score`. Both of those are aggregates
-- over a *population* from one viewer's side. This is pairwise and symmetric: it is a
-- fact about two people, and A's match with B is B's match with A. Neither of the
-- existing functions can be reused, and neither should grow a second meaning.
--
-- ---------------------------------------------------------------------------
-- THE FORMULA, IN FULL
--
-- Let C be the set of media items **both** accounts have ranked. Exact items: a movie
-- against the same movie, a season against the same season. `r.media_item_id =
-- r2.media_item_id` is the whole of it, so "never compare a Series to a Season" holds
-- by construction rather than by a rule — a series is not rankable at all (AD-1), so
-- it cannot enter C.
--
-- Scores are derived live from the canonical current rankings, through `band_bounds`
-- and `score_for`, exactly as `community_score` and `following_score` do. Never from
-- `feed_events.payload`, which carries a snapshot from the moment of an event and goes
-- stale the instant its owner ranks anything else in the same band.
--
--   n = |C|
--
--   1. INSUFFICIENT. If n < `taste.min_common` (5), there is no number. Not a low
--      score — an absence. Two people who have both seen four films and agreed on all
--      four are not a 100% match, and saying so would be the feature's first lie.
--
--   2. PROXIMITY, the primary component.
--
--        d = mean over C of |score_a - score_b|
--        proximity = 100 * (1 - d / 7), clamped to [0, 100]
--
--      **Seven is measured, not chosen.** `band_bounds` and `score_for` spread each
--      band across the 0–10 scale, so a title one person loves and the other rejects
--      sits at roughly 8.5 against 1.7 — a gap of about 6.8. Seven is therefore "as
--      unalike as two people can be about a film they have both seen", and anchoring
--      the bottom of the scale there is what makes the founder's four fixtures come
--      out in the right places at once.
--
--      The first draft used five, and it failed one of them for an instructive reason.
--      With five, a fully inverted pair produced a *negative* proximity that the clamp
--      swallowed — so the range was not "identical to opposite", it was "identical to
--      opposite, with the last third folded flat". A pair agreeing on half the titles
--      and opposed on the other half, which is exactly halfway between the two
--      extremes, then landed at 32 rather than in the middle. The clamp was doing
--      arithmetic the formula was supposed to do.
--
--      What seven costs, stated rather than left to be discovered: two accounts rating
--      independently and uniformly have an expected gap of 10/3, so a **stranger
--      scores about 52**. That follows from anchoring the ends at "identical" and
--      "opposite" rather than at "random", and only end-anchoring satisfies all four
--      fixtures. The consequence is that this number should be read comparatively —
--      80 against 50 says something; 50 on its own means "nothing in common but the
--      films themselves".
--
--   3. ORDER AGREEMENT, the secondary component.
--
--      Proximity alone cannot tell "we both liked everything" from "we liked the same
--      things in the same order". Two people who rate everything 8 and 9 respectively
--      are close in level and say nothing about each other's taste; two who agree on
--      which of twenty films is best are saying something real.
--
--      So: Spearman's rank correlation over C, computed as Pearson's correlation of
--      the two midrank vectors — which is what `corr()` over average ranks is.
--      Midranks, not `rank()`, because ties are common (two films in the same band at
--      adjacent positions can round to the same score) and plain ranks would make a
--      tie-heavy pair look like a disagreement.
--
--        agreement = 50 * (rho + 1)        -- rho in [-1, 1] -> [0, 100]
--
--      Null when either side has no variance at all (somebody whose common titles all
--      scored identically), in which case it contributes nothing rather than zero:
--      "no information" and "perfect disagreement" are different claims.
--
--   4. THE BLEND, and why it ramps.
--
--        w = 0.25 * clamp((n - 8) / 12, 0, 1)
--        score = round((1 - w) * proximity + w * agreement)
--
--      The founder's constraint was that order agreement "must not dominate tiny
--      samples". A rank correlation over five titles is almost noise — one swap moves
--      it by a third — so its weight is **zero** until eight shared titles, then rises
--      linearly to a quarter at twenty, and never goes above a quarter.
--
--      A ramp rather than a threshold, deliberately. A step at n = 8 would mean the
--      ninth film two people had both seen could move the number by several points on
--      its own, which is exactly the kind of jump that makes a metric feel arbitrary.
--
-- Every step is arithmetic over two integers and a set. There is no model, no
-- embedding, no LLM, no demographic input, and nothing that consults the follow
-- relationship — the founder ruled all of those out and none of them appear.
--
-- ---------------------------------------------------------------------------
-- WHY THE AGGREGATE IS SAFE
--
-- The same argument `following_score` records, and it holds for the same reason.
--
-- The function refuses unless `can_view_profile(auth.uid(), p_user_id)`. That is
-- exactly the predicate `rankings_read` authorises through, so every ranking folded
-- into this number belongs to an account whose rows the caller **could already select
-- one at a time**. The aggregate therefore discloses nothing new; it saves the caller
-- a page of arithmetic they were entitled to do.
--
-- That is also why the common-title count is returned without embarrassment: it counts
-- rows the caller can enumerate directly.
--
-- What is deliberately *not* returned is which titles they are. The founder asked for
-- the score and the count and nothing else, and the list would be the one part of this
-- that is a genuine convenience rather than a re-derivation — a compact export of
-- someone's catalogue intersected with your own.
-- ---------------------------------------------------------------------------

insert into app_config (key, value)
values ('taste.min_common', '5'::jsonb)
on conflict (key) do nothing;

create or replace function taste_match(p_user_id uuid)
returns table (
  score        integer,
  common_count integer,
  min_common   integer
)
-- definer, like `community_score` and `following_score`, and for the same reason: it
-- reads `rankings` rows across two accounts and must apply its own authorisation
-- rather than inherit the caller's row policies. It takes a *subject* and never a
-- viewer, so 20260813001900's rule holds — the only perspective it can answer from is
-- `auth.uid()`'s own.
language sql stable security definer
set search_path = public
as $$
  with threshold as (
    select coalesce(
      (select (value)::integer from app_config where key = 'taste.min_common'),
      5
    ) as k
  ),
  authorised as (
    select p_user_id as subject
     where auth.uid() is not null
       and p_user_id is not null
       -- Never against yourself. A 100% match with your own catalogue is a tautology,
       -- and the founder asked for it to be absent rather than perfect. Refused here
       -- as well as hidden by the client, so a modified client learns nothing either.
       and p_user_id <> auth.uid()
       -- AD-5 from the caller's own side: suspension, blocks in either direction, and
       -- a private account that has not approved this follower.
       and can_view_profile(auth.uid(), p_user_id)
  ),
  -- Both sides' canonical current scores for exactly the items both have ranked.
  common as (
    select
      round(score_for(mine.bucket, (mine.position - mb.lo + 1)::integer, mb.size), 1) as a,
      round(score_for(theirs.bucket, (theirs.position - tb.lo + 1)::integer, tb.size), 1) as b
      from authorised
      join rankings mine   on mine.user_id = auth.uid()
      join rankings theirs on theirs.user_id = authorised.subject
                          and theirs.media_item_id = mine.media_item_id
      join lateral band_bounds(mine.user_id, mine.category, mine.bucket)      mb on true
      join lateral band_bounds(theirs.user_id, theirs.category, theirs.bucket) tb on true
  ),
  -- Midranks, so ties do not read as disagreement. `rank()` gives the first position
  -- of a tied group; adding half the group's excess turns it into the average rank,
  -- which is what Spearman is defined over.
  ranked as (
    select
      a, b,
      rank() over (order by a) + (count(*) over (partition by a) - 1) / 2.0 as ra,
      rank() over (order by b) + (count(*) over (partition by b) - 1) / 2.0 as rb
      from common
  ),
  stats as (
    select
      count(*)::integer                    as n,
      avg(abs(a - b))                      as mean_gap,
      corr(ra, rb)                         as rho
      from ranked
  ),
  parts as (
    select
      stats.n,
      threshold.k,
      -- Proximity. Seven is the measured gap between opposite opinions, so the clamp
      -- should never fire on real data — it is a guard, not part of the arithmetic.
      -- That distinction is the whole of the bug the first draft had: with a
      -- denominator of five the clamp *was* part of the arithmetic, and it folded the
      -- bottom third of the range flat.
      --
      -- The `coalesce` is the no-overlap case: `avg` over no rows is null, and seven
      -- makes it a proximity of zero, which the threshold above discards anyway.
      greatest(0, least(100, 100 * (1 - coalesce(stats.mean_gap, 7) / 7))) as proximity,
      -- Null rho contributes nothing rather than zero. It arises when one side's
      -- common scores are all equal, which is an absence of information and not a
      -- statement of disagreement.
      case when stats.rho is null then null else 50 * (stats.rho + 1) end as agreement,
      -- Zero below eight shared titles, a quarter at twenty, linear between.
      0.25 * greatest(0, least(1, (stats.n - 8) / 12.0))                  as w
      from stats, threshold
  )
  select
    case
      when parts.n >= parts.k then
        round(
          case
            when parts.agreement is null then parts.proximity
            else (1 - parts.w) * parts.proximity + parts.w * parts.agreement
          end
        )::integer
    end,
    parts.n,
    parts.k
    from parts;
$$;

comment on function taste_match(uuid) is
  'How close the caller''s opinions are to one other account''s, over exactly the media items both have ranked. Score proximity is the primary component; Spearman rank agreement contributes nothing below eight shared titles and at most a quarter above twenty. Null score below app_config taste.min_common. Derived live from rankings through band_bounds and score_for -- never from feed_events snapshots. Refuses self and anyone can_view_profile does not admit, returning the same insufficient-overlap shape, and never returns which titles are shared.';

-- Authenticated only. `auth.uid()` is one half of the pair, so an anon caller has no
-- catalogue to compare and could only ever receive the empty answer.
revoke execute on function taste_match(uuid) from public, anon, authenticated;
grant  execute on function taste_match(uuid) to authenticated;
