-- ---------------------------------------------------------------------------
-- The Following score: what the people you follow made of this title
--
-- Community answers "what does everybody think". This answers "what do the people
-- whose taste I chose think", which is the question the founder wants on a title
-- page beside it — and for most readers it is the more useful of the two, because
-- the population is one they assembled deliberately.
--
-- WHY "FOLLOWING" AND NOT "FRIEND"
--
-- `follows` is directional. A row means the follower asked and, for a private
-- account, was approved; it does not mean the followee follows back. Calling a
-- one-directional relationship a friendship would be the app asserting a mutuality
-- that the schema does not record and the people involved never agreed to. The
-- founder brief is explicit on this and it is also just true: the number is over
-- accounts *you follow*, so that is what it is called.
--
-- WHY A SAMPLE OF ONE IS ALLOWED HERE, AND NOT FOR COMMUNITY
--
-- `community_score` withholds its number below `score.community_min_ratings`,
-- because a mean of two strangers looks like data and is not. The reasoning does
-- not carry over. A Following score of one is not a weak estimate of a population;
-- it is one person you deliberately follow, and "the one person you follow who has
-- seen this gave it 8.4" is a complete and useful statement. Suppressing it would
-- withhold the only case a new account can produce at all, which is the case that
-- has to work if following anybody is to feel worth doing.
--
-- The privacy arithmetic is what makes the minimum of one safe rather than merely
-- desirable. Every rating folded into this mean belongs to an account the caller
-- can already read one by one: `rankings_read` authorises through `can_i_view`,
-- which is `can_view_profile(auth.uid(), user_id)`, and that is the same predicate
-- filtering the population below. So even at n = 1, where the aggregate *is* one
-- person's score exactly, it discloses nothing the caller could not have computed
-- from rows they are entitled to select. That is the property `community_score`
-- had to be repaired to hold (see 20260816000100, where a blocked rater's score
-- was recoverable by subtraction); here it holds by construction, because the
-- filter and the row policy are the same predicate rather than two that happen to
-- agree today.
--
-- WHAT IS COMPARED
--
-- Exactly one `media_items` row. A movie is compared with the same movie and a
-- season with the same season; a series is never an aggregate of its seasons,
-- because a series is not rankable at all (AD-1) and a mean over its seasons would
-- be a number nobody expressed. `rankings.media_item_id = p_media_item_id` is the
-- whole of it, and it is exact by being an equality rather than a traversal.
--
-- Scores are derived live from the canonical current rankings through
-- `band_bounds` and `score_for`, the same path `community_score` and the client
-- take. Deliberately **not** `feed_events`, which carries a score snapshot from
-- the moment of an event: those go stale the instant the rater ranks anything else
-- in the same band, and a Following score built on them would drift away from what
-- the same followee's profile shows.
--
-- WHY IT IS AN AGGREGATE RATHER THAN A LIST
--
-- The alternative shape — hand the client the followees' rankings and let it
-- average them — would mean downloading a page of other people's collections to
-- put one number on one title. This returns two integers and a numeric, computed
-- where the rows already are, which is the founder's constraint and also the only
-- version that stays cheap as somebody's following list grows.
-- ---------------------------------------------------------------------------

-- WHY IT ALSO RETURNS HOW MANY PEOPLE THE CALLER FOLLOWS
--
-- Without it the surface cannot tell two silences apart, and they are not the same
-- silence. "You follow nobody" is a row that would never say anything and should not
-- be drawn; "you follow eleven people and none of them have seen this" is a real and
-- useful answer, and it is also the only way somebody learns the feature exists before
-- their following list happens to overlap a film they open.
--
-- It is not filtered by `can_view_profile`, deliberately. This is a count of the
-- caller's own follows — their own data, which they can read directly from `follows` —
-- and it decides only whether a row is drawn. Applying the visibility predicate would
-- cost one function call per followee on every title page to make a number slightly
-- smaller in a case nobody can observe.

create or replace function following_score(p_media_item_id uuid)
returns table (
  score           numeric,
  rating_count    integer,
  following_count integer
)
-- definer, like `community_score`, for the same reason: it reads `rankings` rows
-- across accounts and must apply its own authorisation rather than inherit the
-- caller's row policies. Every account it reads is one `can_view_profile` has
-- already cleared for this caller.
language sql stable security definer
set search_path = public
as $$
  with rated as (
    select
      round(avg(score_for(r.bucket, (r.position - bb.lo + 1)::integer, bb.size)), 1) as avg_score,
      count(*)::integer as n
      from follows f
      join rankings r
        on r.user_id = f.followee_id
       and r.media_item_id = p_media_item_id
      join lateral band_bounds(r.user_id, r.category, r.bucket) bb on true
     where f.follower_id = auth.uid()
       -- Approved only. A pending request to a private account is not a
       -- relationship yet, and counting one would let a stranger learn a private
       -- account's rating by requesting a follow and reading a title page.
       and f.state = 'approved'
       -- AD-5 from the caller's own perspective, and the same predicate
       -- `rankings_read` uses. Covers suspension, blocks in either direction, and
       -- a private account that has since revoked approval — none of which delete
       -- the `follows` row, so none of which would be caught by `state` alone.
       and can_view_profile(auth.uid(), f.followee_id)
  ),
  followed as (
    select count(*)::integer as n
      from follows f
     where f.follower_id = auth.uid()
       and f.state = 'approved'
  )
  -- `count(*)` over no rows is 0 and `avg` is null, so an unauthenticated caller —
  -- who follows nobody, `auth.uid()` being null — gets exactly the same answer as
  -- somebody whose followees have not seen the film: no score, no raters. There is
  -- no branch here that could be got wrong for the anon case, which is why there
  -- is no branch.
  select rated.avg_score, rated.n, followed.n from rated, followed;
$$;

comment on function following_score(uuid) is
  'The mean canonical score for exactly one media item over the approved accounts the caller follows and can view. Null score when none of them have ranked it. Directional — the caller''s followees, not mutual follows — which is why it is a Following score and not a friend score. Safe at a sample of one because every rating counted belongs to an account rankings_read already lets the caller select individually.';

-- Authenticated only. `auth.uid()` is the whole population filter, so an anon
-- caller can only ever receive the empty answer; granting it would be offering a
-- function that is by construction useless, and the allow-list in
-- function-grants.test.mjs is easier to read when every entry is there for a
-- reason.
revoke execute on function following_score(uuid) from public, anon, authenticated;
grant  execute on function following_score(uuid) to authenticated;
