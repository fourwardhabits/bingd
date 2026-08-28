-- The people behind the Following score.
-- Founder tranche 2026-08-27 §13: tapping the Following aggregate on a title page
-- opens the list it averages — who I follow that rated this, what they gave it, and
-- how much their taste matches mine.
--
-- ---------------------------------------------------------------------------
-- WHY THE AGGREGATE'S OWN PREDICATE, RESTATED
--
-- `following_score` (20260816001100) argued its aggregate safe because its population
-- filter *is* `rankings_read`'s predicate: approved follow, viewable profile. This
-- function returns the rows behind that aggregate, so it uses the same predicate
-- verbatim — every row it names is a row the caller could already select one at a
-- time. Anything looser here would widen the aggregate's own argument; anything
-- tighter would make the list disagree with the number it explains.
--
-- Scores are derived live through `band_bounds` and `score_for`, exactly as the
-- aggregate derives them, so the mean and its members cannot drift apart.
--
-- ---------------------------------------------------------------------------
-- MATCH, BY THE ONE ALGORITHM
--
-- The founder's rule from `people_taste_matches` (20260826000500 §9b) holds: there is
-- one taste algorithm, and the way to keep that true is to call it. The lateral
-- invokes `taste_match(member)` per row, inheriting its refusals and its
-- below-threshold null — which the client renders as "Match TBD" rather than a
-- number. `taste_match` reads two whole catalogues per call, which is why
-- `FollowListSheet` refuses to decorate fifty arbitrary rows with it; this list is
-- different in exactly the way that matters: it is bounded to the people the caller
-- follows *who ranked this one title*, a set that is a handful in this population,
-- and capped below anyway.
--
-- Ordering (founder §13): trustworthy Match first, then their rating, then a stable
-- name — so the person whose recommendation you would weight most is at the top, and
-- the list never reshuffles between refetches.
-- ---------------------------------------------------------------------------

create or replace function following_ratings(p_media_item_id uuid)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  score        numeric,
  match_score  integer,
  common_count integer
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  members as (
    select f.followee_id as member,
           round(score_for(r.bucket, (r.position - bb.lo + 1)::integer, bb.size), 1) as their_score
      from follows f
      join me on f.follower_id = me.id
      join rankings r on r.user_id = f.followee_id
                     and r.media_item_id = p_media_item_id
      join lateral band_bounds(r.user_id, r.category, r.bucket) bb on true
     where f.state = 'approved'
       and can_view_profile(me.id, f.followee_id)
  )
  select m.member,
         p.username::text,
         p.display_name,
         p.avatar_path,
         m.their_score,
         tm.score,
         tm.common_count
    from members m
    join profiles p on p.id = m.member
    join lateral taste_match(m.member) tm on true
   order by tm.score desc nulls last, m.their_score desc, p.username, m.member
   -- Bounded before the arithmetic, like every list here. Fifty followed accounts
   -- who all rated one title is beyond this population by an order of magnitude;
   -- the cap is a guard against the query becoming a catalogue scan, not a page.
   limit 50;
$$;

comment on function following_ratings(uuid) is
  'The rows behind following_score: each followed, viewable account that ranked this title, with their live derived score and taste_match''s verdict on the pair (null below taste.min_common — the client says Match TBD rather than inventing a number). Population predicate is following_score''s verbatim, which is rankings_read''s, so every row was already selectable one at a time and the list discloses nothing the aggregate had not. Ordered trustworthy-match first, then rating, then username; capped at 50.';

revoke execute on function following_ratings(uuid) from public, anon, authenticated;
grant  execute on function following_ratings(uuid) to authenticated;
