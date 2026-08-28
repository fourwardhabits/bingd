-- A Match that knows how much evidence it has.
-- Founder tranche 2026-08-27 §14–16: the Match audit's one confirmed defect, fixed.
--
-- ---------------------------------------------------------------------------
-- THE DEFECT
--
-- `taste_match` (20260817000400) gates on `taste.min_common` (5) and then states its
-- number with full confidence: at exactly five shared titles the blend weight `w` is
-- still zero, so the score is pure proximity — and five near-identical ratings put
-- **90% Match** on screen with nothing anywhere saying how thin that evidence is.
-- The founder's framing of what Match answers — "how much weight might I give this
-- person's recommendation" — makes that a correctness problem, not a taste one: a
-- number that cannot distinguish five titles of evidence from fifty is answering a
-- different question than the one on the label. The gate was the only brake, and it
-- was a cliff: nothing between "no number" and "a number stated flat".
--
-- ---------------------------------------------------------------------------
-- THE FIX: SHRINK TOWARD THE STRANGER BASELINE
--
--   confidence = n / (n + p)          -- p = taste.shrink_prior, seeded 5
--   score      = round(50 + (blend - 50) * confidence)
--
-- Everything before the last line is unchanged — proximity, midrank Spearman, the
-- w-ramp blend. The shrink is the standard significance-weighting move for exactly
-- this failure (small-overlap similarity looks perfect: two users, two shared items,
-- identical ratings, correlation 1.0), applied to the blend rather than replacing it.
--
-- Fifty is not an arbitrary centre. The 20260817000400 header derives it: with the
-- ends anchored at "identical" and "opposite", two accounts rating independently at
-- random land near 52 — so 50 *is* "I know nothing about this pair beyond chance",
-- and shrinking toward it says "with this little evidence, you are hard to tell from
-- a stranger", which is the honest claim.
--
-- What the numbers become (identical evaluations, blend ≈ 100):
--
--   n =  5   →  75      the old cliff's 90+ now says "promising, thin"
--   n =  8   →  81
--   n = 20   →  90      the score the old formula gave at five
--   n = 50   →  95
--
-- Confidence is monotonic in n, so "more shared evidence, higher ceiling" is now a
-- property of the formula rather than a hope — and 100 is asymptotic, which is
-- honest too: no finite catalogue proves two people identical. Disagreement shrinks
-- symmetrically (an inverted pair at n = 5 reads ~28 rather than ~5), for the same
-- reason: five titles of opposition is also thin evidence.
--
-- The transform is monotone in the blend, so the founder's fixture ORDERING —
-- identical > mostly > mixed > inverted — is preserved at every n. What moves is the
-- spread at small n, which is the point.
--
-- Same signature, same three-column shape, so `people_taste_matches` (which calls
-- this per candidate) and both client surfaces inherit the semantics with no code
-- change. The below-threshold answer is still null — "Match TBD" is the client's
-- word for it — and everything in the WHY-THE-AGGREGATE-IS-SAFE argument holds:
-- this returns strictly less information than before, not more.
--
-- What was audited and deliberately NOT built (founder gate §16, path noted in the
-- tranche report): content-based taste profiles and collaborative filtering. Both
-- were researched; neither survives the current constraints — the population is
-- small and sparse (cold-start territory for CF), and a genre-profile similarity
-- from `media_items.genres` would put confident-looking numbers on pairs with *no*
-- shared evidence at all, which is the exact failure this migration removes.
-- Deferred to a Match v2 entry on the roadmap, not smuggled in here.
-- ---------------------------------------------------------------------------

insert into app_config (key, value)
values ('taste.shrink_prior', '5'::jsonb)
on conflict (key) do nothing;

create or replace function taste_match(p_user_id uuid)
returns table (
  score        integer,
  common_count integer,
  min_common   integer
)
language sql stable security definer
set search_path = public
as $$
  with threshold as (
    select
      coalesce(
        (select (value)::integer from app_config where key = 'taste.min_common'),
        5
      ) as k,
      coalesce(
        (select (value)::integer from app_config where key = 'taste.shrink_prior'),
        5
      ) as p
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
      threshold.p,
      -- Proximity. Seven is the measured gap between opposite opinions; the clamp is
      -- a guard, not part of the arithmetic (see 20260817000400 for the five-denominator
      -- bug that distinction comes from).
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
          -- The blend, then the shrink. `::numeric` on n because integer division
          -- would round the confidence to zero for every real pair.
          50 + (
            case
              when parts.agreement is null then parts.proximity
              else (1 - parts.w) * parts.proximity + parts.w * parts.agreement
            end - 50
          ) * (parts.n::numeric / (parts.n + parts.p))
        )::integer
    end,
    parts.n,
    parts.k
    from parts;
$$;

comment on function taste_match(uuid) is
  'How close the caller''s opinions are to one other account''s, over exactly the media items both have ranked. Score proximity is the primary component; Spearman rank agreement contributes nothing below eight shared titles and at most a quarter above twenty; since 20260827001000 the blend is shrunk toward the 50 stranger baseline by n/(n + taste.shrink_prior), so thin evidence reads as near-chance rather than as certainty. Null score below app_config taste.min_common. Derived live from rankings through band_bounds and score_for -- never from feed_events snapshots. Refuses self and anyone can_view_profile does not admit, returning the same insufficient-overlap shape, and never returns which titles are shared.';

-- Grants restated so this migration stands alone if the earlier one's are audited.
revoke execute on function taste_match(uuid) from public, anon, authenticated;
grant  execute on function taste_match(uuid) to authenticated;
